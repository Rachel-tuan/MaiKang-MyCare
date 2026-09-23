/**
 * 迈康 MyCare · 第二阶段 Step 5 验证脚本
 * ===========================================================================
 * 验证闭环：patient_id → dataProvider → Agent → **确定性规则** → alerts 落库 → 医生/患者端读取
 *
 * 做法：脚本在隔离端口拉起 Express（子进程，强制走本地推理引擎以保证可复现），
 *       · 打 briefing / orchestrate / chat 三类智能体接口（只传 patientId）；
 *       · 校验 run_done / alerts_persisted 事件序列；
 *       · 直接查 SQLite 校验 alerts 表落库内容与规则口径一致；
 *       · 用「恶意 context」证明后端只认 patient_id 自取数据；
 *       · 复跑一次验证幂等（同日同规则不重复插入）；
 *       · 校验错误场景（未知患者 404 / 缺 patientId 400）。
 *
 * 运行：node scripts/db/verify-step5.mjs
 * 产物：data/step5-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const NODE = process.execPath
const PORT = 3031
const BASE = `http://127.0.0.1:${PORT}`
// 目标库可用 MYCARE_DB_PATH 覆盖（Step 9：验收统一跑在 reset-demo 生成的干净副本库上，
// 真实库 data/mycare.db 零改动）。脚本自起的后端子进程会继承该环境变量。
const DB_PATH = process.env.MYCARE_DB_PATH
  ? path.resolve(process.env.MYCARE_DB_PATH)
  : path.join(ROOT, 'data', 'mycare.db')

const checks = {}
const samples = {}
let passed = 0
let failed = 0

function check(name, ok, detail) {
  checks[name] = { ok: Boolean(ok), detail }
  if (ok) passed += 1
  else failed += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function req(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* keep null */
  }
  return { status: res.status, json, text }
}

/** 消费 SSE（POST + ReadableStream），返回事件数组 */
async function consumeSSE(p, body, timeoutMs = 90000) {
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
    if (!res.ok || !res.body) {
      return { status: res.status, events, error: await res.text().catch(() => '') }
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder('utf-8')
    let buf = ''
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const blocks = buf.split('\n\n')
      buf = blocks.pop() ?? ''
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (!payload) continue
          try {
            events.push(JSON.parse(payload))
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { status: res.status, events }
  } finally {
    clearTimeout(timer)
  }
}

function waitForServer(timeoutMs = 20000) {
  return (async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const r = await req('GET', '/api/status')
        if (r.status === 200) return true
      } catch {
        /* not up */
      }
      await sleep(300)
    }
    return false
  })()
}

