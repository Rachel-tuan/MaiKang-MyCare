/**
 * 迈康 MyCare · DeepSeek 统一适配层
 *
 * 所有对外的模型能力都收敛到这一层，上层（智能体编排器 / 对话）不感知具体厂商。
 * 换模型供应商时只需改这里，业务代码零改动。
 */
import { config, isModelConfigured } from './config.js'

export { isModelConfigured }

export class ModelError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ModelError'
    this.status = status
  }
}

/** 模型不可用（未配置 Key）且已禁用降级时抛出。HTTP 语义：503。 */
export class ModelUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ModelUnavailableError'
    this.status = 503
    this.code = 'E_MODEL_UNAVAILABLE'
  }
}

/**
 * 「模型不可用」时的统一降级裁决 —— 由 ALLOW_MOCK_FALLBACK 开关决定走向。
 *
 * · ALLOW_MOCK_FALLBACK=true（默认）：返回 'fallback'，调用方继续走本地推理引擎（mock），流程不中断。
 * · ALLOW_MOCK_FALLBACK=false       ：抛出 ModelUnavailableError。这是**刻意的排障开关** ——
 *   用来确认「Key 到底有没有被读到」：一旦没读到就直接报错，而不是安安静静地降级，
 *   避免出现「以为在调大模型、其实一直是本地模板」的错觉。
 *
 * @param {string} scene 场景名（用于报错文案定位，如「智能体「健康管家」」）
 */
export function resolveFallback(scene = '智能体') {
  if (config.allowMockFallback) return 'fallback'
  throw new ModelUnavailableError(
    `${scene}无法调用大模型：未检测到 DEEPSEEK_API_KEY。` +
      `当前 ALLOW_MOCK_FALLBACK=false 已禁用降级模式，请检查 .env.local 是否放在项目根目录、` +
      `是否被正确读取（后端启动日志的「模型：」一行，或 GET /api/status 的 modelConfigured 字段）。`
  )
}

/**
 * 「模型调用失败」时的统一降级裁决。
 *
 * · ALLOW_MOCK_FALLBACK=true（默认）：返回 'fallback'，用 mock 兜住，保证演示流程不中断。
 * · ALLOW_MOCK_FALLBACK=false       ：**原样抛出真实错误**，不再掩盖 401 / 超时 / 配额不足等
 *   真实故障原因（默认行为下这些错误会被 mock 结果盖住，很难发现）。
 *
 * @param {Error} err 模型调用原始错误
 */
export function resolveFallbackOnError(err) {
  if (config.allowMockFallback) return 'fallback'
  throw err
}

async function request(payload, externalSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  const onAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ModelError(
        `模型服务返回 ${res.status}：${detail.slice(0, 400) || res.statusText}`,
        res.status,
      )
    }
    return res
  } catch (err) {
    if (err instanceof ModelError) throw err
    if (err.name === 'AbortError') throw new ModelError('模型请求超时或已取消', 499)
    throw new ModelError(`模型请求失败：${err.message}`, 502)
  } finally {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort)
  }
}

/**
 * 非流式对话，支持 Function Calling。
 * @returns {Promise<{content: string, toolCalls: Array, raw: object}>}
 */
export async function chat({ messages, tools, temperature, jsonMode = false, signal }) {
  const body = {
    model: config.model,
    messages,
    temperature: temperature ?? config.temperature,
    stream: false,
  }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  if (jsonMode) body.response_format = { type: 'json_object' }

  const res = await request(body, signal)
  const data = await res.json()
  const choice = data?.choices?.[0]?.message ?? {}
  return {
    content: choice.content ?? '',
    toolCalls: choice.tool_calls ?? [],
    finishReason: data?.choices?.[0]?.finish_reason,
    usage: data?.usage ?? null,
    raw: data,
  }
}

/**
 * 流式对话，逐 token 产出文本增量。
 * 注意：流式模式下【不】传 tools —— 工具决策由 runToolLoop 用非流式完成，
 * 最后一步再用本函数生成自然语言答复，保证「工具调用」与「打字机效果」都能拿到。
 */
export async function* chatStream({ messages, temperature, signal }) {
  const res = await request(
    {
      model: config.model,
      messages,
      temperature: temperature ?? config.temperature,
      stream: true,
    },
    signal,
  )

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const parsed = JSON.parse(payload)
        const delta = parsed?.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch {
        // 忽略不完整的分片
      }
    }
  }
}

/**
 * 带工具调用的多轮闭环：模型决策 → 执行工具 → 回灌结果 → 再决策，直到产出最终答复。
 *
 * @param {object}   opts
 * @param {Array}    opts.messages   初始消息
 * @param {Array}    opts.tools      工具定义（OpenAI 格式）
 * @param {Function} opts.execute    执行器 (name, args) => Promise<any>
 * @param {Function} opts.onToolCall 回调，用于把工具调用轨迹推给前端
 * @param {number}   opts.maxRounds  最大轮数
 */
export async function runToolLoop({
  messages,
  tools,
  execute,
  onToolCall,
  maxRounds = 4,
  temperature,
  signal,
}) {
  const history = [...messages]
  const trace = []

  for (let round = 0; round < maxRounds; round += 1) {
    const { content, toolCalls } = await chat({ messages: history, tools, temperature, signal })

    if (!toolCalls.length) {
      return { messages: history, content, trace }
    }

    history.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })

    for (const call of toolCalls) {
      const name = call.function?.name
      let args = {}
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        args = { _raw: call.function?.arguments }
      }

      let result
      try {
        result = await execute(name, args)
      } catch (err) {
        result = { error: err.message }
      }

      const record = { round, name, args, result }
      trace.push(record)
      if (onToolCall) onToolCall(record)

      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result ?? null).slice(0, 6000),
      })
    }
  }

  // 超出轮数上限，强制收口
  const { content } = await chat({
    messages: [...history, { role: 'user', content: '请基于以上信息直接给出最终答复，不要再调用工具。' }],
    temperature,
    signal,
  })
  return { messages: history, content, trace }
}

/**
 * 让模型返回结构化 JSON（用于智能体之间的数据交换）。
 * 带上容错：解析失败时回退为 { text: 原文 }。
 */
export async function chatJSON({ system, user, temperature = 0.4, signal }) {
  const { content } = await chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    jsonMode: true,
    signal,
  })
  return safeParseJSON(content)
}

export function safeParseJSON(text) {
  if (!text) return {}
  let cleaned = String(text).trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        /* fallthrough */
      }
    }
    return { text: String(text) }
  }
}
