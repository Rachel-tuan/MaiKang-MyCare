/**
 * 迈康 MyCare · 「评分基准日」修复验收（Step 11 · 第 4 轮）
 * ===========================================================================
 * 缺陷现场（用户实测）：首页写着「今日健康评分 67」，分项里「步数 10,333 步 30/30」，
 * 而同屏的「今日任务」却是「步数目标 0/8,000 步 0%」。
 *
 * 根因：**两条链路对「今天」的定义不同**。
 *   · 评分链路（前端 `getTodayData()` / 服务端 `tools.computeHealthScore()` /
 *     `aiScoreService.buildScoreSnapshot()`）取的是**记录窗口内日期最大的一行**
 *     —— 今天还没录入时，它把昨天（2026-09-15）当成「今日」；
 *   · 今日任务链路（`patientService.getDailyTasks()`）取的是**真实今天**（`todayCST()`）。
 * 后果不只是「数字不同步」：今天未录入的维度被历史值顶上，**白送满分**
 * —— 这正是红线 10「缺测不得当达标」的同类缺陷。
 *
 * 修复口径（本轮约定）：**评分基准日恒为真实今天（东八区）**，与今日任务同源。
 * 今日无记录 → 以空对象计分 → 适用维度全部 `status: 'missing'`、按 0 分计入分母。
 *
 * 本脚本验证：
 *   段 1  纯函数 `computeHealthScore`：今日有 / 今日无 / 完全无记录 三态 + 真值来自今日行
 *   段 2  服务端晨报 `/api/agent/briefing`（无模型调用，确定性）
 *   段 3  AI 评分快照 `buildScoreSnapshot`（直调，**不触发模型**）—— 用户原话的正面断言
 *   段 4  **反事实**：把今日行作废（`record_status='void'`）→ 分数归 0 且不再回落到昨天
 *   段 5  对照：算出「旧口径」会给出的分数，证明两者确有差异（不是巧合相等）
 *
 * 约定：
 *   · **在副本库上运行**（默认以 data/mycare-demo.db 为基做副本，两个真实库全程零改动）；
 *   · **不触发任何模型调用**（`/api/agent/score` 会请模型，故只直调快照函数）；
 *   · 不改任何断言去迁就实现；失败就是失败。
 *
 * 运行：node scripts/db/verify-score-basedate.mjs
 * 产物：data/score-basedate-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const NODE = process.execPath
const PORT = 3063
const BASE = `http://127.0.0.1:${PORT}`

/* ------------------------------ 日期口径 ------------------------------ */
/** 东八区「今天」—— 与 src/contexts/HealthDataContext.jsx 的 cstToday() 同算法 */
const cstToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
const addDays = (dateStr, delta) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + delta)
  return t.toISOString().slice(0, 10)
}

const TODAY = cstToday()
const YESTERDAY = addDays(TODAY, -1)

/* ---------- 夹具：复刻用户截图那一刻的数据形态（patient_1 昨天 10333 步） ---------- */
const FIX = {
  patient_1: {
    yesterday: { steps: 10333, sys: null, dia: null, fg: null, ex: 60, status: 'corrected' },
    today: { steps: 5200, sys: 132, dia: 84, fg: 5.4, ex: 20, status: 'valid' },
  },
  patient_2: {
    yesterday: { steps: 6200, sys: null, dia: null, fg: 5.8, ex: 25, status: 'valid' },
    today: { steps: 8000, sys: null, dia: null, fg: 6.2, ex: 30, status: 'valid' },
  },
}

const DEMO_DB = path.join(ROOT, 'data', 'mycare-demo.db')
const MAIN_DB = path.join(ROOT, 'data', 'mycare.db')
const TEST_DB = path.join(ROOT, 'data', '_score-basedate.db')
const BASE_DB = fs.existsSync(DEMO_DB) ? DEMO_DB : MAIN_DB

const MAIN_MTIME_BEFORE = fs.existsSync(MAIN_DB) ? fs.statSync(MAIN_DB).mtimeMs : null
const DEMO_MTIME_BEFORE = fs.existsSync(DEMO_DB) ? fs.statSync(DEMO_DB).mtimeMs : null