function startServer(port) {
  const child = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    // 强制本地推理引擎：验证目标是「确定性规则 → 落库」，不需要模型网络调用
    env: { ...process.env, PORT: String(port), DEEPSEEK_API_KEY: '', VISION_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

function dbAll(sql, ...params) {
  const db = new DatabaseSync(DB_PATH)
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

function dbGet(sql, ...params) {
  const db = new DatabaseSync(DB_PATH)
  try {
    return db.prepare(sql).get(...params)
  } finally {
    db.close()
  }
}

/* 静态扫描：前端不得再把 records/profile/badges 回传后端 */
function scanFrontendForContextPayload() {
  const offenders = []
  const files = [
    path.join(ROOT, 'src', 'services', 'agentApi.js'),
    path.join(ROOT, 'src', 'contexts', 'AgentContext.jsx'),
  ]
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    // 只要出现 `context: agentContext` 或 `{ context }` 回传即视为违规
    if (/context:\s*agentContext/.test(text) || /\{\s*context\s*\}/.test(text) || /body:\s*\{\s*context\s*\}/.test(text)) {
      offenders.push(path.relative(ROOT, f))
    }
  }
  return offenders
}

const main = async () => {
  const record = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    checks,
    samples,
    orchestrate: {},
    redlineProbe: null,
    dedupe: null,
  }
  const server = startServer(PORT)

  try {
    const up = await waitForServer()
    check('S0 服务启动（本地推理引擎）', up, up ? `listening on ${PORT}` : '启动超时')
    if (!up) throw new Error('后端未启动，终止验证')

    /* ---------------- P. 前置：数据库基线 ---------------- */
    const tables = dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name)
    const p1p2 = ['weight_readings', 'point_transactions', 'user_levels', 'community_activities', 'user_activity_participations'].filter((t) => tables.includes(t))
    check('P1 数据库仍为 P0（未新增表，P1/P2 不存在）', tables.length >= 22 && p1p2.length === 0, `tables=${tables.length} P1/P2=${p1p2.join(',') || 'none'}`)

    // 清空 patient_1/2/3 的历史预警，确保本次验证从干净状态开始
    const cleanDb = new DatabaseSync(DB_PATH)
    try {
      cleanDb.exec('PRAGMA foreign_keys = ON;')
      cleanDb.prepare("DELETE FROM alerts WHERE patient_id IN ('patient_1','patient_2','patient_3')").run()
    } finally {
      cleanDb.close()
    }

    /* ---------------- A. 晨报：只传 patientId ---------------- */
    const brief = await req('POST', '/api/agent/briefing', { patientId: 'patient_1' })
    samples.briefing = { score: brief.json?.score, grade: brief.json?.grade, risk: brief.json?.risk?.label, headline: brief.json?.headline }
    check(
      'A1 晨报只传 patientId → 后端自取数据并返回评分/风险',
      brief.status === 200 && typeof brief.json?.score === 'number' && Boolean(brief.json?.risk?.label),
      JSON.stringify(samples.briefing)
    )
    const briefLegacy = await req('POST', '/api/agent/briefing', { userId: 'patient_2' })
    check('A2 入站 user_id 别名可归一', briefLegacy.status === 200 && typeof briefLegacy.json?.score === 'number', `status=${briefLegacy.status}`)

    /* ---------------- B. 协同：SSE 事件序列 + 落库事件 ---------------- */
    const run1 = await consumeSSE('/api/agent/orchestrate', { patientId: 'patient_1', goal: '生成今日健康简报与干预方案' })
    const types = run1.events.map((e) => e.type)
    record.orchestrate.patient_1 = {
      status: run1.status,
      eventTypes: types,
      agentStarted: run1.events.filter((e) => e.type === 'agent_start').map((e) => e.agentId),
      runDone: run1.events.find((e) => e.type === 'run_done') ? true : false,
    }
    check('B1 协同 SSE 事件序列完整（run_start…run_done）', types.includes('run_start') && types.includes('run_done'), types.join(','))
    const startedAgents = run1.events.filter((e) => e.type === 'agent_start').map((e) => e.agentId)
    check('B2 四个流水线智能体依次启动', ['vitals', 'sentinel', 'planner', 'steward'].every((a) => startedAgents.includes(a)), startedAgents.join(','))

    const persistedEvent = run1.events.find((e) => e.type === 'alerts_persisted')
    record.orchestrate.persistedEvent = persistedEvent
      ? { inserted: persistedEvent.inserted, updated: persistedEvent.updated, alerts: persistedEvent.alerts }
      : null
    check(
      'B3 运行结束下发 alerts_persisted（落库事件）',
      Boolean(persistedEvent) && (persistedEvent.inserted > 0 || persistedEvent.updated >= 0),
      persistedEvent ? `inserted=${persistedEvent.inserted} updated=${persistedEvent.updated}` : '缺失'
    )

    /* ---------------- C. 三患者逐项运行 + 落库口径 ---------------- */
    for (const pid of ['patient_2', 'patient_3']) {
      const r = await consumeSSE('/api/agent/orchestrate', { patientId: pid, goal: '生成今日健康简报' })
      record.orchestrate[pid] = { status: r.status, hasAlertsPersisted: r.events.some((e) => e.type === 'alerts_persisted') }
    }

    const p1Alerts = await req('GET', '/api/patients/patient_1/alerts')
    const p2Alerts = await req('GET', '/api/patients/patient_2/alerts')
    const p3Alerts = await req('GET', '/api/patients/patient_3/alerts')
    const ruleIds = (r) => (r.json?.alerts || []).map((a) => a.ruleId)
    const levelsOf = (r) => (r.json?.alerts || []).map((a) => a.level)
    samples.patient_1_alerts = p1Alerts.json?.alerts
    samples.patient_2_alerts = p2Alerts.json?.alerts
    samples.patient_3_alerts = p3Alerts.json?.alerts

    check(
      'C1 患者端可读落库预警（/api/patients/:id/alerts）',
      p1Alerts.status === 200 && (p1Alerts.json?.count || 0) > 0,
      `patient_1 count=${p1Alerts.json?.count}`
    )
    check(
      'C2 张建国命中 R-BP-2（预警），且不含 R-BP-3（未达 180）',
      ruleIds(p1Alerts).includes('R-BP-2') && !ruleIds(p1Alerts).includes('R-BP-3'),
      `rules=${ruleIds(p1Alerts).join(',')}`
    )
    check(
      'C3 李秀英命中 R-BG-3（预警）+ R-BG-2（关注）',
      ruleIds(p2Alerts).includes('R-BG-3') && ruleIds(p2Alerts).includes('R-BG-2'),
      `rules=${ruleIds(p2Alerts).join(',')}`
    )
    check(
      'C4 王建军命中 R-WT-3（关注）',
      ruleIds(p3Alerts).includes('R-WT-3'),
      `rules=${ruleIds(p3Alerts).join(',')}`
    )

    const levelWord = new Set(['提示', '关注', '预警', '紧急'])
    const allAlerts = [...(p1Alerts.json?.alerts || []), ...(p2Alerts.json?.alerts || []), ...(p3Alerts.json?.alerts || [])]
    check(
      'C5 等级全部为产品词表（提示/关注/预警/紧急），无医学危险分层术语',
      allAlerts.length > 0 && allAlerts.every((a) => levelWord.has(a.level)),
      [...new Set(allAlerts.map((a) => a.level))].join(',')
    )
    check(
      'C6 每条预警均带 rule_id 与确定性依据（detail 非空）',
      allAlerts.every((a) => a.ruleId && a.detail),
      `sample: ${allAlerts[0]?.ruleId} / ${String(allAlerts[0]?.detail).slice(0, 40)}`
    )
    check(
      'C7 R-BP-2 落库依据含「连续」与具体数值（来自规则引擎，非 AI 生成）',
      (p1Alerts.json?.alerts || []).some((a) => a.ruleId === 'R-BP-2' && /连续/.test(a.detail)),
      String((p1Alerts.json?.alerts || []).find((a) => a.ruleId === 'R-BP-2')?.detail || '').slice(0, 60)
    )
    check(
      'C8 外部通知未外发：notifyTargets 仅 self 且 externalBlocked=true',
      allAlerts.every((a) => Array.isArray(a.notifyTargets) && a.notifyTargets.length === 1 && a.notifyTargets[0] === 'self' && a.externalBlocked === true && a.confirmed === false),
      JSON.stringify(allAlerts[0]?.notifyTargets) + ` blocked=${allAlerts[0]?.externalBlocked}`
    )
    check(
      'C9 source 标记为确定性来源（orchestrator / rule_engine）',
      allAlerts.every((a) => a.source === 'orchestrator' || a.source === 'rule_engine'),
      [...new Set(allAlerts.map((a) => a.source))].join(',')
    )

    // 直接查库核对
    const dbRows = dbAll("SELECT patient_id, rule_id, level, source FROM alerts WHERE patient_id IN ('patient_1','patient_2','patient_3') ORDER BY patient_id, rule_id")
    record.dbRows = dbRows
    check('C10 SQLite alerts 表确有落库行', dbRows.length === allAlerts.length && dbRows.length > 0, `dbRows=${dbRows.length} apiRows=${allAlerts.length}`)

    /* ---------------- D. 医生端读取落库预警 ---------------- */
    const doc = await req('GET', '/api/doctors/doc_li/patients')
    const docPatients = doc.json?.patients || []
    const withRecords = docPatients.filter((p) => Array.isArray(p.alertRecords) && p.alertRecords.length > 0)
    samples.doctorAlertRecords = docPatients.map((p) => ({ id: p.id, alertCount: p.alertCount, first: p.alertRecords?.[0]?.ruleId }))
    check(
      'D1 医生端经关系表返回 3 位患者且每人带落库预警 alertRecords',
      doc.status === 200 && docPatients.length === 3 && withRecords.length === 3,
      JSON.stringify(samples.doctorAlertRecords)
    )
    check(
      'D2 医生端 alertRecords 含 ruleId / level / 依据',
      withRecords.length === 3 && withRecords.every((p) => p.alertRecords.every((a) => a.ruleId && a.level && a.detail)),
      ''
    )

    /* ---------------- E. 红线探针：恶意 context 必须无效 ---------------- */
    // 若后端错误地采用前端回传的 records，999 mmHg 会触发 R-BP-3（紧急）。
    const probe = await consumeSSE('/api/agent/orchestrate', {
      patientId: 'patient_1',
      goal: '生成今日健康简报',
      context: {
        user: { user_id: 'patient_1', name: 'HACKED', age: 1, disease_types: [], medical: {} },
        records: [{ record_date: '1999-01-01', systolic_pressure: 999, diastolic_pressure: 150 }],
        badges: [],
      },
    })
    const p1AfterProbe = await req('GET', '/api/patients/patient_1/alerts')
    const probeRules = ruleIds(p1AfterProbe)
    record.redlineProbe = { status: probe.status, rules: probeRules, hasRBP3: probeRules.includes('R-BP-3') }
    check(
      'E1 前端回传的 records 被忽略（未因 999 触发 R-BP-3）',
      !probeRules.includes('R-BP-3'),
      `rules=${probeRules.join(',')}`
    )
    check(
      'E2 仍以 patient_id 自取：R-BP-2 仍在且患者姓名未被篡改',
      probeRules.includes('R-BP-2') && !JSON.stringify(p1AfterProbe.json?.alerts || []).includes('HACKED'),
      `rules=${probeRules.join(',')}`
    )

    /* ---------------- F. 幂等：同日同规则不重复插入 ---------------- */
    const before = dbGet("SELECT COUNT(*) AS c FROM alerts WHERE patient_id = 'patient_1'").c
    await consumeSSE('/api/agent/orchestrate', { patientId: 'patient_1', goal: '再跑一次' })
    const after = dbGet("SELECT COUNT(*) AS c FROM alerts WHERE patient_id = 'patient_1'").c
    record.dedupe = { before, after }
    check('F1 复跑协同不重复插入（同日同规则幂等）', before === after && after > 0, `${before} → ${after}`)

    /* ---------------- G. 对话接口：patientId 驱动 ---------------- */
    const chat = await consumeSSE('/api/agent/chat', { agentId: 'steward', message: '我今天的血压怎么样？', history: [], patientId: 'patient_1' })
    const chatTypes = chat.events.map((e) => e.type)
    check(
      'G1 对话接口以 patientId 取数并流式返回（含工具调用/正文）',
      chat.status === 200 && chatTypes.includes('chat_start') && chatTypes.includes('chat_done') && chatTypes.includes('token'),
      chatTypes.filter((t, i) => chatTypes.indexOf(t) === i).join(',')
    )

    /* ---------------- H. 错误场景 ---------------- */
    const noPid = await req('POST', '/api/agent/briefing', {})
    check('H1 缺 patientId → 400 E_INVALID_ARG', noPid.status === 400 && noPid.json?.code === 'E_INVALID_ARG', `status=${noPid.status} code=${noPid.json?.code}`)
    const badBrief = await req('POST', '/api/agent/briefing', { patientId: 'nobody' })
    check('H2 未知患者晨报 → 404 E_PATIENT_NOT_FOUND', badBrief.status === 404 && badBrief.json?.code === 'E_PATIENT_NOT_FOUND', `status=${badBrief.status}`)
    const badAlerts = await req('GET', '/api/patients/nobody/alerts')
    check('H3 未知患者预警读取 → 404', badAlerts.status === 404 && badAlerts.json?.code === 'E_PATIENT_NOT_FOUND', `status=${badAlerts.status}`)
    const badRun = await consumeSSE('/api/agent/orchestrate', { patientId: 'nobody' }, 15000)
    check('H4 未知患者协同 → 404（不回落默认患者）', badRun.status === 404, `status=${badRun.status}`)

    /* ---------------- I. 前端不再回传 context ---------------- */
    const offenders = scanFrontendForContextPayload()
    record.staticScan = { offenders }
    check('I1 前端不再向智能体接口回传 records/profile/badges', offenders.length === 0, `offenders=${offenders.join(',') || 'none'}`)

    record.summary = { passed, failed, total: passed + failed, allPass: failed === 0 }
    fs.writeFileSync(path.join(ROOT, 'data', 'step5-verify-record.json'), JSON.stringify(record, null, 2), 'utf8')
    console.log(`\n==== Step 5 验证：${passed}/${passed + failed} 通过 ====`)
  } catch (err) {
    console.error('验证中断：', err)
    record.summary = { passed, failed, total: passed + failed, allPass: false, error: String(err?.message || err) }
    fs.writeFileSync(path.join(ROOT, 'data', 'step5-verify-record.json'), JSON.stringify(record, null, 2), 'utf8')
    process.exitCode = 1
  } finally {
    try {
      server.kill()
    } catch {
      /* ignore */
    }
  }
}

main()
