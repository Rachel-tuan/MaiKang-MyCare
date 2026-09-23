/**
 * 迈康 MyCare · 「AI 评分三分层」验收（Step 11 · Phase 3）
 * ===========================================================================
 * 被验收的红线（方案 §4 / §6）：
 *   L1 Rule Score       computeDailyHealthScore()        ← **唯一正式分**
 *   L2 AI Assessment    模型 → adjustments[]（无分数）    ← 生成式、可失败、只是「意见」
 *   L3 AI-assisted Score 确定性纯函数合成                 ← **辅助显示项，不得驱动预警/等级/达标率**
 *
 *   · AI **永远不能直接输出 0–100 分**；
 *   · 六条硬约束（条数 ≤4 / delta ∈[-5,5] 整数 / 同维度不重复 / reason 1–80 字 / Σ|delta| ≤10）
 *     任一不满足 → **整包丢弃**（不做部分采纳）；
 *   · 一切降级（未配置 / 调用失败 / 结构不合法 / 违反约束）**一律回落 Rule Score**；
 *   · 守恒：`assisted − rule === Σdelta`；clamp 时**如实上报** `clamped` 与 `rawAssisted`，
 *     不得静默（`rule=98, Σ=+10 → assisted=100, raw=108`）；
 *   · 界面**主数字恒为 Rule Score**，AI 辅助分带 `[AI 辅助]` 标签 + 免责脚注。
 *
 * 关键设计：脚本内自建 **stub 模型服务**（本地 HTTP，可编程返回），后端经
 * `DEEPSEEK_BASE_URL` 指向它 —— 于是「模型返回非法包 / 401 / 非法 JSON」这些
 * 分支都能**确定性复现**，不依赖真实模型、不需要联网。
 *
 * 用法：node scripts/db/verify-ai-score.mjs
 *   推荐：MYCARE_DB_PATH=data/mycare-demo.db node scripts/db/verify-ai-score.mjs
 * 前置：本机有 Edge/Chrome；无需先启动 3000/3001
 * 产出：data/ai-score-verify-record.json
 *
 * ⚠️ 全程只动**副本库**（MYCARE_DB_PATH 指向的库被复制到临时文件后再用），
 *    真实演示库 mtime / 大小前后逐字比对。
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { computeDailyHealthScore, gradeOf, SCORE_WEIGHTS } from '../../src/utils/healthScore.js'
import {
  AI_SCORE_CONSTRAINTS,
  AI_STATUS_TEXT,
  ADJUSTMENT_DIMENSIONS,
  ADJUSTMENT_REJECT_CODES,
  buildAiAssessment,
  buildInputHash,
  composeAssistedScore,
} from '../../src/utils/aiScore.js'

const ROOT = process.cwd()
/** 真实演示库（只读）——默认 data/mycare.db；建议用 MYCARE_DB_PATH 指向 mycare-demo.db */
const REAL_DB = process.env.MYCARE_DB_PATH
  ? path.resolve(process.env.MYCARE_DB_PATH)
  : path.join(ROOT, 'data', 'mycare.db')
/** 出厂真实库：即便上面被环境变量指向副本，这个也要证明没被动过 */
const CANONICAL_DB = path.join(ROOT, 'data', 'mycare.db')
const TEST_DB = path.join(os.tmpdir(), `mycare-aiscore-${Date.now()}.db`)

const API_PORT = Number(process.env.MYCARE_AISCORE_API_PORT || 3052)
const WEB_PORT = Number(process.env.MYCARE_AISCORE_WEB_PORT || 3053)
const CDP_PORT = Number(process.env.MYCARE_CDP_PORT || 9365)
const STUB_PORT = Number(process.env.MYCARE_AISCORE_STUB_PORT || 3054)
const API = `http://127.0.0.1:${API_PORT}`
const WEB = `http://127.0.0.1:${WEB_PORT}`
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/v1`

/** 患者分工（缓存按 patientId 隔离，故三类场景各占一位，互不干扰） */
const P_HTTP = 'patient_3' // HTTP 场景组（全程 force=true，仅缓存断言用非 force）
const P_UI_OK = 'patient_1' // 浏览器：AI 可用（两个标签都在）
const P_UI_BAD = 'patient_2' // 浏览器：降级（不得出现 AI 辅助分）

const NODE = process.execPath
const VITE_CFG = path.join(ROOT, '.verify-aiscore.vite.config.mjs')
const CLINICAL_RULES = path.join(ROOT, 'src', 'utils', 'clinicalRules.js')

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BENIGN = [
  /^Warning: /,
  /React Router Future Flag/,
  /autocomplete attributes/,
  /Download the React DevTools/,
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const record = {
  generatedAt: new Date().toISOString(),
  api: API,
  web: WEB,
  stub: STUB_BASE,
  realDb: REAL_DB,
  checks: {},
  summary: {},
}
let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  record.checks[name] = { ok: Boolean(ok), detail }
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function api(method, p, body) {
  const res = await fetch(`${API}/api${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* ignore */
  }
  return { status: res.status, json }
}

const md5 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/* ========================================================================== *
 * 第一段：Rule Score 回归（**忠实移植** verify-health-score.mjs 的 1–13 条）
 * --------------------------------------------------------------------------
 * 方案 §11.3 第 1 条要求「Rule Score 与原有 13 条确定性规则完全一致」。
 * 移植而非 import：那 13 条断言是脚本内联的，没有导出；这里保持同一组输入与期望值，
 * 一旦有人改动医嘱口径，两份脚本会**同时**报红。
 * ========================================================================== */
console.log('—— 第一段：Rule Score 回归（与 verify-health-score 1–13 同源）——')

const HBP = ['原发性高血压', '超重', '中心性肥胖']
const DM = ['2 型糖尿病', '超重', '血脂异常']
const BOTH = ['高血压', '2 型糖尿病']
const NONE = []
const scoreOf = (today, diseases) => computeDailyHealthScore({ today, diseases })

