/**
 * 迈康 MyCare · 智能体上下文
 *
 * 统一持有：智能体注册表、服务状态、晨报、协同运行状态、各智能体对话历史。
 * 所有页面共用同一份状态，切换页面不会丢失协同过程与对话。
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useUser } from './UserContext'
import { useHealthData } from './HealthDataContext'
import * as api from '../services/agentApi'

const AgentContext = createContext(null)

export const useAgent = () => {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent 必须在 AgentProvider 内使用')
  return ctx
}

const initialRun = {
  status: 'idle', // idle | running | done | error
  runId: null,
  goal: '',
  engine: '',
  events: [], // 原始事件序列
  agents: {}, // agentId -> { status, thoughts[], result, durationMs, degraded }
  pipeline: [],
  order: [],
  alerts: [],
  reminders: [],
  summary: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  activeAgentId: null,
}

export const AgentProvider = ({ children }) => {
  const { user, voiceEnabled } = useUser()
  const { healthRecords, badges, refreshAlerts, noDatabaseProfile } = useHealthData()

  /**
   * 患者身份：patient_id 为唯一规范键。
   * 自定义注册用户不在示范库中（noDatabaseProfile=true）→ 不下发 patientId，
   * 避免后端按 patient_id 取数时 404；示范病例照常下发。
   */
  const patientId = user?.user_id || user?.patient_id || null
  const effectivePatientId = noDatabaseProfile ? null : patientId

  const [agents, setAgents] = useState([])
  const [pipeline, setPipeline] = useState([])
  const [status, setStatus] = useState({ online: false, modelConfigured: false, model: 'unknown' })
  const [briefing, setBriefing] = useState(null)
  const [briefingLoading, setBriefingLoading] = useState(false)
  const [run, setRun] = useState(initialRun)
  const [chats, setChats] = useState({})
  const [orbOpen, setOrbOpen] = useState(false)

  const abortRef = useRef(null)

  /* --------------------------- 健康数据快照 --------------------------- */
  const agentContext = useMemo(
    () => ({
      user: user || {},
      records: healthRecords || [],
      badges: badges || [],
    }),
    [user, healthRecords, badges],
  )

  /* ---------------------------- 初始化 ---------------------------- */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [st, reg] = await Promise.all([
        api.ping(),
        api.getAgents().catch(() => null),
      ])
      if (cancelled) return
      setStatus(
        st
          ? { online: true, modelConfigured: st.modelConfigured, model: st.model, visionConfigured: st.visionConfigured }
          : { online: false, modelConfigured: false, model: 'offline' },
      )
      if (reg) {
        setAgents(reg.agents || [])
        setPipeline(reg.pipeline || [])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* ---------------------------- 语音播报 ---------------------------- */
  const speak = useCallback(
    (text) => {
      if (!voiceEnabled || !text || !('speechSynthesis' in window)) return
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(String(text))
      utterance.lang = 'zh-CN'
      utterance.rate = 0.85
      utterance.pitch = 1
      utterance.volume = 0.9
      window.speechSynthesis.speak(utterance)
    },
    [voiceEnabled],
  )

  /* ---------------- 身份切换：清空上一位患者的内存态 ---------------- */
  // briefing / 协同轨迹 / 对话都是「针对当前患者」的派生内存态，不属于任何持久层。
  // 换账号（或退出登录）时必须清空，否则新账号会继续显示上一位患者（示范病例）的晨报与协同结果，
  // 表现为「注册后进去看到的还是别人的数据」。
  useEffect(() => {
    setBriefing(null)
    setRun(initialRun)
    setChats({})
    setOrbOpen(false)
  }, [patientId])

  /* ---------------------------- 晨报 ---------------------------- */
  const refreshBriefing = useCallback(async () => {
    // 只上传 patient_id；后端经 dataProvider 自取记录 / 档案
    if (!effectivePatientId) return null
    if (!agentContext.records.length && !agentContext.user?.age) return null
    setBriefingLoading(true)
    try {
      const data = await api.getBriefing(effectivePatientId)
      setBriefing(data)
      return data
    } catch (err) {
      console.warn('晨报获取失败：', err.message)
      return null
    } finally {
      setBriefingLoading(false)
    }
  }, [agentContext, effectivePatientId])

  // 依赖整份 records（而非仅长度）：同一天重复录入走 UPSERT、行数不变，
  // 但数据已变化，晨报必须重算；此外患者切换时 records 引用也会变，保证晨报跟着人走。
  useEffect(() => {
    if (!effectivePatientId) return
    if (!agentContext.records.length) return
    refreshBriefing()
  }, [effectivePatientId, agentContext.records, refreshBriefing])

  /* ------------------------- 多智能体协同 ------------------------- */
  const stopRun = useCallback(() => {
    if (abortRef.current) {
      abortRef.current()
      abortRef.current = null
    }
    setRun((prev) => (prev.status === 'running' ? { ...prev, status: 'idle' } : prev))
  }, [])

  const startRun = useCallback(
    (goal = '生成今日健康简报') => {
      // 无数据库档案（自定义注册用户）→ 明确提示，不回落示范患者数据
      if (!effectivePatientId) {
        setRun({
          ...initialRun,
          status: 'error',
          error: '当前账号没有数据库档案，智能体协同暂不可用（可使用示范病例体验）。',
        })
        return
      }
      if (abortRef.current) abortRef.current()

      setRun({ ...initialRun, status: 'running', goal, startedAt: Date.now() })

      // 只上传 { patientId, goal }；后端完成确定性规则落库后回发 alerts_persisted
      abortRef.current = api.runOrchestration(
        { patientId: effectivePatientId, goal },
        {
          onEvent: (event) => {
            setRun((prev) => reduceEvent(prev, event))
            if (event.type === 'alerts_persisted') refreshAlerts()
          },
          onError: (err) => {
            setRun((prev) => ({ ...prev, status: 'error', error: err.message }))
          },
          onClose: () => {
            setRun((prev) => (prev.status === 'running' ? { ...prev, status: 'done' } : prev))
            refreshAlerts()
          },
        },
      )
    },
    [effectivePatientId, refreshAlerts],
  )

  /* ---------------------------- 对话 ---------------------------- */
  const appendChat = useCallback((agentId, message) => {
    setChats((prev) => ({
      ...prev,
      [agentId]: [...(prev[agentId] || []), message],
    }))
  }, [])

  const updateChatMessage = useCallback((agentId, messageId, updater) => {
    setChats((prev) => ({
      ...prev,
      [agentId]: (prev[agentId] || []).map((m) => (m.id === messageId ? updater(m) : m)),
    }))
  }, [])

  /**
   * 发送消息给指定智能体，返回 abort 函数
   */
  const sendMessage = useCallback(
    (agentId, text) => {
      const message = String(text || '').trim()
      if (!message) return () => {}

      const history = (chats[agentId] || []).slice(-10).map((m) => ({ role: m.role, content: m.content }))
      const userMsg = { id: `u_${Date.now()}`, role: 'user', content: message }
      const botId = `a_${Date.now()}`
      const botMsg = { id: botId, role: 'assistant', content: '', tools: [], streaming: true }

      setChats((prev) => ({
        ...prev,
        [agentId]: [...(prev[agentId] || []), userMsg, botMsg],
      }))

      return api.chatWithAgent(
        { agentId, message, history, patientId: effectivePatientId },
        {
          onEvent: (event) => {
            if (event.type === 'token') {
              updateChatMessage(agentId, botId, (m) => ({ ...m, content: m.content + event.text }))
            } else if (event.type === 'tool_call') {
              updateChatMessage(agentId, botId, (m) => ({
                ...m,
                tools: [...(m.tools || []), { name: event.name, args: event.args, result: event.result }],
              }))
            } else if (event.type === 'task_proposal') {
              // Step 11 · Phase 2：提案只写 is_active=0 的待审行 → **患者端任务零变化**，
              // 此处只把「已提交医生审核」回执挂到本条回复上，供 ChatPanel 渲染卡片。
              updateChatMessage(agentId, botId, (m) => ({ ...m, proposal: event }))
            } else if (event.type === 'error') {
              updateChatMessage(agentId, botId, (m) => ({
                ...m,
                content: m.content || `抱歉，出了点问题：${event.message}`,
                streaming: false,
                error: true,
              }))
            }
          },
          onError: (err) => {
            updateChatMessage(agentId, botId, (m) => ({
              ...m,
              content: m.content || `连接智能体服务失败：${err.message}`,
              streaming: false,
              error: true,
            }))
          },
          onClose: () => {
            updateChatMessage(agentId, botId, (m) => ({ ...m, streaming: false }))
          },
        },
      )
    },
    [chats, effectivePatientId, updateChatMessage],
  )

  const clearChat = useCallback((agentId) => {
    setChats((prev) => ({ ...prev, [agentId]: [] }))
  }, [])

  const value = {
    // 注册表 / 状态
    agents,
    pipeline,
    status,
    // 晨报
    briefing,
    briefingLoading,
    refreshBriefing,
    // 协同
    run,
    startRun,
    stopRun,
    // 对话
    chats,
    sendMessage,
    appendChat,
    clearChat,
    // 语音 / 浮球
    speak,
    orbOpen,
    setOrbOpen,
    // 快照
    agentContext,
  }

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

/* ---------------------- 事件 → 状态归约 ---------------------- */
function reduceEvent(prev, event) {
  const events = [...prev.events, event]

  switch (event.type) {
    case 'run_start':
      return {
        ...prev,
        events,
        runId: event.runId,
        goal: event.goal,
        engine: event.model,
        pipeline: event.pipeline || prev.pipeline,
        order: (event.pipeline || []).map((p) => p.id),
      }

    case 'agent_start':
      return {
        ...prev,
        events,
        activeAgentId: event.agentId,
        agents: {
          ...prev.agents,
          [event.agentId]: {
            id: event.agentId,
            name: event.name,
            role: event.role,
            icon: event.icon,
            color: event.color,
            dependsOn: event.dependsOn || [],
            status: 'running',
            thoughts: [],
            result: null,
            durationMs: null,
            degraded: false,
          },
        },
        order: prev.order.includes(event.agentId) ? prev.order : [...prev.order, event.agentId],
      }

    case 'agent_thought':
      return {
        ...prev,
        events,
        agents: patchAgent(prev.agents, event.agentId, (a) => ({
          ...a,
          thoughts: [...a.thoughts, event.text],
        })),
      }

    case 'tool_call':
      return {
        ...prev,
        events,
        agents: patchAgent(prev.agents, event.agentId, (a) => ({
          ...a,
          toolCalls: [...(a.toolCalls || []), { name: event.name, args: event.args, result: event.result }],
        })),
      }

    case 'agent_result':
      return {
        ...prev,
        events,
        agents: patchAgent(prev.agents, event.agentId, (a) => ({
          ...a,
          status: 'done',
          result: event.data,
          durationMs: event.durationMs,
          degraded: Boolean(event.degraded),
        })),
        activeAgentId: null,
      }

    case 'agent_done':
      return { ...prev, events, activeAgentId: null }

    case 'handoff':
      return { ...prev, events, lastHandoff: event }

    case 'run_done':
      return {
        ...prev,
        events,
        status: 'done',
        summary: event.summary,
        alerts: event.alerts || [],
        reminders: event.reminders || [],
        engine: event.model || prev.engine,
        finishedAt: Date.now(),
        activeAgentId: null,
      }

    case 'error':
      return { ...prev, events, status: 'error', error: event.message }

    default:
      return { ...prev, events }
  }
}

function patchAgent(agents, agentId, updater) {
  const current = agents[agentId]
  if (!current) return agents
  return { ...agents, [agentId]: updater(current) }
}
