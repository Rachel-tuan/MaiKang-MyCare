/**
 * 迈康 MyCare · `ALLOW_MOCK_FALLBACK` 接线验收
 * ===========================================================================
 * 背景
 *   该开关原先只在 `server/config.js` 里定义、**没有任何消费点**（死开关），
 *   文档声称「设为 false 可禁用降级」与真实行为不符。本脚本验证接线后的真实语义。
 *
 * 接线后的语义（已固化在 `server/deepseek.js`）
 *   · `ALLOW_MOCK_FALLBACK=true`（默认）→ 模型不可用/调用失败时降级为本地推理引擎，流程不中断；
 *   · `ALLOW_MOCK_FALLBACK=false`        → 排障模式：
 *       ① 未配置 Key  → 抛 `ModelUnavailableError`（而不是安静降级）；
 *       ② 模型调用失败 → **原样抛出真实错误**（401 / 超时 / 配额），不再被 mock 结果掩盖。
 *
 * 做法
 *   · 在**一次性副本库**上运行（从演示副本库复制），演示库/真实库全程只读；
 *   · 每种开关组合各起一个独立 Express 子进程（隔离端口），全部走真实 HTTP 接口；
 *   · 捕获后端 stdout，直接断言启动日志里的「模型：」一行；
 *   · 被验证的链路：`/api/agent/orchestrate`（协同）、`/api/agent/chat`（对话）、
 *     `/api/agent/briefing`（纯本地，**不应**受开关影响）、`/api/status`。
 *
 * 运行：node scripts/db/verify-fallback-flag.mjs
 * 前置：node scripts/db/reset-demo.mjs（生成 data/mycare-demo.db）
 * 产物：data/fallback-flag-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const NODE = process.execPath
const PORT = 3052
const BASE = `http://127.0.0.1:${PORT}`

const DEMO_DB = path.resolve(process.env.MYCARE_DEMO_DB_PATH || path.join(ROOT, 'data', 'mycare-demo.db'))
const TEST_DB = path.join(ROOT, 'data', '_fallback-flag.db')
const ENV_LOCAL = path.join(ROOT, '.env.local')

if (!fs.existsSync(DEMO_DB)) {
  console.error(`❌ 未找到演示副本库：${DEMO_DB}\n   请先运行：node scripts/db/reset-demo.mjs`)
  process.exit(1)
}
fs.copyFileSync(DEMO_DB, TEST_DB)

const PATIENT_ID = 'patient_1'
const INVALID_KEY = 'sk-mycare-invalid-key-for-test'

const checks = {}
let passed = 0
let failed = 0

function check(name, ok, detail) {
  checks[name] = { ok: Boolean(ok), detail }
  if (ok) passed += 1
  else failed += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ 起停服务 ------------------------------ */