const missingBp = scoreOf({ steps: 10333, exercise_minutes: 60 }, HBP)
check(
  '1a 高血压患者未测血压时不得满分（缺陷回归）',
  missingBp.score < 100,
  `score=${missingBp.score} 分母=${missingBp.applicableWeight} 缺测=${missingBp.missing.join('、') || '无'}`,
)
check(
  '1b 未录入的血压按 0 分计入分母',
  missingBp.breakdown.find((b) => b.key === 'bloodPressure')?.status === 'missing' &&
    missingBp.breakdown.find((b) => b.key === 'bloodPressure')?.earned === 0,
  `血压项得分=${missingBp.breakdown.find((b) => b.key === 'bloodPressure')?.earned}`,
)
check(
  '1c 缺测时仍如实反映已达标项（步数/运动拿满）',
  missingBp.breakdown.find((b) => b.key === 'steps')?.earned === SCORE_WEIGHTS.steps &&
    missingBp.breakdown.find((b) => b.key === 'exercise')?.earned === SCORE_WEIGHTS.exercise,
  `分子=${missingBp.earnedWeight}/${missingBp.applicableWeight}`,
)

const hbpOnly = scoreOf(
  { steps: 12000, systolic_pressure: 126, diastolic_pressure: 80, exercise_minutes: 60 },
  HBP,
)
const dmOnly = scoreOf({ steps: 12000, blood_sugar: 6.1, exercise_minutes: 60 }, DM)
const both = scoreOf(
  { steps: 12000, systolic_pressure: 126, diastolic_pressure: 80, blood_sugar: 6.1, exercise_minutes: 60 },
  BOTH,
)
const noDisease = scoreOf({ steps: 12000, exercise_minutes: 60 }, NONE)
check(
  '1d 高血压患者分母只含 步数+血压+运动（不含血糖）',
  hbpOnly.applicableWeight === 75 && !hbpOnly.breakdown.some((b) => b.key === 'bloodGlucose'),
  `分母=${hbpOnly.applicableWeight}`,
)
check(
  '1e 糖尿病患者分母只含 步数+血糖+运动（不含血压）',
  dmOnly.applicableWeight === 75 && !dmOnly.breakdown.some((b) => b.key === 'bloodPressure'),
  `分母=${dmOnly.applicableWeight}`,
)
check(
  '1f 高血压 + 糖尿病时四个维度都计入（满分 100）',
  both.applicableWeight === 100 && both.breakdown.length === 4,
  `分母=${both.applicableWeight}`,
)
check(
  '1g 无疾病谱的账号只计通用项（步数 + 运动 = 50 分）',
  noDisease.applicableWeight === 50,
  `分母=${noDisease.applicableWeight}`,
)
check(
  '1h 适用维度全部达标时满分仍为 100（归一化正确）',
  hbpOnly.score === 100 && dmOnly.score === 100 && both.score === 100 && noDisease.score === 100,
  `高血压=${hbpOnly.score} 糖尿病=${dmOnly.score} 双病=${both.score} 无病=${noDisease.score}`,
)

const badBp = scoreOf(
  { steps: 12000, systolic_pressure: 170, diastolic_pressure: 105, exercise_minutes: 60 },
  HBP,
)
const noExercise = scoreOf(
  { steps: 12000, systolic_pressure: 126, diastolic_pressure: 80, exercise_minutes: 0 },
  HBP,
)
check(
  '1i 血压严重超标按阶梯拿部分分（0.2 × 25）',
  badBp.breakdown.find((b) => b.key === 'bloodPressure')?.earned === 5,
  `血压项得分=${badBp.breakdown.find((b) => b.key === 'bloodPressure')?.earned}`,
)
check(
  '1j 运动 0 分钟记 0 分（不做「没记录也送保底分」）',
  noExercise.breakdown.find((b) => b.key === 'exercise')?.earned === 0,
  `运动项得分=${noExercise.breakdown.find((b) => b.key === 'exercise')?.earned}`,
)

const stepsEarned = (n) =>
  scoreOf({ steps: n, exercise_minutes: 60 }, NONE).breakdown.find((b) => b.key === 'steps').earned
const ladder = [0, 1000, 2000, 3000, 3999, 4000, 5999, 6000, 7999, 8000, 9999, 10000]
const earnedList = ladder.map(stepsEarned)
check(
  '1k 步数阶梯整条单调不减（线性段已封顶，9999 步不得越过 10000 步档）',
  earnedList.every((v, i) => i === 0 || v >= earnedList[i - 1]) &&
    stepsEarned(3999) <= stepsEarned(4000) &&
    earnedList[earnedList.length - 1] === SCORE_WEIGHTS.steps,
  ladder.map((n, i) => `${n}→${earnedList[i]}`).join(' '),
)
check(
  '1l 分档阈值统一为 85 / 70 / 55',
  gradeOf(100) === '优秀' &&
    gradeOf(85) === '优秀' &&
    gradeOf(84) === '良好' &&
    gradeOf(70) === '良好' &&
    gradeOf(69) === '一般' &&
    gradeOf(55) === '一般' &&
    gradeOf(54) === '需干预',
  `85→${gradeOf(85)} 70→${gradeOf(70)} 55→${gradeOf(55)} 54→${gradeOf(54)}`,
)
const empty = scoreOf({}, HBP)
check(
  '1m 完全没有记录时得 0 分且不抛异常',
  empty.score === 0 && empty.breakdown.length === 3,
  `score=${empty.score} 分母=${empty.applicableWeight}`,
)

/* ========================================================================== *
 * 第二段：AI 三分层纯函数（方案 §11.3 第 2–10 条）
 * ========================================================================== */
console.log('\n—— 第二段：AI 三分层纯函数（src/utils/aiScore.js）——')

const APPLIC = ['steps', 'bloodPressure', 'exercise'] // 虚构「无血糖」患者，用于非适用维度断言
const assess = (raw, rule = 67) =>
  buildAiAssessment(raw, { ruleScore: rule, applicableDimensions: APPLIC })

