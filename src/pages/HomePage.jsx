import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Card, Row, Col, Progress, Button, Typography, Space, Avatar, Statistic, Badge, Tag, Skeleton, Alert, Modal, message } from 'antd'
import {
  HeartOutlined,
  FireOutlined,
  TrophyOutlined,
  CalendarOutlined,
  SoundOutlined,
  RightOutlined,
  UserOutlined,
  ExperimentOutlined,
  ThunderboltFilled,
  PlayCircleFilled,
  RobotOutlined,
  AlertOutlined,
  FormOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'
import { useUser } from '../contexts/UserContext'
import { useHealthData } from '../contexts/HealthDataContext'
import { useAgent } from '../contexts/AgentContext'
import { generateAiScore, getProfile } from '../services/patientApi'
import ProfileSetupModal from '../components/Patient/ProfileSetupModal'
import { AI_STATUS, AI_STATUS_TEXT } from '../utils/aiScore'

const { Title, Text } = Typography

/** 产品预警等级 → 展示色（提示 / 关注 / 预警 / 紧急） */
const LEVEL_COLOR = { 提示: 'blue', 关注: 'gold', 预警: 'orange', 紧急: 'red' }

const HomeContainer = styled.div`
  padding: 0;
  max-width: 1200px;
  margin: 0 auto;
`

const WelcomeCard = styled(Card)`
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  border: none;
  border-radius: 20px;
  margin-bottom: 24px;
  color: white;
  
  .ant-card-body {
    padding: 32px;
  }
  
  .welcome-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    
    @media (max-width: 768px) {
      flex-direction: column;
      text-align: center;
      gap: 16px;
    }
  }
  
  .welcome-text h2 {
    color: white;
    margin-bottom: 8px;
    font-size: 28px;
  }
  
  .welcome-text p {
    color: rgba(255, 255, 255, 0.9);
    font-size: 16px;
    margin: 0;
  }
  
  .welcome-avatar {
    background: rgba(255, 255, 255, 0.2);
    border: 3px solid rgba(255, 255, 255, 0.3);
  }
`

const HealthScoreCard = styled(Card)`
  text-align: center;
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  
  .health-score {
    font-size: 48px;
    font-weight: bold;
    color: #6366f1;
    margin: 16px 0;
  }
  
  .score-description {
    color: #6b7280;
    font-size: 14px;
  }

  /* 档位 + 「规则评分」标签同一行（标签**不得**进 .score-description，见 JSX 注释） */
  .score-line {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  /* 分项得分明细：让分数可解释（哪一项扣了分、哪一项没录入） */
  .score-breakdown {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px dashed #e5e7eb;
    text-align: left;
  }

  .score-breakdown-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12.5px;
    color: #6b7280;
    line-height: 1.95;
  }

  .score-breakdown-label {
    color: #374151;
  }

  .score-breakdown-value {
    font-variant-numeric: tabular-nums;
  }

  .score-breakdown-row.is-missing .score-breakdown-label,
  .score-breakdown-row.is-missing .score-breakdown-value {
    color: #d97706;
  }

  .score-breakdown-foot {
    margin-top: 8px;
    font-size: 11.5px;
    line-height: 1.6;
    color: #9ca3af;
  }

  /* AI 辅助分区块：与主数字**明确区分**，不抢主视觉 */
  .ai-score-block {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: #f8f7ff;
    border: 1px solid #ede9fe;
    text-align: left;
  }

  .ai-score-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .ai-score-title {
    font-size: 12px;
    color: #6b7280;
  }

  .ai-score-value {
    font-size: 20px;
    font-weight: 700;
    color: #7c3aed;
    font-variant-numeric: tabular-nums;
  }

  .ai-score-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 11.5px;
    color: #4b5563;
    line-height: 1.7;
    margin-top: 4px;
  }

  .ai-score-row .ai-delta {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    flex: none;
  }

  .ai-score-row .ai-delta.up {
    color: #16a34a;
  }

  .ai-score-row .ai-delta.down {
    color: #dc2626;
  }

  .ai-score-row .ai-dim {
    flex: none;
    color: #6b7280;
  }

  .ai-score-row .ai-reason {
    flex: 1 1 auto;
    min-width: 0;
  }

  .ai-score-base {
    margin-top: 8px;
    font-size: 11.5px;
    color: #9ca3af;
    font-variant-numeric: tabular-nums;
  }

  .ai-score-note {
    margin-top: 6px;
    font-size: 11px;
    line-height: 1.6;
    color: #9ca3af;
  }

  .ai-score-status {
    margin-top: 10px;
    font-size: 11.5px;
    color: #9ca3af;
    text-align: left;
  }
`

const TaskCard = styled(Card)`
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  transition: all 0.3s ease;
  cursor: pointer;

  &:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
  }
  
  .task-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  
  .task-icon {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    color: white;
  }
  
  .task-progress {
    margin: 16px 0;
  }

  /* 卡片可点击 → 直接进入对应录入项；默认淡显，悬停时加强 */
  .task-action {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-top: 8px;
    font-size: 12px;
    font-weight: 600;
    color: #6366f1;
    opacity: 0.7;
    transition: opacity 0.2s ease;
  }

  &:hover .task-action {
    opacity: 1;
  }
`

const QuickActionCard = styled(Card)`
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  cursor: pointer;
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 25px rgba(0, 0, 0, 0.15);
  }
  
  .action-content {
    text-align: center;
    padding: 16px 0;
  }
  
  .action-icon {
    width: 64px;
    height: 64px;
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    color: white;
    margin: 0 auto 16px;
  }
`

const AgentBriefCard = styled(Card)`
  border-radius: 20px;
  margin-bottom: 24px;
  border: 1px solid #e9e6ff;
  box-shadow: 0 6px 24px rgba(99, 102, 241, 0.08);

  .agent-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .agent-avatar {
    width: 44px;
    height: 44px;
    border-radius: 14px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    flex-shrink: 0;
  }

  .action-line {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: #f8fafc;
    margin-bottom: 8px;
    font-size: 14.5px;
  }
`

const VoiceButton = styled(Button)`
  position: fixed;
  bottom: 100px;
  right: 24px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #3b82f6;
  border: none;
  color: white;
  font-size: 20px;
  box-shadow: 0 4px 20px rgba(59, 130, 246, 0.4);
  z-index: 1000;
  
  &:hover {
    background: #2563eb;
    transform: scale(1.1);
  }
  
  @media (max-width: 768px) {
    bottom: 120px;
    right: 16px;
  }
`

/** 本会话内已提示过建档的 patientId（仅存在于内存，不落任何 Storage） */
const promptedProfileSetup = new Set()

const HomePage = ({ onPageLoad }) => {
  const navigate = useNavigate()
  const { user, voiceEnabled, updateUser } = useUser()
  const { healthRecords, getTodayData, getHealthScoreDetail, badges, getActivePrescription, getConsecutiveDays, alerts, dailyTasks, logMedication } =
    useHealthData()
  const {
    briefing,
    briefingLoading,
    startRun,
    run,
    status: agentStatus,
    speak: agentSpeak,
    refreshBriefing
  } = useAgent()
  const [todayData, setTodayData] = useState(null)
  const [speaking, setSpeaking] = useState(false)
  /**
   * AI 评分三分层（Step 11 · Phase 3）—— **独立的展示态，不参与任何派生计算**。
   * 关键：`healthScore` 永远是本地 Rule Score；`aiScore.ai.assisted` 只是一个
   * 「规则分之外还看到了什么」的辅助显示项，**不得**回灌进任何规则判定。
   */
  const [aiScore, setAiScore] = useState(null)
  const [aiScoreLoading, setAiScoreLoading] = useState(false)
  const [aiScoreError, setAiScoreError] = useState(null)

  /**
   * 建档引导（「从 0 到 1」闭环）。
   * ---------------------------------------------------------------------------
   * 注册只把**最小身份信息**写进 patients；其余四类档案
   * （紧急联系人 / 疾病分级与危险分层 / 生活画像 / 控制目标与用药）仍为空 ——
   * 医生端「患者详情」因此没有内容可展示，智能体的个性化建议也失去依据。
   *
   * 这里只在**档案确实不完整**时提示：示范病例的档案本身完整，不会被打扰。
   * 提示记录放在**模块级 Set**（不落任何 Storage）——同一会话内切换页面不重复弹窗，
   * 刷新页面或重新登录才再提醒一次；用户点「稍后再填」后顶部引导卡仍在。
   */
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [profileRaw, setProfileRaw] = useState(null)
  const patientIdForProfile = user?.user_id || user?.patient_id || null

  /**
   * 「档案是否还不完整」判定 —— 一律以**刚从后端取回的档案**为准。
   * ---------------------------------------------------------------------------
   * 反面教材（本版修复）：只看 `user`（登录时写进 localStorage 的登录快照）。
   * 建档弹窗保存后只刷新了 `profileRaw`，`user` 仍是旧的 → 判断永远为「不完整」，
   * 于是**明明已经填过档案，引导卡与弹窗还是一次次冒出来**。
   * 现在：有 `profileRaw` 就用它（保存后立即变新，卡片随之消失），
   * 取不到档案时才退回登录快照。
   */
  const profileIncomplete = useMemo(() => {
    if (!user) return false
    const fresh = profileRaw && profileRaw.identity ? profileRaw : null
    const contact = fresh ? fresh.derived?.emergencyContact : user.emergencyContact
    const lf = (fresh ? fresh.lifestyle : user.lifestyle) || {}
    const hasLifestyle = Boolean(lf.diet || lf.exercise || lf.sleep)
    return !contact || !hasLifestyle
  }, [user, profileRaw])

  const reloadProfile = () => {
    if (!patientIdForProfile) return
    getProfile(patientIdForProfile)
      .then((data) => setProfileRaw(data?.profile || null))
      .catch(() => {
        /* 档案读取失败不影响首页 */
      })
  }

  useEffect(() => {
    if (!patientIdForProfile) return undefined
    let cancelled = false
    getProfile(patientIdForProfile)
      .then((data) => {
        if (!cancelled) setProfileRaw(data?.profile || null)
      })
      .catch(() => {
        /* 档案读取失败不影响首页 */
      })
    return () => {
      cancelled = true
    }
  }, [patientIdForProfile])

  useEffect(() => {
    if (!profileIncomplete || !patientIdForProfile) return undefined
    if (promptedProfileSetup.has(patientIdForProfile)) return undefined
    /* ⚠️ 「已提示过」的标记必须放在**真正弹出之后**。
       React 18 严格模式会**故意双调用** effect（挂载 → 清理 → 再挂载）：
       若在这里就 add()，第一次的定时器会被清理掉，而第二次 effect 因 has() 已为 true
       直接 return —— 结果是**开发模式下弹窗永远不出现**（生产构建正常，因而极难发现）。
       放进定时器内：清理时只取消「还没执行」的那次，标记与打开同时发生。 */
    const t = setTimeout(() => {
      promptedProfileSetup.add(patientIdForProfile)
      setProfileModalOpen(true)
    }, 800)
    return () => clearTimeout(t)
  }, [profileIncomplete, patientIdForProfile])

  /**
   * 今日健康评分 + 分项依据（确定性计算，不落库）
   * ---------------------------------------------------------------------
   * 权重与口径唯一实现在 src/utils/healthScore.js，与服务端智能体工具同源，
   * 保证界面分数与智能体口播一致。用 useMemo 派生而非 useState，
   * 避免「每次渲染都产生新对象 → setState → 再渲染」的死循环。
   */
  const scoreDetail = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => getHealthScoreDetail(),
    [healthRecords, user]
  )
  const healthScore = scoreDetail.score

  useEffect(() => {
    if (onPageLoad) {
      onPageLoad()
    }

    // 加载今日数据
    const data = getTodayData()
    setTodayData(data)
  }, [onPageLoad, getTodayData])

  /**
   * 拉取「Rule Score + AI 辅助分」。
   * ---------------------------------------------------------------------------
   * 后端按 `patientId + 日期 + inputHash` 做**当日进程内缓存**：
   *   · 首次调用会请一次模型；同日同数据再次调用直接返回缓存（不会重复花钱）；
   *   · 体征一变 `inputHash` 就变，缓存自然失效并重新生成。
   *
   * 失败**绝不影响页面**：拿不到 AI 意见时只显示 Rule Score
   * （接口本身也不会因模型不可用而报错，这里兜的是网络层）。
   */
  useEffect(() => {
    const patientId = user?.user_id || user?.patient_id || null
    if (!patientId) return undefined

    let cancelled = false
    setAiScoreLoading(true)
    setAiScoreError(null)
    generateAiScore(patientId)
      .then((data) => {
        if (!cancelled) setAiScore(data)
      })
      .catch((err) => {
        if (cancelled) return
        setAiScore(null)
        setAiScoreError(err?.message || 'AI 解读暂不可用')
      })
      .finally(() => {
        if (!cancelled) setAiScoreLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [user, healthRecords])

  // 语音播报功能
  const speakText = (text) => {
    if (!voiceEnabled || !('speechSynthesis' in window)) return

    setSpeaking(true)
    window.speechSynthesis.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.rate = 0.8
    utterance.onend = () => setSpeaking(false)

    window.speechSynthesis.speak(utterance)
  }

  // 播报今日总结
  const speakDailySummary = () => {
    const summary = generateDailySummary()
    speakText(summary)
  }

  // 生成今日总结
  const generateDailySummary = () => {
    if (!todayData) {
      return `${user?.name || '用户'}，您好！今天还没有记录健康数据，建议您及时记录步数、血压等健康指标。`
    }

    const { steps, systolic_pressure, diastolic_pressure, exercise_minutes } = todayData
    let summary = `${user?.name || '用户'}，您好！`

    if (steps) {
      summary += `今天您已经走了${steps}步，`
      if (steps >= 8000) {
        summary += '达到了推荐标准，非常棒！'
      } else {
        summary += `距离8000步目标还差${8000 - steps}步。`
      }
    }

    if (systolic_pressure && diastolic_pressure) {
      summary += `血压为${systolic_pressure}/${diastolic_pressure}，`
      if (systolic_pressure <= 140 && diastolic_pressure <= 90) {
        summary += '在正常范围内。'
      } else {
        summary += '需要注意控制。'
      }
    }

    summary += `今日健康评分${healthScore}分。`

    return summary
  }

  /* -------------------------------------------------------------------------
   * 今日任务（Step 9）
   * -------------------------------------------------------------------------
   * 频次与时段由后端确定性规则生成（src/utils/dailyTasks.js → /daily-tasks），
   * 进度由当天有效 readings / medication_logs 实时派生 —— 这里**只做展示映射**，
   * 前端不参与任务次数、时段与阈值判定，AI 亦无权修改次数。
   * 图标/配色是纯视觉映射，与医学规则无关。
   */
  const TASK_STYLE = {
    blood_pressure: { icon: '❤️', color: '#ef4444' },
    blood_glucose: { icon: '🩸', color: '#8b5cf6' },
    weight: { icon: '⚖️', color: '#0ea5e9' },
    medication: { icon: '💊', color: '#14b8a6' },
    exercise: { icon: '🏃‍♂️', color: '#f59e0b' },
    steps: { icon: '🚶‍♂️', color: '#10b981' },
  }

  /**
   * 任务 → 录入入口映射（纯导航，不含任何医学判定）。
   * 点击卡片即跳到「数据记录」页的对应输入框并自动聚焦；
   * 服药任务例外 —— 服药不是数值录入而是「已服」事件，故在原地打卡。
   */
  const TASK_ACTION = {
    blood_pressure: { focus: 'systolic', label: '去记录血压' },
    blood_glucose: { focus: 'bloodSugar', label: '去记录血糖' },
    weight: { focus: 'weight', label: '去记录体重' },
    exercise: { focus: 'exerciseMinutes', label: '去记录运动时长' },
    steps: { focus: 'steps', label: '去记录步数' },
    medication: { focus: null, label: '点击打卡' },
  }

  const todayTasks = (dailyTasks?.tasks || []).map((task) => {
    const action = TASK_ACTION[task.domain] || {}
    return {
      ...task,
      // 渲染层沿用 current/target 命名
      current: task.done ?? 0,
      // current(=done) 是「计入进度条的封顶值」：步数实走 12222 / 目标 8000 时它只有 8000。
      // 界面必须展示**真实累计值**，故额外带上后端原样返回、未截断的 actualCount。
      actual: task.actualCount ?? task.done ?? 0,
      icon: TASK_STYLE[task.domain]?.icon || '🎯',
      color: TASK_STYLE[task.domain]?.color || '#6366f1',
      focus: action.focus ?? null,
      actionLabel: action.label || '',
    }
  })

  /** 点击今日任务卡片：服药 → 原地打卡；其余 → 跳到录入页并聚焦对应输入框 */
  const handleTaskClick = (task) => {
    if (task.domain === 'medication') {
      if (task.current >= task.target) {
        message.info('该时段已打卡')
        return
      }
      Modal.confirm({
        title: '确认服药打卡',
        content: `${task.title}（计划时段 ${task.plannedTime}）—— 确认已服用？`,
        okText: '已服用',
        cancelText: '取消',
        onOk: async () => {
          try {
            await logMedication({ medicationId: task.medicationId, plannedTime: task.plannedTime })
            message.success('已打卡')
          } catch (error) {
            message.error(`打卡失败：${error.message || '请重试'}`)
          }
        },
      })
      return
    }
    if (!task.focus) return
    navigate(`/data-record?focus=${task.focus}`)
  }

  // 快捷操作
  const quickActions = [
    {
      title: '智能体中心',
      icon: '🧬',
      color: '#8b5cf6',
      path: '/agents'
    },
    {
      title: '生成建议',
      icon: '📋',
      color: '#6366f1',
      path: '/prescription'
    },
    {
      title: '记录数据',
      icon: '📊',
      color: '#10b981',
      path: '/data-record'
    },
    {
      title: '查看勋章',
      icon: '🏆',
      color: '#f59e0b',
      path: '/badges'
    },
    {
      title: '医生建议',
      icon: '👨‍⚕️',
      color: '#ef4444',
      path: '/doctor'
    }
  ]

  return (
    <HomeContainer>
      {/* 欢迎卡片 */}
      <WelcomeCard>
        <div className="welcome-content">
          <div className="welcome-text">
            <Title level={2}>欢迎回来，{user?.name || '用户'}！</Title>
            <Text>今天是{new Date().toLocaleDateString('zh-CN', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              weekday: 'long'
            })}</Text>
          </div>
          <Avatar
            size={80}
            icon={<UserOutlined />}
            className="welcome-avatar"
          />
        </div>
      </WelcomeCard>

      {/* 完善档案引导：**只有档案确实不完整时**才显示（判定见 profileIncomplete）。
          已填过档案的账号不得再看到它 —— 后续要改请走「我的 → 我的健康档案」。 */}
      {profileIncomplete && (
        <Card
          data-testid="profile-guide-card"
          style={{
            marginBottom: 24,
            borderRadius: 16,
            border: '1px solid #c7d2fe',
            background: 'linear-gradient(135deg, #eef2ff 0%, #faf5ff 100%)'
          }}
          styles={{ body: { padding: 18 } }}
        >
          <Row align="middle" gutter={[16, 12]}>
            <Col flex="auto">
              <Space align="start" size={12}>
                <FormOutlined style={{ fontSize: 22, color: '#6366f1', marginTop: 3 }} />
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>还差一步：把健康档案补充完整</div>
                  <Text type="secondary" style={{ fontSize: 13.5 }}>
                    目前只有注册时填的姓名 / 年龄 / 身高 / 疾病。补上
                    <Text strong>紧急联系人、诊断分级与危险分层、生活画像、控制目标、用药计划</Text>
                    之后，医生端「患者详情」才能看到完整信息，智能体给出的运动 / 饮食 / 用药建议也才会贴合您本人。
                  </Text>
                </div>
              </Space>
            </Col>
            <Col>
              <Button
                type="primary"
                size="large"
                icon={<FormOutlined />}
                onClick={() => setProfileModalOpen(true)}
                style={{ background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)', border: 'none' }}
              >
                完善我的档案
              </Button>
            </Col>
          </Row>
        </Card>
      )}

      {/* 空白档案引导：新注册账号尚无任何体征记录时，说明数据由本人录入产生 */}
      {!healthRecords.some((r) => r.systolic_pressure || r.blood_sugar || r.steps || r.exercise_minutes) && (
        <Card
          title={
            <Space>
              <ExperimentOutlined style={{ color: '#6366f1' }} />
              <span>你的健康档案已建立，现在从第一条数据开始</span>
            </Space>
          }
          style={{ marginBottom: 24, borderRadius: 16 }}
        >
          <Text type="secondary" style={{ fontSize: 13.5 }}>
            数据库中已经有属于你的患者档案（<Text code>{user?.user_id}</Text>），
            目前只有注册时填写的体重；血压、血糖、步数等指标还是空的 ——
            下面的评分、趋势与预警都会随着你录入的数据实时产生，不是预置的示例。
          </Text>
          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            {[
              { step: '①', title: '录入一条数据', desc: '血压、血糖、体重或步数，任选其一' },
              { step: '②', title: '规则引擎即时判定', desc: '13 条确定性规则按 7 天窗口现算，不猜不缓存' },
              { step: '③', title: '预警落库并同步医生端', desc: '命中结果写入 alerts 表，医生端随之出现你的记录' },
            ].map((it) => (
              <Col xs={24} md={8} key={it.step}>
                <div style={{ padding: 14, borderRadius: 12, background: '#f8fafc', height: '100%' }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#6366f1' }}>
                    {it.step} {it.title}
                  </div>
                  <Text type="secondary" style={{ fontSize: 12.5 }}>
                    {it.desc}
                  </Text>
                </div>
              </Col>
            ))}
          </Row>
          <Button
            type="primary"
            style={{ marginTop: 16 }}
            icon={<RightOutlined />}
            onClick={() => navigate('/data-record')}
          >
            去记录第一条数据
          </Button>
        </Card>
      )}

      {/* 今日任务 */}
      <Card
        title="今日任务"
        style={{ marginBottom: '24px', borderRadius: '16px' }}
        extra={
          <Button
            type="link"
            onClick={() => navigate('/data-record')}
            icon={<RightOutlined />}
          >
            查看详情
          </Button>
        }
      >
        {todayTasks.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 13.5 }}>
            暂无今日任务。今日任务由患者疾病谱与近期健康状态**动态生成**：高血压 → 血压监测、
            糖尿病 → 血糖监测、肥胖症 → 体重管理，并按当前预警等级自动调整每日监测次数。
          </Text>
        ) : (
          <Row gutter={[16, 16]}>
            {todayTasks.map((task) => (
              <Col xs={24} sm={12} md={6} key={task.taskId}>
                {/* ⚠️ 不要给 Card 传 title：antd Card 的 title 是「卡片标题」而不是 HTML tooltip，
                    会额外渲染一行重复文案。可点击提示只用底部 .task-action。 */}
                <TaskCard size="small" onClick={() => handleTaskClick(task)}>
                  <div className="task-header">
                    <div>
                      <div className="task-icon" style={{ background: task.color }}>
                        {task.icon}
                      </div>
                    </div>
                    <Badge
                      count={task.current >= task.target ? '✓' : ''}
                      style={{ backgroundColor: '#52c41a' }}
                    />
                  </div>
                  <div>
                    <Text strong>{task.title}</Text>
                    {task.addedByDoctor && (
                      <Tag color="purple" style={{ marginLeft: 8, marginInlineEnd: 0 }}>
                        医生新增
                      </Tag>
                    )}
                    <div className="task-progress">
                      <Progress
                        percent={Math.min((task.current / task.target) * 100, 100)}
                        strokeColor={task.color}
                        size="small"
                      />
                      <Text type="secondary">
                        {(Number(task.actual) || 0).toLocaleString('zh-CN')}/
                        {(Number(task.target) || 0).toLocaleString('zh-CN')} {task.unit}
                      </Text>
                    </div>
                    {Array.isArray(task.slots) && task.slots.length > 0 && (
                      <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                        {task.slots.map((s) => (
                          <Text
                            key={`${task.taskId}-${s.label}`}
                            style={{ fontSize: 12 }}
                            type={s.done ? undefined : 'secondary'}
                          >
                            {s.done ? '✓' : '○'} {s.label}
                            {s.latest ? ` ${s.latest}` : ''}
                          </Text>
                        ))}
                      </div>
                    )}
                    {task.reason && (
                      <Text type="secondary" style={{ fontSize: 11.5, display: 'block', marginTop: 4 }}>
                        {task.reason}
                      </Text>
                    )}
                    {task.override?.applied && (
                      <div style={{ marginTop: 6 }}>
                        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                          医生已调整
                        </Tag>
                        {task.override.basis && (
                          <Text
                            type="secondary"
                            style={{ fontSize: 11.5, display: 'block', marginTop: 4 }}
                          >
                            依据：{task.override.basis}
                          </Text>
                        )}
                      </div>
                    )}
                    {task.actionLabel && (
                      <span className="task-action">
                        {task.actionLabel}
                        <RightOutlined style={{ fontSize: 10 }} />
                      </span>
                    )}
                  </div>
                </TaskCard>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      {/* 智能体晨报 */}
      <AgentBriefCard
        title={
          <div className="agent-head">
            <div className="agent-avatar">
              <RobotOutlined />
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>迈康智能体晨报</div>
              <Text type="secondary" style={{ fontSize: 12.5 }}>
                {agentStatus.online
                  ? agentStatus.modelConfigured
                    ? `由 ${run.agents?.steward ? '健康管家智能体' : '体征分析智能体'} 生成 · 大模型已接入`
                    : '由本地推理引擎生成 · 配置 API Key 后启用大模型'
                  : '智能体服务未启动'}
              </Text>
            </div>
          </div>
        }
        extra={
          <Space>
            <Button size="small" icon={<RightOutlined />} onClick={refreshBriefing} loading={briefingLoading}>
              刷新
            </Button>
            <Button type="primary" size="small" icon={<ExperimentOutlined />} onClick={() => navigate('/agents')}>
              进入智能体中心
            </Button>
          </Space>
        }
      >
        {briefingLoading && !briefing ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : briefing ? (
          <>
            <Row gutter={[16, 16]} align="middle">
              <Col xs={24} sm={8}>
                <Space align="center" size={16}>
                  <Progress
                    type="circle"
                    percent={briefing.score}
                    size={80}
                    strokeColor={{ '0%': '#6366f1', '100%': '#8b5cf6' }}
                    format={(p) => <span style={{ fontSize: 20, fontWeight: 700 }}>{p}</span>}
                  />
                  <div>
                    <Text type="secondary" style={{ fontSize: 12.5 }}>今日健康评分</Text>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#6366f1' }}>{briefing.grade}</div>
                  </div>
                </Space>
              </Col>

              <Col xs={24} sm={16}>
                <Space size={8} wrap style={{ marginBottom: 8 }}>
                  <Tag
                    // 与下方「当前健康预警」卡片共用同一套等级色（Step 11 · D-2：
                    // 晨报等级与落库预警同源，颜色也应一致，避免同屏看起来像两套系统）
                    color={LEVEL_COLOR[briefing.risk?.label] || 'default'}
                    style={{ fontWeight: 700 }}
                  >
                    风险等级：{briefing.risk?.label}
                  </Tag>
                  <Text strong style={{ fontSize: 15 }}>{briefing.headline}</Text>
                </Space>

                <div>
                  {(briefing.actions || []).map((a, i) => (
                    <div className="action-line" key={i}>
                      <ThunderboltFilled
                        style={{
                          color:
                            a.priority === 'high' ? '#ef4444' : a.priority === 'medium' ? '#f59e0b' : '#10b981'
                        }}
                      />
                      <span style={{ flex: 1 }}>{a.title}</span>
                      <Text type="secondary" style={{ fontSize: 12 }}>{a.detail}</Text>
                    </div>
                  ))}
                </div>
              </Col>
            </Row>

            <Space style={{ marginTop: 12 }} wrap>
              <Button
                type="primary"
                icon={<PlayCircleFilled />}
                loading={run.status === 'running'}
                onClick={() => {
                  startRun('生成今日健康简报与干预方案')
                  navigate('/agents')
                }}
              >
                一键启动多智能体协同
              </Button>
              <Button
                icon={<SoundOutlined />}
                onClick={() =>
                  agentSpeak(`${briefing.headline}。${(briefing.actions || []).map((a) => a.title).join('；')}`)
                }
              >
                朗读晨报
              </Button>
              {briefing.risk?.items?.length > 0 && (
                <Text type="secondary" style={{ fontSize: 12.5 }}>
                  检出 {briefing.risk.items.length} 项需关注指标
                </Text>
              )}
            </Space>

            {run.status === 'running' && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 12, borderRadius: 10 }}
                message="智能体正在协同推理，可点击右下角悬浮球查看过程"
              />
            )}
          </>
        ) : (
          <Alert
            type="info"
            showIcon
            style={{ borderRadius: 10 }}
            message="还没有体征数据"
            description="先到「数据记录」录入一次血压、血糖或步数，智能体就能为您生成健康晨报。"
            action={
              <Button size="small" type="primary" onClick={() => navigate('/data-record')}>
                去记录
              </Button>
            }
          />
        )}
      </AgentBriefCard>

      {/* 当前健康预警（来自后端 alerts 表：确定性规则命中后由智能体运行落库） */}
      {alerts.length > 0 && (
        <Card
          title={
            <Space>
              <AlertOutlined style={{ color: '#ef4444' }} />
              <span>当前健康预警</span>
            </Space>
          }
          extra={
            <Text type="secondary" style={{ fontSize: 12.5 }}>
              由确定性规则引擎判定并入库 · 共 {alerts.length} 条
            </Text>
          }
          style={{ marginBottom: 24, borderRadius: 16 }}
        >
          {alerts.slice(0, 5).map((a) => (
            <div
              key={a.alertId || a.id}
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                background: '#f8fafc',
                marginBottom: 8,
              }}
            >
              <Space size={8} wrap>
                <Tag color={LEVEL_COLOR[a.level] || 'default'} style={{ fontWeight: 700 }}>
                  {a.level}
                </Tag>
                {a.ruleId && <Tag>{a.ruleId}</Tag>}
                <Text strong>{a.title}</Text>
              </Space>
              {a.detail && (
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>{a.detail}</Text>
                </div>
              )}
              {a.action && (
                <div>
                  <Text type="secondary" style={{ fontSize: 13 }}>建议：{a.action}</Text>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      <Row gutter={[16, 16]}>
        {/* 健康评分 */}
        <Col xs={24} sm={12} md={8}>
          <HealthScoreCard title="今日健康评分">
            <div className="health-score">{healthScore}</div>
            <Progress
              percent={healthScore}
              strokeColor={{
                '0%': '#6366f1',
                '100%': '#8b5cf6',
              }}
              showInfo={false}
            />
            {/*
              ⚠️ `.score-description` **只能承载档位文案**（「优秀 / 良好 / 一般 / 需干预」）：
              `verify-health-score.mjs` 第 21 条用 `^…$` 精确匹配这个元素的 innerText，
              把标签塞进同一元素会让档位变成「一般规则评分」→ 断言失效。
              故标签移到同级容器 `.score-line` 里，视觉上仍是同一行。
            */}
            <div className="score-line">
              <span className="score-description">{scoreDetail.grade}</span>
              <Tag className="score-rule-badge" color="geekblue">
                规则评分
              </Tag>
            </div>

            {/*
              AI 辅助分（Step 11 · Phase 3）—— 次级显示项。
              红线：主数字恒为上面的 Rule Score；AI 只提供 adjustments，
              合成由后端确定性纯函数完成，且**不参与**预警 / 等级 / 达标率。
            */}
            {aiScore?.aiStatus === AI_STATUS.OK && aiScore?.ai && (
              <div className="ai-score-block">
                <div className="ai-score-head">
                  <span className="ai-score-title">
                    AI 辅助分
                    <Tag className="ai-score-badge" color="purple" style={{ marginLeft: 6 }}>
                      AI 辅助
                    </Tag>
                  </span>
                  <span className="ai-score-value">{aiScore.ai.assisted}</span>
                </div>

                {aiScore.ai.adjustments.map((a) => (
                  <div className="ai-score-row" key={a.dimension}>
                    <span className="ai-dim">{a.label || a.dimension}</span>
                    <span className={`ai-delta ${a.delta > 0 ? 'up' : a.delta < 0 ? 'down' : ''}`}>
                      {a.delta > 0 ? `+${a.delta}` : a.delta}
                    </span>
                    <span className="ai-reason">{a.reason}</span>
                  </div>
                ))}

                {aiScore.ai.adjustments.length === 0 && (
                  <div className="ai-score-row">
                    <span className="ai-reason">规则分已贴合当日数据，模型未提出调整</span>
                  </div>
                )}

                <div className="ai-score-base">
                  规则基线 {aiScore.rule} · AI 调整 {aiScore.ai.sumDelta > 0 ? `+${aiScore.ai.sumDelta}` : aiScore.ai.sumDelta}
                  {aiScore.ai.clamped ? `（原始 ${aiScore.ai.rawAssisted}，已截断到 0–100）` : ''}
                </div>

                <div className="ai-score-note">
                  ⓘ AI 辅助分由模型提出意见、确定性代码合成，不是临床判据，也不参与预警分级。
                </div>
              </div>
            )}

            {/*
              降级：AI 不可用 / 建议未通过校验 → **只显示 Rule Score**，不显示 AI 分。
              两种情况的文案由后端下发（唯一来源），避免前后端各写一套。
            */}
            {(!aiScore || aiScore.aiStatus !== AI_STATUS.OK) && (
              <div className="ai-score-status">
                {aiScore?.aiMessage ||
                  AI_STATUS_TEXT[aiScore?.aiStatus] ||
                  (aiScoreError ? AI_STATUS_TEXT.unavailable : aiScoreLoading ? 'AI 解读生成中…' : '')}
              </div>
            )}

            {/* 分项依据：哪一项拿了分、哪一项没录入，让分数可解释 */}
            {scoreDetail.breakdown.length > 0 && (
              <div className="score-breakdown">
                {scoreDetail.breakdown.map((item) => (
                  <div
                    key={item.key}
                    className={`score-breakdown-row${item.status === 'missing' ? ' is-missing' : ''}`}
                  >
                    <span className="score-breakdown-label">
                      {item.label}
                      {item.source === 'doctorOrder' && (
                        <Tag color="purple" style={{ marginLeft: 6, marginInlineEnd: 0, fontSize: 11 }}>
                          医生新增
                        </Tag>
                      )}
                      <Text type="secondary" style={{ fontSize: 11.5, marginLeft: 6 }}>
                        {item.detail}
                      </Text>
                    </span>
                    <span className="score-breakdown-value">
                      {Number.isInteger(item.earned) ? item.earned : item.earned.toFixed(1)}/{item.weight}
                    </span>
                  </div>
                ))}
                <div className="score-breakdown-foot">
                  {scoreDetail.missing.length > 0
                    ? `未录入：${scoreDetail.missing.join('、')}（按 0 分计入满分 ${scoreDetail.applicableWeight} 分）`
                    : `全部录入项已计分，满分 ${scoreDetail.applicableWeight} 分`}
                </div>
              </div>
            )}
          </HealthScoreCard>
        </Col>

        {/* 勋章统计 */}
        <Col xs={24} sm={12} md={8}>
          <Card title="我的成就" style={{ borderRadius: '16px', textAlign: 'center' }}>
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              <div>
                <TrophyOutlined style={{ fontSize: '48px', color: '#f59e0b' }} />
                <div style={{ marginTop: '8px' }}>
                  <Text strong style={{ fontSize: '24px' }}>{badges.length}</Text>
                  <div>
                    <Text type="secondary">获得勋章</Text>
                  </div>
                </div>
              </div>
              <Button
                type="primary"
                onClick={() => navigate('/badges')}
                icon={<RightOutlined />}
              >
                查看全部
              </Button>
            </Space>
          </Card>
        </Col>

        {/* 连续记录天数 */}
        <Col xs={24} sm={12} md={8}>
          <Card title="坚持记录" style={{ borderRadius: '16px', textAlign: 'center' }}>
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              <div>
                <CalendarOutlined style={{ fontSize: '48px', color: '#10b981' }} />
                <div style={{ marginTop: '8px' }}>
                  <Text strong style={{ fontSize: '24px' }}>{getConsecutiveDays()}</Text>
                  <div>
                    <Text type="secondary">连续天数</Text>
                  </div>
                </div>
              </div>
              <Button
                type="primary"
                onClick={() => navigate('/data-record')}
                icon={<RightOutlined />}
              >
                记录数据
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>

      {/* 快捷操作 */}
      <Card
        title="快捷操作"
        style={{ marginTop: '24px', borderRadius: '16px' }}
      >
        <Row gutter={[16, 16]}>
          {quickActions.map((action, index) => (
            <Col xs={12} sm={6} md={6} key={index}>
              <QuickActionCard
                size="small"
                onClick={() => navigate(action.path)}
              >
                <div className="action-content">
                  <div
                    className="action-icon"
                    style={{ background: action.color }}
                  >
                    {action.icon}
                  </div>
                  <Text strong>{action.title}</Text>
                </div>
              </QuickActionCard>
            </Col>
          ))}
        </Row>
      </Card>

      {/* 语音播报按钮 */}
      {voiceEnabled && (
        <VoiceButton
          shape="circle"
          icon={<SoundOutlined />}
          onClick={speakDailySummary}
          className={speaking ? 'speaking' : ''}
          title="播报今日总结"
        />
      )}

      {/* 完善健康档案（注册后的建档闭环；保存即落库，医生端随之可见） */}
      <ProfileSetupModal
        open={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        patientId={patientIdForProfile}
        profile={profileRaw}
        onSaved={(result) => {
          reloadProfile()
          /* 同时刷新登录快照：其他页面（我的 / 健康建议）读的是 `user`，
             不刷新则它们看到的仍是注册时的最小信息。只同步「紧急联系人 + 生活画像」
             这两个用于判断档案完整度的字段，不触碰任何体征数值。 */
          const view = result?.view || null
          if (view) {
            updateUser({
              emergencyContact: view.emergencyContact ?? null,
              emergency_contact: view.emergency_contact ?? null,
              lifestyle: view.lifestyle ?? null,
            })
          }
          message.success('档案已保存，可前往「我的 → 我的健康档案」随时修改')
        }}
      />
    </HomeContainer>
  )
}

export default HomePage