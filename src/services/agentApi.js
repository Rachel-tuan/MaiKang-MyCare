/**
 * 迈康 MyCare · 前端智能体 API 客户端
 *
 * 所有请求都走 /api 前缀（开发环境由 Vite 代理到 Express），
 * 前端永远不接触任何 API Key。
 */

const BASE = '/api'

/** 统一的 fetch 包装 */
async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const data = await res.json()
      if (data?.error) message = data.error
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return res.json()
}

export const getStatus = () => request('/status')
export const getAgents = () => request('/agents')

/**
 * 晨报：只上传 patient_id，后端经 dataProvider 自取记录 / 档案。
 * 前端**不再**回传 records / profile / badges。
 */
export const getBriefing = (patientId) => request('/agent/briefing', { method: 'POST', body: { patientId } })

export const readImage = (payload) => request('/vision/read', { method: 'POST', body: payload })

/**
 * 通用 SSE 消费器（POST + ReadableStream）
 * @param {string}   path
 * @param {object}   body
 * @param {object}   handlers  { onEvent, onError, onClose }
 * @returns {Function} abort 取消函数
 */
export function streamSSE(path, body, { onEvent, onError, onClose } = {}) {
  const controller = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        throw new Error(`流式请求失败（${res.status}）`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''

        for (const block of blocks) {
          for (const line of block.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (!payload) continue
            try {
              onEvent?.(JSON.parse(payload))
            } catch {
              /* 忽略无法解析的分片 */
            }
          }
        }
      }
      onClose?.()
    } catch (err) {
      if (err.name === 'AbortError') {
        onClose?.()
        return
      }
      onError?.(err)
    }
  })()

  return () => controller.abort()
}

/**
 * 触发完整多智能体协同。
 * 只上传 { patientId, goal } —— 上下文由后端 patient_id → dataProvider → SQLite 装配，
 * 运行结束后后端把确定性规则命中落库到 alerts。
 */
export function runOrchestration({ patientId, goal }, handlers) {
  return streamSSE('/agent/orchestrate', { patientId, goal }, handlers)
}

/** 与指定智能体对话（同样只上传 patientId） */
export function chatWithAgent({ agentId, message, history, patientId }, handlers) {
  return streamSSE('/agent/chat', { agentId, message, history, patientId }, handlers)
}

/**
 * 健康方案协商：**六个智能体协同**产出个性化健康建议。
 * ------------------------------------------------------------------
 * 与 runOrchestration 的区别是拓扑不同：这里六个智能体全部参与
 * （体征盘点 → 用药与化验解读 → 风险与禁忌 → 个性化方案 → 坚持策略 → 汇总成文），
 * 成品在 `run_done` 事件的 `carePlan` 字段里带回，同时保留每个智能体的原始产出。
 * 只上传 patientId；后端不落库、不改今日任务、不改任何医学阈值。
 */
export function runCarePlan({ patientId, goal }, handlers) {
  return streamSSE('/agent/care-plan', { patientId, goal }, handlers)
}

/** 探测后端是否在线 */
export async function ping() {
  try {
    return await getStatus()
  } catch {
    return null
  }
}