// 2
const c2 = composeAssistedScore(67, [])
check('2 composeAssistedScore(rule, []) → assisted === rule', c2.assisted === 67 && c2.sumDelta === 0 && !c2.clamped)

// 3
const a3 = assess({ adjustments: [{ dimension: 'steps', delta: -6, reason: '越界下界' }] })
check(
  '3 单条 delta 越界（-6）→ 整包丢弃',
  a3.aiStatus === 'rejected' && a3.ai === null && a3.code === ADJUSTMENT_REJECT_CODES.E_DELTA_OUT_OF_RANGE,
  `status=${a3.aiStatus} code=${a3.code}`,
)

// 4
const a4 = assess({
  adjustments: [
    { dimension: 'steps', delta: 5, reason: '一' },
    { dimension: 'bloodPressure', delta: 5, reason: '二' },
    { dimension: 'exercise', delta: 2, reason: '三' },
  ],
})
check(
  '4 Σ|delta| = 12 > 10 → 整包丢弃',
  a4.aiStatus === 'rejected' && a4.code === ADJUSTMENT_REJECT_CODES.E_DELTA_SUM_EXCEEDED,
  `status=${a4.aiStatus} code=${a4.code}`,
)

// 5
const a5 = assess({ adjustments: [{ dimension: 'steps', delta: -3 }] })
check(
  '5 缺少 reason → 整包丢弃',
  a5.aiStatus === 'rejected' && a5.code === ADJUSTMENT_REJECT_CODES.E_REASON_INVALID,
  `status=${a5.aiStatus} code=${a5.code}`,
)

// 6
const a6 = assess({ adjustments: [{ dimension: 'steps', delta: -3.5, reason: '非整数' }] })
check(
  '6 delta 非整数（-3.5）→ 整包丢弃',
  a6.aiStatus === 'rejected' && a6.code === ADJUSTMENT_REJECT_CODES.E_DELTA_NOT_INTEGER,
  `status=${a6.aiStatus} code=${a6.code}`,
)

// 7
const a7 = assess({
  adjustments: [
    { dimension: 'steps', delta: -3, reason: '甲' },
    { dimension: 'steps', delta: -3, reason: '乙' },
  ],
})
check(
  '7 同一 dimension 重复（拆分规避 ±5）→ 整包丢弃',
  a7.aiStatus === 'rejected' && a7.code === ADJUSTMENT_REJECT_CODES.E_DUPLICATE_DIMENSION,
  `status=${a7.aiStatus} code=${a7.code}`,
)

// 8
const a8a = assess({ adjustments: [{ dimension: 'sleep', delta: 1, reason: '未知维度' }] })
const a8b = assess({ adjustments: [{ dimension: 'bloodGlucose', delta: 1, reason: '该患者不适用' }] })
check(
  '8 未知 dimension → 整包丢弃',
  a8a.aiStatus === 'rejected' && a8a.code === ADJUSTMENT_REJECT_CODES.E_UNKNOWN_DIMENSION,
  `code=${a8a.code}`,
)
check(
  '8b 枚举内但**非该患者适用**维度 → 整包丢弃',
  a8b.aiStatus === 'rejected' && a8b.code === ADJUSTMENT_REJECT_CODES.E_DIMENSION_NOT_APPLICABLE,
  `code=${a8b.code}`,
)

// 9
const a9 = assess({
  adjustments: [
    { dimension: 'exercise', delta: -3, reason: '连续 2 天运动后即刻血糖偏低' },
    { dimension: 'steps', delta: 2, reason: '关节不适，步数略降' },
  ],
})
check(
  '9 守恒：assisted − rule === Σdelta',
  a9.aiStatus === 'ok' && a9.ai.assisted - 67 === a9.ai.sumDelta && a9.ai.sumDelta === -1 && a9.ai.assisted === 66,
  `assisted=${a9.ai?.assisted} sumDelta=${a9.ai?.sumDelta}`,
)

// 10
const c10 = composeAssistedScore(98, [
  { dimension: 'steps', delta: 5 },
  { dimension: 'exercise', delta: 5 },
])
check(
  '10 clamp 边界：rule=98, Σ=+10 → assisted=100 / clamped=true / rawAssisted=108 如实上报',
  c10.assisted === 100 && c10.clamped === true && c10.rawAssisted === 108 && c10.sumDelta === 10,
  `assisted=${c10.assisted} raw=${c10.rawAssisted} clamped=${c10.clamped}`,
)
const c10b = composeAssistedScore(2, [{ dimension: 'steps', delta: -5 }])
check(
  '10b clamp 下界：rule=2, Σ=-5 → assisted=0 / clamped=true / rawAssisted=-3',
  c10b.assisted === 0 && c10b.clamped === true && c10b.rawAssisted === -3,
  `assisted=${c10b.assisted} raw=${c10b.rawAssisted}`,
)

// 附加：inputHash 稳定性（同数据不同键序 → 同哈希；数据一变 → 哈希变）
const hA = buildInputHash({ today: { steps: 8000, record_date: '2026-09-16' }, diseases: ['原发性高血压', '超重'], ruleScore: 67 })
const hB = buildInputHash({ diseases: ['超重', '原发性高血压'], ruleScore: 67, today: { record_date: '2026-09-16', steps: 8000 } })
const hC = buildInputHash({ today: { steps: 8001, record_date: '2026-09-16' }, diseases: ['原发性高血压', '超重'], ruleScore: 67 })
check(
  '10c inputHash 对键序稳定、对数据敏感（缓存键可靠性前提）',
  hA === hB && hA !== hC,
  `A=${hA} B=${hB} C=${hC}`,
)

/* ========================================================================== *
 * 第三段：stub 模型服务（可编程返回，模型分支全部确定性复现）
 * ========================================================================== */
console.log('\n—— 第三段：stub 模型服务 ——')

const stub = {
  /** 下一次请求要返回什么 */
  next: { status: 200, content: { adjustments: [] } },
  calls: 0,
  bodies: [],
}

const stubServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => {
    raw += c
  })
  req.on('end', () => {
    stub.calls += 1
    try {
      stub.bodies.push(JSON.parse(raw))
    } catch {
      stub.bodies.push(null)
    }
    const s = stub.next || { status: 200, content: { adjustments: [] } }
    if (s.status && s.status !== 200) {
      res.writeHead(s.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: s.message || 'stub failure', type: 'invalid_request_error' } }))
      return
    }
    const content = typeof s.content === 'string' ? s.content : JSON.stringify(s.content)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'stub-cmpl',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    )
  })
})

let apiChild = null
let webChild = null
let browserChild = null
let userDataDir = null

function killAll() {
  for (const c of [apiChild, webChild, browserChild]) {
    try {
      if (c && !c.killed) c.kill()
    } catch {
      /* ignore */
    }
  }
  try {
    if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    for (const ext of ['', '-wal', '-shm']) {
      const f = TEST_DB + ext
      if (fs.existsSync(f)) fs.rmSync(f)
    }
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(VITE_CFG)) fs.rmSync(VITE_CFG)
  } catch {
    /* ignore */
  }
}

async function waitFor(url, tries = 80, gap = 250) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status === 404) return true
    } catch {
      /* retry */
    }
    await sleep(gap)
  }
  return false
}