/** 起一个后端子进程；返回 { child, logs(), stop() } —— logs() 可取到启动日志全文 */
async function startServer(env) {
  const merged = {
    ...process.env,
    PORT: String(PORT),
    MYCARE_DB_PATH: TEST_DB,
    VISION_API_KEY: '',
    // 真实模型的网络调用要快速失败，避免验收挂住（401 通常在 1s 内返回）
    DEEPSEEK_TIMEOUT_MS: '8000',
    ...env,
  }
  // '__DELETE__' = 从子进程环境中彻底移除该变量（用于「让 .env.local 的 Key 生效」的场景）；
  // undefined 同理剔除，避免被 spawn 字符串化成 "undefined"。
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined || merged[k] === '__DELETE__') delete merged[k]
  }

  const child = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    env: merged,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => {
    out += d.toString()
  })
  child.stderr.on('data', (d) => {
    out += d.toString()
  })

  const deadline = Date.now() + 25000
  let up = false
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/status`)
      if (r.status === 200) {
        up = true
        break
      }
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  if (!up) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    throw new Error(`服务未能在 25s 内就绪。日志：\n${out}`)
  }

  return {
    logs: () => out,
    async stop() {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      const end = Date.now() + 6000
      while (Date.now() < end) {
        try {
          await fetch(`${BASE}/api/status`)
        } catch {
          return
        }
        await sleep(200)
      }
    },
  }
}

async function withServer(env, fn) {
  const srv = await startServer(env)
  try {
    return await fn(srv)
  } finally {
    await srv.stop()
  }
}

/* ------------------------------ 请求工具 ------------------------------ */

async function getJson(p) {
  const res = await fetch(`${BASE}${p}`)
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: null }
  }
}

async function postJson(p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: null }
  }
}

/** 读完整条 SSE 流，收集所有事件（不提前中断，确保服务端流程跑完） */
async function sseCollect(p, body, timeoutMs = 40000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events = []
  try {
    const res = await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          try {
            events.push(JSON.parse(payload))
          } catch {
            /* 非 JSON 帧（如心跳注释）忽略 */
          }
        }
      }
    }
  } catch {
    /* 超时或连接中断：返回已收集到的事件 */
  } finally {
    clearTimeout(timer)
  }
  return events
}

const typesOf = (events) => events.map((e) => e.type)
const errMessages = (events) => events.filter((e) => e.type === 'error').map((e) => String(e.message || ''))
const KEY_HINT = (m) => m.includes('DEEPSEEK_API_KEY')
const FLAG_HINT = (m) => m.includes('ALLOW_MOCK_FALLBACK=false')

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })

  /* ============ A. 无 Key + 默认 true → 降级可用（行为不变） ============ */
  console.log('\n[A] 无 Key + ALLOW_MOCK_FALLBACK=true（默认）：应正常降级')
  await withServer({ DEEPSEEK_API_KEY: '', ALLOW_MOCK_FALLBACK: 'true' }, async (srv) => {
    const st = await getJson('/api/status')
    check('A1 /api/status 暴露 mockFallbackAllowed=true', st.json?.mockFallbackAllowed === true, `got=${st.json?.mockFallbackAllowed}`)
    check('A2 status.modelConfigured=false', st.json?.modelConfigured === false, `got=${st.json?.modelConfigured}`)
    check('A3 启动日志显示「降级模式」', srv.logs().includes('降级模式'), '')
    check('A4 启动日志不显示「已禁用降级」', !srv.logs().includes('已禁用降级'), '')

    const ev = await sseCollect('/api/agent/orchestrate', { patientId: PATIENT_ID })
    check('A5 orchestrate 无 error 事件', errMessages(ev).length === 0, errMessages(ev).join(' | ') || 'none')
    check('A6 orchestrate 有 agent_result 且 degraded=true', ev.some((e) => e.type === 'agent_result' && e.degraded === true), `types=${typesOf(ev).join(',')}`)
    check('A7 orchestrate 走到 run_done', typesOf(ev).includes('run_done'), '')
  })

  /* ============ B. 无 Key + false → 排障模式：显式报错 ============ */
  console.log('\n[B] 无 Key + ALLOW_MOCK_FALLBACK=false：应显式报错，不静默降级')
  await withServer({ DEEPSEEK_API_KEY: '', ALLOW_MOCK_FALLBACK: 'false' }, async (srv) => {
    const st = await getJson('/api/status')
    check('B1 /api/status 暴露 mockFallbackAllowed=false', st.json?.mockFallbackAllowed === false, `got=${st.json?.mockFallbackAllowed}`)
    check('B2 启动日志显示「已禁用降级」', srv.logs().includes('已禁用降级'), '')

    const ev = await sseCollect('/api/agent/orchestrate', { patientId: PATIENT_ID })
    const msgs = errMessages(ev)
    check('B3 orchestrate 返回 error 事件', msgs.length > 0, `types=${typesOf(ev).join(',')}`)
    check('B4 错误信息点名 DEEPSEEK_API_KEY', msgs.some(KEY_HINT), msgs[0]?.slice(0, 80) || 'none')
    check('B5 错误信息点名 ALLOW_MOCK_FALLBACK=false', msgs.some(FLAG_HINT), '')
    check('B6 不再产生 agent_result（未静默降级）', !typesOf(ev).includes('agent_result'), '')
    check('B7 未走到 run_done', !typesOf(ev).includes('run_done'), '')

    const chat = await sseCollect('/api/agent/chat', { patientId: PATIENT_ID, agentId: 'steward', message: '今天要注意什么？' })
    const chatMsgs = errMessages(chat)
    check('B8 chat 链路同样返回 error', chatMsgs.length > 0, `types=${typesOf(chat).join(',')}`)
    check('B9 chat 不再返回 chat_done(degraded)', !typesOf(chat).includes('chat_done'), '')

    const brief = await postJson('/api/agent/briefing', { patientId: PATIENT_ID })
    check('B10 briefing 为纯本地算法，仍正常 200', brief.status === 200 && Boolean(brief.json?.score !== undefined), `status=${brief.status}`)
  })

  /* ============ C. 无效 Key + false → 真实错误必须原样抛出 ============ */
  console.log('\n[C] 无效 Key + ALLOW_MOCK_FALLBACK=false：真实调用错误不得被 mock 掩盖')
  await withServer({ DEEPSEEK_API_KEY: INVALID_KEY, ALLOW_MOCK_FALLBACK: 'false' }, async (srv) => {
    const st = await getJson('/api/status')
    check('C1 Key 存在时 modelConfigured=true（开关不拦有 Key 的场景）', st.json?.modelConfigured === true, `got=${st.json?.modelConfigured}`)
    check('C2 启动日志显示模型名，不含「已禁用降级」', !srv.logs().includes('已禁用降级'), '')

    const ev = await sseCollect('/api/agent/orchestrate', { patientId: PATIENT_ID })
    const msgs = errMessages(ev)
    check('C3 orchestrate 返回 error 事件', msgs.length > 0, `types=${typesOf(ev).join(',')}`)
    check('C4 错误不是「未检测到 Key」（说明已进入真实调用）', !msgs.some(KEY_HINT), msgs[0]?.slice(0, 90) || 'none')
    check('C5 不再产生 degraded 的 agent_result', !ev.some((e) => e.type === 'agent_result' && e.degraded === true), '')
  })

  /* ============ D. 无效 Key + 默认 true → 兜底行为保持不变 ============ */
  console.log('\n[D] 无效 Key + ALLOW_MOCK_FALLBACK=true：仍应被 mock 兜住（默认行为不变）')
  await withServer({ DEEPSEEK_API_KEY: INVALID_KEY, ALLOW_MOCK_FALLBACK: 'true' }, async () => {
    const ev = await sseCollect('/api/agent/orchestrate', { patientId: PATIENT_ID })
    check('D1 orchestrate 无 error 事件', errMessages(ev).length === 0, errMessages(ev).join(' | ') || 'none')
    check('D2 有 degraded 的 agent_result', ev.some((e) => e.type === 'agent_result' && e.degraded === true), `types=${typesOf(ev).join(',')}`)
    check('D3 走到 run_done', typesOf(ev).includes('run_done'), '')
  })

  /* ============ E. 真实 Key（.env.local）+ false → 只验开关不误拦，不消耗额度 ============ */
  console.log('\n[E] .env.local 真实 Key + ALLOW_MOCK_FALLBACK=false：开关不得误拦（不发起真实模型调用）')
  if (!fs.existsSync(ENV_LOCAL)) {
    console.log('  [SKIP] 未找到 .env.local，跳过 E 组（该组用于验证「有 Key 时开关不误拦」）')
    check('E1 .env.local 存在（决定 E 组是否可验）', false, '未找到 .env.local')
  } else {
    await withServer({ ALLOW_MOCK_FALLBACK: 'false', DEEPSEEK_API_KEY: '__DELETE__' }, async (srv) => {
      const st = await getJson('/api/status')
      check('E1 有 Key 时 modelConfigured=true', st.json?.modelConfigured === true, `got=${st.json?.modelConfigured}`)
      check('E2 同时 mockFallbackAllowed=false（两个开关互不干扰）', st.json?.mockFallbackAllowed === false, `got=${st.json?.mockFallbackAllowed}`)
      check('E3 启动日志显示模型名，且不含「已禁用降级」警告', !srv.logs().includes('已禁用降级') && !srv.logs().includes('降级模式'), '')
    })
  }

  /* ============ 收尾：真实库/演示库零改动 ============ */
  console.log('\n[F] 数据安全：仅使用一次性副本库')
  check('F1 未在真实库 data/mycare.db 上运行', path.resolve(TEST_DB) !== path.resolve(path.join(ROOT, 'data', 'mycare.db')), '')

  const line = '─'.repeat(78)
  console.log(`\n${line}`)
  console.log(`==== ALLOW_MOCK_FALLBACK 接线验收：${passed}/${passed + failed} 通过 ====`)
  console.log(line)

  fs.writeFileSync(
    path.join(ROOT, 'data', 'fallback-flag-verify-record.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), total: passed + failed, passed, failed, checks },
      null,
      2,
    ),
    'utf8',
  )

  try {
    fs.unlinkSync(TEST_DB)
  } catch {
    /* ignore */
  }

  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n❌ 验收脚本异常：', err)
  try {
    fs.unlinkSync(TEST_DB)
  } catch {
    /* ignore */
  }
  process.exit(1)
})
