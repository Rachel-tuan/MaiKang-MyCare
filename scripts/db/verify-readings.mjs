/**
 * 迈康 MyCare · Step 9 验收（一）：一天多次测量「追加不覆盖」
 * ===========================================================================
 * 本脚本验证 Step 9 最核心的一条铁律：
 *   一次测量 = 一条 readings 事实记录；同一天可 N 条；**永不覆盖历史**；
 *   daily_health_records 只是日粒度「保守兼容代表值」，不是当日真实唯一测量值。
 *
 * 做法
 *   · 在**一次性副本库**上运行（从演示副本库复制），演示库/真实库全程只读；
 *   · 自起 Express 子进程（隔离端口），全部走真实 HTTP 接口；
 *   · 逐条 INSERT 后直接读 SQLite 校验行数与每一条的字段是否原样保留（不是只数行数）；
 *   · 覆盖血糖兼容值口径的两种情形：有空腹取空腹 / 无空腹取最高。
 *
 * 运行：node scripts/db/verify-readings.mjs
 * 前置：node scripts/db/reset-demo.mjs（生成 data/mycare-demo.db）
 * 产物：data/step9-readings-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const NODE = process.execPath
const PORT = 3051
const BASE = `http://127.0.0.1:${PORT}`

const DEMO_DB = path.resolve(process.env.MYCARE_DEMO_DB_PATH || path.join(ROOT, 'data', 'mycare-demo.db'))
const TEST_DB = path.join(ROOT, 'data', '_step9-readings.db')

if (!fs.existsSync(DEMO_DB)) {
  console.error(`❌ 未找到演示副本库：${DEMO_DB}\n   请先运行：node scripts/db/reset-demo.mjs`)
  process.exit(1)
}
fs.copyFileSync(DEMO_DB, TEST_DB)
process.env.MYCARE_DB_PATH = TEST_DB

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
const DATE = '2026-09-14'

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

function q(sql, ...p) {
  const db = new DatabaseSync(TEST_DB, { readOnly: true })
  try {
    return db.prepare(sql).all(...p)
  } finally {
    db.close()
  }
}
const one = (sql, ...p) => q(sql, ...p)[0] ?? null

function startServer() {
  const child = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MYCARE_DB_PATH: TEST_DB },
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

const rowKey = (r) => `${r.measured_at}|${r.systolic ?? '-'}/${r.diastolic ?? '-'}|${r.slot ?? '-'}`
const bgKey = (r) => `${r.measured_at}|${r.value}|${r.measure_type}`

async function main() {
  const server = startServer()
  const up = await waitForServer()
  const line = '─'.repeat(78)
  console.log(line)
  console.log('迈康 MyCare · Step 9 验收（一）：一天多次测量追加不覆盖')
  console.log(line)
  console.log(`副本库 : ${TEST_DB}`)
  console.log(line)

  try {
    check('S0 服务启动（隔离端口 + 副本库）', up, `listening on ${PORT}`)
    if (!up) throw new Error('服务未启动')

    /* ================= 1. 血压：同日 3 次追加 ================= */
    const bpInputs = [
      { time: '08:00', systolic: 150, diastolic: 92, slot: '晨起' },
      { time: '13:00', systolic: 158, diastolic: 96, slot: '下午' }, // UI 显示「午后」，落库为「下午」
      { time: '20:00', systolic: 162, diastolic: 98, slot: '睡前' },
    ]
    for (const r of bpInputs) {
      const res = await req('POST', '/api/patients/patient_1/readings', {
        kind: 'blood_pressure',
        date: DATE,
        time: r.time,
        systolic: r.systolic,
        diastolic: r.diastolic,
        slot: r.slot,
      })
      if (res.status !== 201 || !res.json?.reading?.readingId) {
        check(`1 血压第 ${r.time} 次追加成功`, false, `status=${res.status} body=${res.text.slice(0, 120)}`)
      }
    }

    let rows = q(
      `SELECT measured_at, systolic, diastolic, slot, record_status FROM blood_pressure_readings
        WHERE patient_id='patient_1' AND date(measured_at)=? ORDER BY measured_at`,
      DATE
    )
    samples.bpRows = rows
    check(
      '1 同日 3 次血压 = 3 条独立 readings（不是 UPSERT 成 1 条）',
      rows.length === 3,
      `rows=${rows.length}`
    )
    check(
      '2 三条原始测量逐条原样保留（150/92、158/96、162/98，时段正确）',
      rows.length === 3 &&
        rows[0].systolic === 150 && rows[0].diastolic === 92 && rows[0].slot === '晨起' &&
        rows[1].systolic === 158 && rows[1].diastolic === 96 && rows[1].slot === '下午' &&
        rows[2].systolic === 162 && rows[2].diastolic === 98 && rows[2].slot === '睡前',
      JSON.stringify(rows.map(rowKey))
    )
    check(
      '3 daily 兼容层仍为「一天一行」（readings 是事实层，不与日粒度混淆）',
      one(
        `SELECT COUNT(*) AS c FROM daily_health_records WHERE patient_id='patient_1' AND record_date=?`,
        DATE
      ).c === 1,
      `daily rows=${one(`SELECT COUNT(*) AS c FROM daily_health_records WHERE patient_id='patient_1' AND record_date=?`, DATE).c}`
    )
    const dailyAfter3 = one(
      `SELECT systolic_pressure, diastolic_pressure, record_status FROM daily_health_records
        WHERE patient_id='patient_1' AND record_date=?`,
      DATE
    )
    samples.dailyAfter3 = dailyAfter3
    check(
      '4 daily 兼容值 = 当日收缩压最大那一条（162/98），成对写入不跨条混搭',
      dailyAfter3?.systolic_pressure === 162 && dailyAfter3?.diastolic_pressure === 98,
      JSON.stringify(dailyAfter3)
    )

    /* ================= 2. 第 4 次追加：前 3 条不得被改动 ================= */
    const beforeKeys = rows.map(rowKey)
    const r4 = await req('POST', '/api/patients/patient_1/readings', {
      kind: 'blood_pressure',
      date: DATE,
      time: '22:00',
      systolic: 155,
      diastolic: 94,
      slot: '睡前',
    })
    rows = q(
      `SELECT measured_at, systolic, diastolic, slot FROM blood_pressure_readings
        WHERE patient_id='patient_1' AND date(measured_at)=? ORDER BY measured_at`,
      DATE
    )
    const afterKeys = rows.map(rowKey)
    samples.bpRowsAfter4 = rows
    check('5 第 4 次追加成功', r4.status === 201, `status=${r4.status}`)
    check('6 追加后共 4 条（第 4 次是新增，不是覆盖）', rows.length === 4, `rows=${rows.length}`)
    check(
      '7 前 3 条逐字段未被修改（按 measured_at + 值 + 时段逐条比对）',
      beforeKeys.every((k, i) => afterKeys[i] === k),
      `before=${beforeKeys.join(' | ')}  after=${afterKeys.slice(0, 3).join(' | ')}`
    )
    check(
      '8 daily 兼容值随峰值上移为 162（155 未超过峰值，保持 162/98）',
      one(`SELECT systolic_pressure AS s FROM daily_health_records WHERE patient_id='patient_1' AND record_date=?`, DATE)?.s === 162,
      `systolic=${one(`SELECT systolic_pressure AS s FROM daily_health_records WHERE patient_id='patient_1' AND record_date=?`, DATE)?.s}`
    )

    /* ================= 3. 生理校验：收缩压 ≤ 舒张压必须被拒 ================= */
    const bad = await req('POST', '/api/patients/patient_1/readings', {
      kind: 'blood_pressure',
      date: DATE,
      time: '23:00',
      systolic: 90,
      diastolic: 120,
    })
    check(
      '9 收缩压 ≤ 舒张压被拒（400 E_BP_INVERTED），不可能再产生 90/120 这类脏数据',
      bad.status === 400 && bad.json?.code === 'E_BP_INVERTED',
      `status=${bad.status} code=${bad.json?.code}`
    )
    check(
      '10 被拒的测量未落库（readings 仍 4 条）',
      q(`SELECT COUNT(*) AS c FROM blood_pressure_readings WHERE patient_id='patient_1' AND date(measured_at)=?`, DATE)[0].c === 4,
      `rows=${q(`SELECT COUNT(*) AS c FROM blood_pressure_readings WHERE patient_id='patient_1' AND date(measured_at)=?`, DATE)[0].c}`
    )

    /* ================= 4. 血糖：measure_type 必填 + 兼容值口径 ================= */
    const noType = await req('POST', '/api/patients/patient_1/readings', {
      kind: 'blood_glucose',
      date: DATE,
      time: '08:00',
      value: 7.1,
    })
    check(
      '11 血糖缺 measure_type 被拒（否则空腹/餐后语义会取错）',
      noType.status === 400 && noType.json?.code === 'E_INVALID_ARG',
      `status=${noType.status} code=${noType.json?.code}`
    )

    for (const g of [
      { time: '08:00', value: 7.1, measureType: '空腹' },
      { time: '14:00', value: 8.3, measureType: '餐后2h' },
      { time: '21:00', value: 7.8, measureType: '睡前' },
    ]) {
      await req('POST', '/api/patients/patient_1/readings', {
        kind: 'blood_glucose',
        date: DATE,
        time: g.time,
        value: g.value,
        measureType: g.measureType,
      })
    }
    const bgRows = q(
      `SELECT measured_at, value, measure_type FROM blood_glucose_readings
        WHERE patient_id='patient_1' AND date(measured_at)=? ORDER BY measured_at`,
      DATE
    )
    samples.bgRows = bgRows
    check('12 同日 3 次血糖 = 3 条，measure_type 各自正确', bgRows.length === 3 && bgRows.map((r) => r.measure_type).join(',') === '空腹,餐后2h,睡前', JSON.stringify(bgRows.map(bgKey)))
    check(
      '13 有「空腹」读数时，daily.fasting_glucose 取空腹值 7.1（字段语义优先）',
      one(`SELECT fasting_glucose AS v FROM daily_health_records WHERE patient_id='patient_1' AND record_date=?`, DATE)?.v === 7.1,
      `fasting_glucose=${one(`SELECT fasting_glucose AS v FROM daily_health_records WHERE patient_id='patient_1' AND record_date=?`, DATE)?.v}`
    )

    // 再加一条更高的「随机」值 —— 因为已有空腹，兼容值仍应保持空腹 7.1
    await req('POST', '/api/patients/patient_1/readings', {
      kind: 'blood_glucose', date: DATE, time: '16:00', value: 9.9, measureType: '随机',
    })
    check(
      '14 追加更高的「随机」读数后，兼容值仍取空腹 7.1（不被最高值顶掉）',
      one(`SELECT fasting_glucose AS v FROM daily_health_records WHERE patient_id='patient_1' AND record_date=?`, DATE)?.v === 7.1,
      `fasting_glucose=${one(`SELECT fasting_glucose AS v FROM daily_health_records WHERE patient_id='patient_1' AND record_date=?`, DATE)?.v}`
    )

    // 无空腹情形：patient_2 当日只有 餐后2h / 随机 → 取最高 8.8
    for (const g of [
      { time: '14:00', value: 8.8, measureType: '餐后2h' },
      { time: '16:00', value: 6.6, measureType: '随机' },
    ]) {
      await req('POST', '/api/patients/patient_2/readings', {
        kind: 'blood_glucose', date: DATE, time: g.time, value: g.value, measureType: g.measureType,
      })
    }
    check(
      '15 无「空腹」读数时兼容值取当日最高（patient_2 → 8.8），仅用于兼容旧日粒度规则',
      one(`SELECT fasting_glucose AS v FROM daily_health_records WHERE patient_id='patient_2' AND record_date=?`, DATE)?.v === 8.8,
      `fasting_glucose=${one(`SELECT fasting_glucose AS v FROM daily_health_records WHERE patient_id='patient_2' AND record_date=?`, DATE)?.v}`
    )

    /* ================= 5. 今日任务进度实时派生 ================= */
    const tasks = await req('GET', `/api/patients/patient_1/daily-tasks?date=${DATE}`)
    const bpTask = (tasks.json?.tasks || []).find((t) => t.taskId === 'bp_monitor')
    samples.bpTask = bpTask
    check(
      '16 今日任务进度由当天有效 readings 实时派生（血压 4 次 → done=4，target 由规则定）',
      tasks.status === 200 && bpTask && bpTask.actualCount === 4 && bpTask.done === Math.min(4, bpTask.target),
      `done=${bpTask?.done}/${bpTask?.target} actualCount=${bpTask?.actualCount}`
    )
    check(
      '17 今日任务里不存在任务进度表（进度不落库）',
      !q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('daily_tasks','task_progress')").length,
      `tables=${q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('daily_tasks','task_progress')").map((r) => r.name).join(',') || 'none'}`
    )
    check(
      '18 时段勾选状态与 readings 一致（晨起/午后/睡前 均已勾选）',
      bpTask?.slots?.filter((s) => s.done).length >= 3,
      JSON.stringify((bpTask?.slots || []).map((s) => `${s.label}:${s.done}`))
    )

    /* ================= 6. 事实层只增不减：总数校验 ================= */
    const totalBp = q(`SELECT COUNT(*) AS c FROM blood_pressure_readings WHERE patient_id='patient_1'`)[0].c
    check(
      '19 血压事实层累计 4 条（3 + 1，全部保留在库中）',
      totalBp === 4,
      `total blood_pressure_readings=${totalBp}`
    )

    /* ================= 7. 演示库 / 真实库零改动 ================= */
    const demoCount = (() => {
      const db = new DatabaseSync(DEMO_DB, { readOnly: true })
      try {
        return db.prepare('SELECT COUNT(*) AS c FROM blood_pressure_readings').get().c
      } finally {
        db.close()
      }
    })()
    check('20 演示副本库全程零改动（readings 仍为 0）', demoCount === 0, `demo readings=${demoCount}`)
  } catch (e) {
    check('EX 执行未抛异常', false, e.message)
  } finally {
    server.kill()
    await sleep(500)
  }

  console.log(line)
  console.log(`==== Step 9 验收（一）一天多次测量：${passed}/${passed + failed} 通过 ====`)
  console.log(line)

  fs.writeFileSync(
    path.join(ROOT, 'data', 'step9-readings-verify-record.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), db: TEST_DB, checks, samples, summary: { passed, failed, total: passed + failed, allPass: failed === 0 } },
      null,
      2
    ),
    'utf8'
  )
  try { fs.rmSync(TEST_DB, { force: true }) } catch { /* ignore */ }
  if (failed) process.exitCode = 1
}

main()