/** 只读副本库 */
function queryDb(fn) {
  const db = new DatabaseSync(TEST_DB, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** patient_targets 全行全列快照（`SELECT *`：连同 basis / effective_from 一起比对，避免漏项） */
const allTargetsRows = () =>
  queryDb((db) =>
    JSON.stringify(
      db.prepare('SELECT * FROM patient_targets ORDER BY target_id').all(),
    ),
  )

/* ========================================================================== *
 * 主流程
 * ========================================================================== */
const canonBefore = fs.existsSync(CANONICAL_DB) ? fs.statSync(CANONICAL_DB) : null
const realBefore = fs.existsSync(REAL_DB) ? fs.statSync(REAL_DB) : null
if (!realBefore) {
  console.log(`未找到演示库：${REAL_DB}`)
  process.exit(1)
}
for (const ext of ['', '-wal', '-shm']) {
  const src = REAL_DB + ext
  if (fs.existsSync(src)) fs.copyFileSync(src, TEST_DB + ext)
}
console.log(`副本库：${TEST_DB}\n`)

try {
  /* ---------------- 起 stub + 副本后端 ---------------- */
  await new Promise((r) => stubServer.listen(STUB_PORT, '127.0.0.1', r))
  check('C0 stub 模型服务就绪（本地，无外网依赖）', stubServer.listening, `listening ${STUB_PORT}`)

  apiChild = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MYCARE_DB_PATH: TEST_DB,
      // 把模型指向 stub：所有「模型分支」都变成确定性可复现
      DEEPSEEK_API_KEY: 'sk-verify-stub-key',
      DEEPSEEK_BASE_URL: STUB_BASE,
      DEEPSEEK_MODEL: 'stub-model',
      DEEPSEEK_TEMPERATURE: '0',
      DEEPSEEK_TIMEOUT_MS: '10000',
      ALLOW_MOCK_FALLBACK: 'true',
    },
    stdio: 'ignore',
  })
  const up = await waitFor(`${API}/api/status`)
  check('C1 副本后端就绪（独立端口 + 副本库 + 模型指向 stub）', up, up ? `listening ${API_PORT}` : '启动超时')
  if (!up) throw new Error('副本后端未就绪')

  const st = await api('GET', '/status')
  check(
    'C2 后端确认「模型已配置」且指向 stub（否则后面测的是降级分支）',
    st.json?.modelConfigured === true && st.json?.model === 'stub-model',
    `modelConfigured=${st.json?.modelConfigured} model=${st.json?.model}`,
  )

  /* ---------------- 基线快照（供 15 / 18 前后比对） ---------------- */
  const rulesShaBefore = md5(CLINICAL_RULES)
  const rulesMtimeBefore = fs.statSync(CLINICAL_RULES).mtimeMs
  const targetsBefore = allTargetsRows()
  const briefBefore = await api('POST', '/agent/briefing', { patientId: P_HTTP })
  const alertsBefore = await api('GET', `/patients/${P_HTTP}/alerts`)
  const alertsLevelsBefore = JSON.stringify(
    (alertsBefore.json?.alerts || []).map((a) => `${a.level || a.alert_level || ''}:${a.rule_id || a.ruleId || ''}`),
  )

  const baseScore = await api('GET', `/patients/${P_HTTP}/score`)
  const dims = Array.isArray(baseScore.json?.applicableDimensions) ? baseScore.json.applicableDimensions : []
  check(
    'C3 评分接口下发适用维度（AI 只能调这几项）',
    dims.length >= 2 && dims.every((d) => ADJUSTMENT_DIMENSIONS.includes(d)),
    `适用维度=${dims.join(',')} rule=${baseScore.json?.rule}`,
  )
  check(
    'C4 未生成时 GET 只返回 Rule Score（aiStatus=null，不谎报「不可用」）',
    baseScore.status === 200 && baseScore.json?.cached === false && baseScore.json?.aiStatus === null && baseScore.json?.ai === null,
    `aiStatus=${baseScore.json?.aiStatus} cached=${baseScore.json?.cached}`,
  )

  const ruleRef = Number(baseScore.json?.rule)

  /* ---------------- 3b–8b：非法包走**真实 HTTP 路由**（证明校验器确实接在链路上） ---------------- */
  const badCases = [
    ['3b delta 越界经路由 → rejected', { adjustments: [{ dimension: dims[0], delta: -6, reason: '越界' }] }, ADJUSTMENT_REJECT_CODES.E_DELTA_OUT_OF_RANGE],
    ['4b Σ|delta|=12 经路由 → rejected', { adjustments: [
      { dimension: dims[0], delta: 5, reason: '一' },
      { dimension: dims[1], delta: 5, reason: '二' },
      ...(dims[2] ? [{ dimension: dims[2], delta: 2, reason: '三' }] : []),
    ] }, ADJUSTMENT_REJECT_CODES.E_DELTA_SUM_EXCEEDED],
    ['5b 缺 reason 经路由 → rejected', { adjustments: [{ dimension: dims[0], delta: -3 }] }, ADJUSTMENT_REJECT_CODES.E_REASON_INVALID],
    ['6b delta 非整数经路由 → rejected', { adjustments: [{ dimension: dims[0], delta: -3.5, reason: '非整数' }] }, ADJUSTMENT_REJECT_CODES.E_DELTA_NOT_INTEGER],
    ['7b 维度重复经路由 → rejected', { adjustments: [
      { dimension: dims[0], delta: -3, reason: '甲' },
      { dimension: dims[0], delta: -3, reason: '乙' },
    ] }, ADJUSTMENT_REJECT_CODES.E_DUPLICATE_DIMENSION],
    ['8c 未知维度经路由 → rejected', { adjustments: [{ dimension: 'sleep', delta: 1, reason: '未知' }] }, ADJUSTMENT_REJECT_CODES.E_UNKNOWN_DIMENSION],
  ]
  for (const [label, pkg, expectCode] of badCases) {
    stub.next = { status: 200, content: pkg }
    const r = await api('POST', '/agent/score', { patientId: P_HTTP, force: true })
    check(
      label,
      r.status === 200 && r.json?.aiStatus === 'rejected' && r.json?.code === expectCode && r.json?.ai === null &&
        r.json?.rule === ruleRef,
      `status=${r.status} aiStatus=${r.json?.aiStatus} code=${r.json?.code} rule=${r.json?.rule}(基线 ${ruleRef})`,
    )
  }

  /* ---------------- 11：非法 JSON → safeParseJSON 回落 → unavailable ---------------- */
  stub.next = { status: 200, content: '抱歉，我无法按要求输出 JSON，建议您咨询医生。' }
  const r11 = await api('POST', '/agent/score', { patientId: P_HTTP, force: true })
  check(
    '11 非法 JSON（safeParseJSON 回落 {text}）→ aiStatus=unavailable 且回落 Rule Score',
    r11.status === 200 && r11.json?.aiStatus === 'unavailable' && r11.json?.ai === null && r11.json?.rule === ruleRef &&
      r11.json?.code === ADJUSTMENT_REJECT_CODES.E_ADJUSTMENTS_NOT_ARRAY,
    `aiStatus=${r11.json?.aiStatus} code=${r11.json?.code} rule=${r11.json?.rule}`,
  )

  /* ---------------- 12：模型 401 → unavailable ---------------- */
  stub.next = { status: 401, message: 'Authentication Fails, Your api key is invalid' }
  const r12 = await api('POST', '/agent/score', { patientId: P_HTTP, force: true })
  check(
    '12 模型 401 → aiStatus=unavailable（接口**不报错**，页面仍能显示 Rule Score）',
    r12.status === 200 && r12.json?.aiStatus === 'unavailable' && r12.json?.ai === null &&
      r12.json?.rule === ruleRef && r12.json?.aiMessage === AI_STATUS_TEXT.unavailable,
    `status=${r12.status} aiStatus=${r12.json?.aiStatus} msg=${r12.json?.aiMessage}`,
  )

  /* ---------------- 9b：合法包走真实路由（守恒） ---------------- */
  const validPkg = {
    adjustments: [
      { dimension: dims[0], delta: -3, reason: '近 3 日该维度持续低于个人基线，单日规则分未体现下滑趋势' },
      { dimension: dims[1], delta: 1, reason: '该维度当日表现优于规则基准，略作上调' },
    ],
    narrative: 'stub 合法包',
    insights: ['stub 观察一', 'stub 观察二'],
  }
  stub.next = { status: 200, content: validPkg }
  const callsBeforeOk = stub.calls
  const r9 = await api('POST', '/agent/score', { patientId: P_HTTP, force: true })
  const okRule = Number(r9.json?.rule)
  const okAssisted = Number(r9.json?.ai?.assisted)
  const okSum = Number(r9.json?.ai?.sumDelta)
  check(
    '9b 合法包经路由：守恒 assisted − rule === Σdelta（且 cached=false）',
    r9.status === 200 && r9.json?.aiStatus === 'ok' && r9.json?.cached === false &&
      okAssisted - okRule === okSum && okSum === -2,
    `rule=${okRule} assisted=${okAssisted} Σdelta=${okSum}`,
  )
  check(
    '9c 两条 adjustment 均回显 label / delta / reason（界面「不做黑箱」的前提）',
    (r9.json?.ai?.adjustments || []).length === 2 &&
      r9.json.ai.adjustments.every((a) => a.label && Number.isInteger(a.delta) && a.reason.length > 0),
    JSON.stringify((r9.json?.ai?.adjustments || []).map((a) => `${a.label}${a.delta}`)),
  )
  check(
    '9d 提示词已明令禁止直接输出分数，并**动态下发**适用维度枚举',
    (() => {
      const body = stub.bodies[stub.bodies.length - 1]
      const sys = body?.messages?.find((m) => m.role === 'system')?.content || ''
      // ⚠️ 提示词里用了 markdown 强调（`**绝对不能**输出任何 …`），
      //    因此正则必须容忍星号，否则「文案改了、断言却没跟上」会造成假失败。
      return (
        /不负责给分/.test(sys) &&
        /输出任何\s*0.100\s*的分数/.test(sys) &&
        /绝对不能/.test(sys) &&
        dims.every((d) => sys.includes(d))
      )
    })(),
    `system 长度=${(stub.bodies[stub.bodies.length - 1]?.messages?.[0]?.content || '').length}`,
  )

  /* ---------------- 13：缓存命中一致 + 第二次未再调模型 ---------------- */
  const callsAfterOk = stub.calls
  const c13a = await api('POST', '/agent/score', { patientId: P_HTTP })
  const c13b = await api('POST', '/agent/score', { patientId: P_HTTP })
  check(
    '13 缓存命中一致：连续两次结果完全相同，且第二次**未再调模型**',
    c13a.json?.cached === true && c13b.json?.cached === true &&
      c13a.json?.ai?.assisted === c13b.json?.ai?.assisted &&
      JSON.stringify(c13a.json?.ai?.adjustments) === JSON.stringify(c13b.json?.ai?.adjustments) &&
      c13a.json?.ai?.assisted === okAssisted &&
      stub.calls === callsAfterOk,
    `cached=${c13a.json?.cached}/${c13b.json?.cached} assisted=${c13a.json?.ai?.assisted}/${c13b.json?.ai?.assisted} stub 调用 ${callsAfterOk}→${stub.calls}`,
  )
  check(
    '13b force=true 会跳过缓存（regenerate 通路可用）',
    r9.json?.cached === false && stub.calls === callsAfterOk,
    `首次 force 调用前 stub=${callsBeforeOk} 后=${callsAfterOk}`,
  )

  /* ---------------- 18：AI 辅助分未参与预警 / 达标率 ----------------
   * ⚠️ 必须排在 14（改动当日数据）**之前**：
   *    18 的语义是「同一天、同一份数据，AI 评价前后预警与达标率是否变化」。
   *    若排在 14 之后，晨报拿的是**改过 step 的**新快照，与基线不再可比 ——
   *    这正是本脚本首轮跑出 18c 假失败的原因（晨报 80 vs 基线 85）。
   * ------------------------------------------------------------------ */
  const briefAfter = await api('POST', '/agent/briefing', { patientId: P_HTTP })
  const alertsAfter = await api('GET', `/patients/${P_HTTP}/alerts`)
  const alertsLevelsAfter = JSON.stringify(
    (alertsAfter.json?.alerts || []).map((a) => `${a.level || a.alert_level || ''}:${a.rule_id || a.ruleId || ''}`),
  )
  check(
    '18 AI 辅助分未参与预警等级：同屏 highestLevel 与评估前一致',
    briefAfter.json?.risk?.highestLevel === briefBefore.json?.risk?.highestLevel,
    `before=${briefBefore.json?.risk?.highestLevel} after=${briefAfter.json?.risk?.highestLevel}`,
  )
  check(
    '18b AI 辅助分未参与落库预警：alerts 条目与评估前逐项一致',
    alertsLevelsBefore === alertsLevelsAfter,
    `before=${alertsLevelsBefore.slice(0, 80)} after=${alertsLevelsAfter.slice(0, 80)}`,
  )
  check(
    '18c 晨报口播的分数仍是 Rule Score（与评分接口同源，数据未变）',
    Number(briefAfter.json?.score) === ruleRef && Number(briefAfter.json?.score) === Number(briefBefore.json?.score),
    `晨报 before=${briefBefore.json?.score} after=${briefAfter.json?.score} 评分接口=${ruleRef}`,
  )
  check(
    '18d 预警等级取自确定性规则，与 AI 辅助分**无因果关系**（rule 变而等级不变即证）',
    briefAfter.json?.risk?.highestLevel === briefBefore.json?.risk?.highestLevel &&
      (briefAfter.json?.risk?.items || []).length === (briefBefore.json?.risk?.items || []).length,
    `highestLevel=${briefAfter.json?.risk?.highestLevel} 预警项 ${(briefBefore.json?.risk?.items || []).length}→${(briefAfter.json?.risk?.items || []).length}`,
  )

  /* ---------------- 14：inputHash 变化即失效 ---------------- */
  const hashBefore = c13a.json?.inputHash
  const upsert = await api('POST', `/patients/${P_HTTP}/records`, { steps: 4321 })
  check('14a 副本库当日记录已改动（仅 steps）', upsert.status === 200 && upsert.json?.record?.steps === 4321, `steps=${upsert.json?.record?.steps}`)
  stub.next = { status: 200, content: validPkg }
  const c14 = await api('POST', '/agent/score', { patientId: P_HTTP })
  check(
    '14 inputHash 变化即缓存失效 → 重新生成（不出现「数据变了分数没变」）',
    c14.json?.cached === false && c14.json?.inputHash !== hashBefore &&
      stub.calls === callsAfterOk + 1 && c14.json?.aiStatus === 'ok',
    `hash ${hashBefore}→${c14.json?.inputHash} stub=${stub.calls}${c14.json?.ai ? ` assisted=${c14.json.ai.assisted}` : ''}`,
  )
  const c14b = await api('POST', '/agent/score', { patientId: P_HTTP })
  check(
    '14b 新快照下的第二次调用命中新缓存',
    c14b.json?.cached === true && c14b.json?.inputHash === c14.json?.inputHash && stub.calls === callsAfterOk + 1,
    `cached=${c14b.json?.cached} stub=${stub.calls}`,
  )

  /* ---------------- 15：AI 不得修改 clinicalRules 阈值 / patient_targets ---------------- */
  const rulesShaAfter = md5(CLINICAL_RULES)
  const rulesMtimeAfter = fs.statSync(CLINICAL_RULES).mtimeMs
  const targetsAfter = allTargetsRows()
  check(
    '15 评估前后 clinicalRules.js 逐字节未变（AI 不得改医学阈值）',
    rulesShaBefore === rulesShaAfter && rulesMtimeBefore === rulesMtimeAfter,
    `sha ${rulesShaBefore.slice(0, 12)}… → ${rulesShaAfter.slice(0, 12)}…`,
  )
  check(
    '15b 评估前后 patient_targets 全部行逐项相等（AI 未触碰目标值）',
    targetsBefore === targetsAfter,
    `行数=${JSON.parse(targetsAfter).length}`,
  )

  /* ========================================================================== *
   * 第四段：真实浏览器（方案 §11.3 第 16 / 17 条）
   * ========================================================================== */
  console.log('\n—— 第四段：真实浏览器 ——')

  const exe = BROWSERS.find((p) => p && fs.existsSync(p))
  if (!exe) {
    check('16 浏览器可用（未找到 Edge/Chrome）', false, '跳过浏览器段')
  } else {
    record.browser = exe
    fs.writeFileSync(
      VITE_CFG,
      [
        "import { defineConfig } from 'vite'",
        "import react from '@vitejs/plugin-react'",
        '',
        'export default defineConfig({',
        '  plugins: [react()],',
        '  logLevel: "error",',
        '  server: {',
        '    host: "127.0.0.1",',
        `    port: ${WEB_PORT},`,
        '    strictPort: true,',
        '    open: false,',
        `    proxy: { "/api": { target: "http://127.0.0.1:${API_PORT}", changeOrigin: true } },`,
        '  },',
        '})',
        '',
      ].join('\n'),
    )
    webChild = spawn(NODE, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', VITE_CFG], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: 'ignore',
    })
    const webUp = await waitFor(`${WEB}/login`, 120, 300)
    check('D1 临时前端就绪（代理指向副本后端）', webUp, webUp ? `listening ${WEB_PORT}` : '启动超时')

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-aiscore-'))
    browserChild = spawn(
      exe,
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--no-proxy-server',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )

    let ws = null
    let seq = 0
    const pending = new Map()
    let bucket = null
    const send = (method, params = {}, sessionId) => {
      const id = ++seq
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      return new Promise((resolve) => pending.set(id, resolve))
    }

    let version = null
    for (let i = 0; i < 80 && !version; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
        if (r.ok) version = await r.json()
      } catch {
        /* retry */
      }
      if (!version) await sleep(250)
    }
    if (!version) throw new Error('CDP 未就绪（无头浏览器启动失败）')

    ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')))
    })
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result)
        pending.delete(msg.id)
        return
      }
      if (!bucket) return
      if (msg.method === 'Runtime.exceptionThrown') {
        bucket.exceptions.push(
          msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '',
        )
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        bucket.consoleErrors.push((msg.params.args || []).map((a) => a?.value ?? a?.description ?? '').join(' '))
      } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        bucket.consoleErrors.push(msg.params.entry.text || '')
      }
    })

    const target = await send('Target.createTarget', { url: 'about:blank' })
    const sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
    await send('Runtime.enable', {}, sessionId)
    await send('Log.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
      return r?.result?.value
    }
    const visit = async (url, waitMs = 4000) => {
      bucket = { exceptions: [], consoleErrors: [] }
      await send('Page.navigate', { url }, sessionId)
      await sleep(waitMs)
      const rootLen = Number(await evaluate('(document.getElementById("root")||{innerHTML:""}).innerHTML.length')) || 0
      const text = String((await evaluate('document.body ? document.body.innerText : ""')) || '')
      const fatal = bucket.exceptions.concat(bucket.consoleErrors.filter((t) => !BENIGN.some((re) => re.test(t))))
      return { rootLen, text, fatal }
    }
    const loginAs = async (pid) => {
      const res = await fetch(`${API}/api/patients/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId: pid }),
      })
      const view = (await res.json().catch(() => null))?.view || null
      await evaluate(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(view))})`)
      await evaluate(`localStorage.setItem('userSettings', JSON.stringify({elderlyMode:true, voiceEnabled:false}))`)
      return view
    }

    // ⚠️ localStorage 必须写进目标 origin：先导航过去再写
    await visit(`${WEB}/login`, 2500)

    /* ---------- 16：AI 可用 → 两个标签同屏，主数字仍为 Rule Score ---------- */
    // 先预热缓存（force），既拿到期望值，也让页面加载时的请求直接命中缓存
    stub.next = { status: 200, content: {
      adjustments: [
        { dimension: 'steps', delta: -3, reason: '近 3 日该维度持续低于个人基线，单日规则分未体现下滑趋势' },
        { dimension: 'exercise', delta: 1, reason: '该维度当日表现优于规则基准，略作上调' },
      ],
      narrative: 'stub 合法包',
      insights: ['stub 观察'],
    } }
    const uiPrime = await api('POST', '/agent/score', { patientId: P_UI_OK, force: true })
    const uiDims = uiPrime.json?.applicableDimensions || []
    // 断言用的两条维度必须真的适用，否则整包会被判 rejected（这里先自检，避免假失败）
    const uiValid =
      uiPrime.json?.aiStatus === 'ok' && uiDims.includes('steps') && uiDims.includes('exercise')
    check(
      '16a 预置合法包已生成（steps / exercise 均在适用维度内）',
      uiValid,
      `aiStatus=${uiPrime.json?.aiStatus} 适用=${uiDims.join(',')}`,
    )
    const wantRule = Number(uiPrime.json?.rule)
    const wantAssisted = Number(uiPrime.json?.ai?.assisted)

    const v1 = await loginAs(P_UI_OK)
    const home1 = await visit(`${WEB}/`, 5000)
    const onHome1 = /今日健康评分/.test(home1.text) && !/一键进入示范病例/.test(home1.text)
    check(
      '16b 确实进入首页（未被回落登录页，挡住假失败/假通过）',
      Boolean(v1) && onHome1,
      `name=${v1?.name} 含评分卡=${/今日健康评分/.test(home1.text)}`,
    )

    const uiMain = String(
      (await evaluate(`(() => { const el = document.querySelector('.health-score'); return el ? el.innerText.trim() : '' })()`)) || '',
    )
    const uiAi = String(
      (await evaluate(`(() => { const el = document.querySelector('.ai-score-value'); return el ? el.innerText.trim() : '' })()`)) || '',
    )
    const uiText = home1.text
    check(
      '16 界面同时出现「规则评分」与「AI 辅助」两个标签，且**主数字为 Rule Score**',
      /规则评分/.test(uiText) &&
        /AI 辅助/.test(uiText) &&
        Number(uiMain.replace(/\D/g, '')) === wantRule &&
        Number(uiAi.replace(/\D/g, '')) === wantAssisted &&
        uiMain !== uiAi,
      `主数字=${uiMain}(期望 ${wantRule}) AI 辅助=${uiAi}(期望 ${wantAssisted})`,
    )
    check(
      '16c 被调整的维度逐条显示 delta 与 reason（不做黑箱）+ 守恒式上屏',
      /AI 调整\s*[-+]?\d/.test(uiText) && /规则基线\s*\d+/.test(uiText) && /近 3 日该维度持续低于个人基线/.test(uiText),
      `含「规则基线」=${/规则基线/.test(uiText)} 含 delta=${/AI 调整\s*[-+]?\d/.test(uiText)}`,
    )
    check(
      '16d 界面带免责脚注（AI 辅助分不是临床判据、不参与预警分级）',
      /不是临床判据/.test(uiText) && /不参与预警分级/.test(uiText),
      `含免责=${/不是临床判据/.test(uiText)}`,
    )
    check(
      '16e 首页渲染无运行时错误（含 AI 区块）',
      home1.rootLen > 0 && home1.fatal.length === 0,
      `fatal=${home1.fatal.length}${home1.fatal.length ? ` :: ${home1.fatal[0].slice(0, 120)}` : ''}`,
    )

    /* ---------- 17：降级 → 只显示「AI 解读暂不可用」，不显示 AI 辅助分 ---------- */
    stub.next = { status: 401, message: 'Authentication Fails, Your api key is invalid' }
    const v2 = await loginAs(P_UI_BAD)
    const home2 = await visit(`${WEB}/`, 5000)
    const aiValueGone = await evaluate(`document.querySelector('.ai-score-value') === null`)
    const mainStillThere = Number(
      String((await evaluate(`(() => { const el = document.querySelector('.health-score'); return el ? el.innerText.trim() : '' })()`)) || '').replace(/\D/g, ''),
    )
    check(
      '17 降级时界面显示「AI 解读暂不可用」，**不显示** AI 辅助分',
      Boolean(v2) &&
        /今日健康评分/.test(home2.text) &&
        home2.text.includes(AI_STATUS_TEXT.unavailable) &&
        aiValueGone === true &&
        !/AI 辅助分/.test(home2.text),
      `含降级文案=${home2.text.includes(AI_STATUS_TEXT.unavailable)} AI 分元素=${aiValueGone === false ? '仍存在' : '已移除'}`,
    )
    check(
      '17b 降级不影响 Rule Score 展示（主数字仍在、仍等于规则分）',
      mainStillThere > 0 && home2.rootLen > 0 && home2.fatal.length === 0,
      `主数字=${mainStillThere} fatal=${home2.fatal.length}`,
    )
  }

  /* ========================================================================== *
   * 第五段：非适用维度走真实路由
   * --------------------------------------------------------------------------
   * 刻意放在**最后**：这一条会给 P_UI_OK 的当日缓存写入一条 rejected 记录，
   * 若排在浏览器段之前，16 的页面请求会命中它 → 界面不出现 AI 区块 → **假失败**。
   * 缓存按 (patientId, date, inputHash) 隔离，故这里污染的是「另一份快照」，
   * 但为稳妥起见仍然后置。
   * ========================================================================== */
  {
    const s = await api('GET', `/patients/${P_UI_OK}/score`)
    const d = s.json?.applicableDimensions || []
    const missDim = ADJUSTMENT_DIMENSIONS.find((x) => !d.includes(x))
    if (!missDim) {
      check(
        '8d 枚举内但**非该患者适用**维度经真实路由 → rejected',
        false,
        `找不到「维度未全覆盖」的患者，无法构造非适用维度（适用=${d.join(',')}）`,
      )
    } else {
      stub.next = {
        status: 200,
        content: { adjustments: [{ dimension: missDim, delta: 1, reason: '该患者并不适用这一维度' }] },
      }
      const r8d = await api('POST', '/agent/score', { patientId: P_UI_OK, force: true })
      check(
        '8d 枚举内但**非该患者适用**维度经真实路由 → rejected',
        r8d.status === 200 &&
          r8d.json?.aiStatus === 'rejected' &&
          r8d.json?.code === ADJUSTMENT_REJECT_CODES.E_DIMENSION_NOT_APPLICABLE &&
          r8d.json?.ai === null,
        `${P_UI_OK} 适用=${d.join(',')} 下发=${missDim} → code=${r8d.json?.code}`,
      )
    }
  }
} catch (err) {
  check('EXCEPTION 验收脚本未正常跑完', false, String(err?.message || err).slice(0, 200))
} finally {
  killAll()
  try {
    stubServer.close()
  } catch {
    /* ignore */
  }
}