// 先清掉上一轮可能残留的副本与 sidecar，再复制（⚠️ 不要在复制之后删，否则删的是刚复制出来的文件）
for (const p of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  try {
    fs.rmSync(p, { force: true })
  } catch {
    /* ignore */
  }
}
fs.copyFileSync(BASE_DB, TEST_DB)

/** ⚠️ server/data/db.js 的 DB_PATH 是模块级常量，import 时读 env → 必须先设再动态导入 */
process.env.MYCARE_DB_PATH = TEST_DB

/* ------------------------------ 断言框架 ------------------------------ */
const checks = {}
const facts = {}
let passed = 0
let failed = 0

function check(name, ok, detail) {
  checks[name] = { ok: Boolean(ok), detail }
  if (ok) passed += 1
  else failed += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ 夹具写入 ------------------------------ */
function writeFixture() {
  const db = new DatabaseSync(TEST_DB)
  const upsert = db.prepare(`
    INSERT INTO daily_health_records
      (patient_id, record_date, steps, systolic_pressure, diastolic_pressure, fasting_glucose,
       exercise_minutes, record_status, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
    ON CONFLICT(patient_id, record_date) DO UPDATE SET
      steps = excluded.steps,
      systolic_pressure = excluded.systolic_pressure,
      diastolic_pressure = excluded.diastolic_pressure,
      fasting_glucose = excluded.fasting_glucose,
      exercise_minutes = excluded.exercise_minutes,
      record_status = excluded.record_status,
      updated_at = excluded.updated_at
  `)

  for (const [pid, f] of Object.entries(FIX)) {
    for (const [day, row] of [
      [YESTERDAY, f.yesterday],
      [TODAY, f.today],
    ]) {
      upsert.run(
        pid, day, row.steps, row.sys, row.dia, row.fg, row.ex, row.status
      )
    }
  }
  db.close()
}

/** 把某患者「今天」那一行作废（模拟「今天还没录入」） */
function voidToday(pid) {
  const db = new DatabaseSync(TEST_DB)
  db.prepare(
    `UPDATE daily_health_records SET record_status='void'
      WHERE patient_id=? AND record_date=?`
  ).run(pid, TODAY)
  const n = db
    .prepare(
      `SELECT COUNT(*) c FROM daily_health_records
        WHERE patient_id=? AND record_date=? AND record_status<>'void'`
    )
    .get(pid, TODAY).c
  db.close()
  return n
}

function restoreToday(pid) {
  const db = new DatabaseSync(TEST_DB)
  db.prepare(
    `UPDATE daily_health_records SET record_status='valid'
      WHERE patient_id=? AND record_date=?`
  ).run(pid, TODAY)
  db.close()
}

/* ------------------------------ 服务端 ------------------------------ */
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

function startServer() {
  const child = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    // 刻意不给模型 Key：本脚本不需要模型，且必须保证零模型调用
    env: { ...process.env, PORT: String(PORT), MYCARE_DB_PATH: TEST_DB, DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/status`)
      if (r.status === 200) return true
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  return false
}

/* ================================ 主流程 ================================ */
const line = '─'.repeat(78)
console.log(line)
console.log('迈康 MyCare · 「评分基准日」修复验收')
console.log(line)
console.log(`基准库   : ${BASE_DB}`)
console.log(`评测副本 : ${TEST_DB}`)
console.log(`真实今天 : ${TODAY}（东八区）   昨天 : ${YESTERDAY}`)
console.log(line)

writeFixture()
console.log('· 夹具已写入副本库（patient_1 / patient_2 各补昨天 + 今天两行）')

let server = null
try {
  const { computeHealthScore } = await import('../../server/agents/tools.js')
  const { getPatientRecords } = await import('../../server/data/patientService.js')
  const { buildScoreSnapshot } = await import('../../server/data/aiScoreService.js')
  const { computeDailyHealthScore, gradeOf } = await import('../../src/utils/healthScore.js')

  const HBP = ['原发性高血压', '超重', '中心性肥胖']
  const DM = ['2 型糖尿病', '超重']

  /* ------------------ 段 1：纯函数 computeHealthScore ------------------ */
  console.log('\n—— 段 1：纯函数 computeHealthScore（基准日 = 真实今天）——')

  const histOnly = [
    {
      record_date: YESTERDAY,
      steps: FIX.patient_1.yesterday.steps,
      systolic_pressure: null,
      diastolic_pressure: null,
      blood_sugar: null,
      exercise_minutes: FIX.patient_1.yesterday.ex,
    },
  ]
  const todayRow = {
    record_date: TODAY,
    steps: FIX.patient_1.today.steps,
    systolic_pressure: FIX.patient_1.today.sys,
    diastolic_pressure: FIX.patient_1.today.dia,
    blood_sugar: FIX.patient_1.today.fg,
    exercise_minutes: FIX.patient_1.today.ex,
  }

  const noToday = computeHealthScore(histOnly, { disease_types: HBP })
  const withToday = computeHealthScore([...histOnly, todayRow], { disease_types: HBP })

  // 「旧口径」= 把窗口内最后一行当今日（修复前的行为），用于对照
  const legacyScore = computeDailyHealthScore({ today: histOnly[0], diseases: HBP }).score
  facts.legacyScore = legacyScore
  facts.noTodayScore = noToday.score
  facts.withTodayScore = withToday.score
  facts.applicableWeight = withToday.applicableWeight

  check(
    '1.1 今日无记录时得 0 分（不再拿昨天的 10333 步顶上去）',
    noToday.score === 0,
    `score=${noToday.score}（旧口径会给出 ${legacyScore}）`
  )
  check(
    '1.2 今日无记录时适用维度全部标 missing（步数 / 血压 / 运动）',
    noToday.missing.length === 3 &&
      ['步数', '血压', '运动'].every((l) => noToday.missing.includes(l)),
    `missing=[${noToday.missing.join('、')}]`
  )
  check(
    '1.3 新分 ≠ 旧口径分（确实改变了行为，不是巧合相等）',
    noToday.score !== legacyScore,
    `新=${noToday.score} 旧=${legacyScore}`
  )
  check(
    '1.4 今日有记录时，分数等于「用今日行算」的分数',
    withToday.score === computeDailyHealthScore({ today: todayRow, diseases: HBP }).score,
    `score=${withToday.score} 分母=${withToday.applicableWeight}`
  )
  check(
    '1.5 今日有记录时步数不再算缺测，且读到的是今天那行',
    !withToday.missing.includes('步数') &&
      withToday.breakdown.find((b) => b.label === '步数').basis.includes('5,200'),
    `basis=${withToday.breakdown.find((b) => b.label === '步数').basis}`
  )
  const todayStepsEarned = withToday.breakdown.find((b) => b.label === '步数').got
  const legacyStepsEarned = computeDailyHealthScore({
    today: histOnly[0],
    diseases: HBP,
  }).breakdown.find((b) => b.label === '步数').earned
  check(
    '1.6 今日行的步数（5200）低于昨天（10333），步数维度得分必须随之下降',
    todayStepsEarned < legacyStepsEarned,
    `今日步数得 ${todayStepsEarned} 分 / 旧口径（用 10333）得 ${legacyStepsEarned} 分`
  )
  check(
    '1.7 完全无记录时得 0 分且不抛异常',
    computeHealthScore([], { disease_types: HBP }).score === 0,
    `score=${computeHealthScore([], { disease_types: HBP }).score}`
  )
  check(
    '1.8 date 字段报告的是基准日（真实今天），不是历史行日期',
    noToday.date === TODAY && withToday.date === TODAY,
    `noToday.date=${noToday.date} withToday.date=${withToday.date}`
  )

  /* ------------------ 段 2：服务端数据链路（无模型调用） ------------------ */
  console.log('\n—— 段 2：服务端记录视图 + AI 评分快照 ——')

  server = startServer()
  const ready = await waitForServer()
  check('2.1 隔离后端在副本库上就绪', ready, `port=${PORT}`)

  const rec = await getPatientRecords('patient_1', 7)
  const viewRows = (rec.records || []).filter((r) => r && r.record_date)
  const viewToday = viewRows.find((r) => r.record_date === TODAY)
  const viewHist = viewRows.filter((r) => r.record_date < TODAY)

  check(
    '2.2 副本库记录里确实存在日期 = 真实今天的一行',
    Boolean(viewToday) && viewToday.steps === FIX.patient_1.today.steps,
    `今日行 steps=${viewToday?.steps} 历史行数=${viewHist.length}`
  )
  check(
    '2.3 视图层保留 blood_sugar 别名（血糖维度依赖它，不能被 D-1 修复误删）',
    viewToday?.blood_sugar === FIX.patient_1.today.fg,
    `blood_sugar=${viewToday?.blood_sugar}（DB 列 fasting_glucose=${viewToday?.fasting_glucose}）`
  )
  check(
    '2.4 历史行的步数（10333）仍完整保留，未被删除',
    viewHist.some((r) => r.steps === FIX.patient_1.yesterday.steps),
    `历史最后一行 ${viewHist[viewHist.length - 1]?.record_date} steps=${viewHist[viewHist.length - 1]?.steps}`
  )

  const snap = await buildScoreSnapshot('patient_1')
  facts.snapshotDate = snap.date
  facts.snapshotTodaySteps = snap.today?.steps
  facts.snapshotScore = snap.rule.score

  check(
    '2.5 **AI 快照的基准日 = 真实今天**（用户原话：「AI 读的评分是昨天的步数」）',
    snap.date === TODAY,
    `snapshot.date=${snap.date}`
  )
  check(
    '2.6 **AI 快照读到的当日体征就是今天那一行**，不是 09-15 的 10333',
    snap.today?.record_date === TODAY && snap.today?.steps === FIX.patient_1.today.steps,
    `today.record_date=${snap.today?.record_date} today.steps=${snap.today?.steps}`
  )
  check(
    '2.7 AI 快照的 Rule Score = 用今日行算的分',
    snap.rule.score === computeDailyHealthScore({ today: viewToday, diseases: HBP }).score,
    `snapshot.rule.score=${snap.rule.score}`
  )
  check(
    '2.8 AI 快照的最近 7 日窗口仍完整（历史没有被裁剪掉）',
    snap.recent.length >= 2 && snap.recent.some((r) => r.steps === FIX.patient_1.yesterday.steps),
    `recent=${snap.recent.length} 行`
  )

  const brief = await req('POST', '/api/agent/briefing', { patientId: 'patient_1' })
  check(
    '2.9 晨报接口返回 200',
    brief.status === 200,
    `status=${brief.status}`
  )
  check(
    '2.10 晨报分数 = 用今日行算的分（与前端 getTodayData() 同源）',
    brief.json?.score === computeDailyHealthScore({ today: viewToday, diseases: HBP }).score,
    `晨报=${brief.json?.score}`
  )
  check(
    '2.11 晨报分项里步数是今天的 5,200，不是昨天的 10,333',
    (brief.json?.breakdown || []).some(
      (b) => b.label === '步数' && String(b.basis).includes('5,200')
    ),
    `步数项=${JSON.stringify((brief.json?.breakdown || []).find((b) => b.label === '步数'))}`
  )
  check(
    '2.12 晨报档位与分数同源（gradeOf）',
    brief.json?.grade === gradeOf(brief.json?.score),
    `score=${brief.json?.score} grade=${brief.json?.grade}`
  )

  /* ------------------ 段 3：第二患者（血糖维度 / 别名依赖） ------------------ */
  console.log('\n—— 段 3：patient_2（糖尿病 → 适用维度含血糖）——')

  const snap2 = await buildScoreSnapshot('patient_2')
  const bd2 = snap2.rule.breakdown.find((b) => b.key === 'bloodGlucose')
  check(
    '3.1 patient_2 适用维度含血糖（糖尿病疾病谱）',
    Boolean(bd2),
    `维度=${snap2.rule.breakdown.map((b) => b.key).join('/')}`
  )
  check(
    '3.2 patient_2 的血糖读到今日 6.2，不是缺测（别名链路完整）',
    bd2 && bd2.status !== 'missing' && bd2.detail.includes('6.2'),
    `血糖项 detail=${bd2?.detail} status=${bd2?.status}`
  )
  check(
    '3.3 patient_2 AI 快照基准日同样是真实今天',
    snap2.date === TODAY && snap2.today?.record_date === TODAY,
    `date=${snap2.date} today.record_date=${snap2.today?.record_date}`
  )

  /* ------------------ 段 4：反事实（今日行作废） ------------------ */
  console.log('\n—— 段 4：反事实实验（把「今天」那一行作废 → 模拟今天还没录入）——')

  const remaining = voidToday('patient_1')
  check('4.1 今天那一行已作废（今日有效记录数 = 0）', remaining === 0, `remaining=${remaining}`)

  const snapVoid = await buildScoreSnapshot('patient_1')
  const briefVoid = await req('POST', '/api/agent/briefing', { patientId: 'patient_1' })

  facts.voidScore = snapVoid.rule.score
  facts.voidLegacyScore = legacyScore

  check(
    '4.2 今日无记录时 AI 快照的 today 为空对象（不回落历史行）',
    !snapVoid.today?.record_date,
    `today.record_date=${snapVoid.today?.record_date} keys=${Object.keys(snapVoid.today || {}).length}`
  )
  check(
    '4.3 **分数归 0**，而不是回落到昨天的 10333 步',
    snapVoid.rule.score === 0 && briefVoid.json?.score === 0,
    `snapshot=${snapVoid.rule.score} 晨报=${briefVoid.json?.score}（旧口径会是 ${legacyScore}）`
  )
  check(
    '4.4 适用维度全部标 missing（步数 / 血压 / 运动）',
    snapVoid.rule.missing.length === 3,
    `missing=[${snapVoid.rule.missing.join('、')}]`
  )
  check(
    '4.5 基准日不因「今天没数据」而漂移到昨天',
    snapVoid.date === TODAY,
    `date=${snapVoid.date}`
  )
  check(
    '4.6 历史数据仍在库里，只是不再被当成「今日」',
    snapVoid.recent.length >= 1 &&
      snapVoid.recent.some((r) => r.record_date === YESTERDAY && r.steps === 10333),
    `recent=${snapVoid.recent.length} 行，含 ${YESTERDAY}/${FIX.patient_1.yesterday.steps}`
  )
  check(
    '4.7 晨报的 7 天窗口指标（达标率等）不受影响，仍算出历史',
    (briefVoid.json?.indicators || []).length > 0,
    `indicators=${(briefVoid.json?.indicators || []).length} 项`
  )

  restoreToday('patient_1')
  const snapBack = await buildScoreSnapshot('patient_1')
  check(
    '4.8 恢复今日行后分数回到原值（可逆，无残留状态）',
    snapBack.rule.score === facts.withTodayScore && snapBack.date === TODAY,
    `恢复到 ${snapBack.rule.score}（原 ${facts.withTodayScore}）`
  )

  /* ------------------ 段 5：两个真实库零改动 ------------------ */
  console.log('\n—— 段 5：真实库零改动 ——')

  const mainMtimeAfter = fs.existsSync(MAIN_DB) ? fs.statSync(MAIN_DB).mtimeMs : null
  const demoMtimeAfter = fs.existsSync(DEMO_DB) ? fs.statSync(DEMO_DB).mtimeMs : null
  check(
    '5.1 主库 data/mycare.db 全程零改动',
    MAIN_MTIME_BEFORE === null || MAIN_MTIME_BEFORE === mainMtimeAfter,
    `mtime ${MAIN_MTIME_BEFORE} → ${mainMtimeAfter}`
  )
  check(
    '5.2 演示库 data/mycare-demo.db 全程零改动（只动了副本）',
    DEMO_MTIME_BEFORE === null || DEMO_MTIME_BEFORE === demoMtimeAfter,
    `mtime ${DEMO_MTIME_BEFORE} → ${demoMtimeAfter}`
  )
} catch (err) {
  console.log(`\n[EXCEPTION] ${err.message}`)
  check('EXCEPTION 未预期异常', false, err.stack?.split('\n').slice(0, 3).join(' | '))
} finally {
  if (server) {
    server.kill()
    await sleep(400)
  }
  console.log(line)
  console.log(`通过 ${passed} / ${passed + failed}`)
  console.log(line)

  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, 'data', 'score-basedate-verify-record.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        today: TODAY,
        baseDb: BASE_DB,
        testDb: TEST_DB,
        facts,
        checks,
        summary: { passed, failed },
      },
      null,
      2
    )
  )
  try {
    fs.rmSync(TEST_DB, { force: true })
    fs.rmSync(`${TEST_DB}-wal`, { force: true })
    fs.rmSync(`${TEST_DB}-shm`, { force: true })
  } catch {
    /* ignore */
  }
  // 用 exitCode 而非 process.exit()：后者可能截断尚未 flush 的 stdout
  process.exitCode = failed > 0 ? 1 : 0
}