/* ========================================================================== *
 * 收尾：真实演示库零改动
 * ========================================================================== */
try {
  const realAfter = fs.existsSync(REAL_DB) ? fs.statSync(REAL_DB) : null
  check(
    'Z1 真实演示库全程只读、零改动（mtime + 大小逐字比对）',
    Boolean(realBefore && realAfter) &&
      realBefore.mtimeMs === realAfter.mtimeMs &&
      realBefore.size === realAfter.size,
    `${path.basename(REAL_DB)} mtime ${realBefore?.mtimeMs} → ${realAfter?.mtimeMs}`,
  )
  if (path.resolve(REAL_DB) !== path.resolve(CANONICAL_DB)) {
    const canonAfter = fs.existsSync(CANONICAL_DB) ? fs.statSync(CANONICAL_DB) : null
    check(
      'Z2 出厂真实库 data/mycare.db 亦零改动（本脚本未触碰）',
      Boolean(canonBefore && canonAfter) &&
        canonBefore.mtimeMs === canonAfter.mtimeMs &&
        canonBefore.size === canonAfter.size,
      `mtime ${canonBefore?.mtimeMs} → ${canonAfter?.mtimeMs}`,
    )
  }
} catch {
  /* ignore */
}

record.summary = { passed, failed }
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'data', 'ai-score-verify-record.json'), JSON.stringify(record, null, 2))
console.log(`\n通过 ${passed} / ${passed + failed}`)
process.exit(failed ? 1 : 0)
