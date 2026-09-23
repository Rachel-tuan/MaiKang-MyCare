/**
 * 迈康 MyCare · Step 9 验收（二）：动态今日任务
 * ===========================================================================
 * 验证「今日任务」不是硬编码，而是由**确定性规则**按患者疾病与近期状态生成：
 *   张建国（高血压）  → 血压监测
 *   李秀英（糖尿病）  → 血糖监测
 *   王建军（肥胖症）  → 体重管理 + 合并症低频关注（不出血压/血糖主任务）
 * 并验证：
 *   · 异常状态按确定性规则升频（2 次 → 3 次），次数来自常量，**AI 不得修改**；
 *   · 服药任务按 medications.time 把「一药多时段」拆成多个计划实例；
 *   · 任务进度由当天有效 readings / medication_logs 实时派生，**不落库**。
 *
 * 做法：一次性副本库 + 隔离端口子进程，全部走真实 HTTP 接口。
 * 运行：node scripts/db/verify-daily-tasks.mjs
 * 前置：node scripts/db/reset-demo.mjs
 * 产物：data/step9-tasks-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const NODE = process.execPath
const PORT = 3061
const BASE = `http://127.0.0.1:${PORT}`
/**
 * 验收基准日：**必须取运行当天（CST）**，不能写死。
 * ⚠️ 踩坑（2026-09-15 实测）：写死 '2026-09-14' 会在跨天后与「服务端今天」错位 ——
 *    升频用例写的是「基准日 -2 / -1 / 0」的连续 3 天异常血压，而 clinicalRules 的窗口锚在服务端今天，
 *    两者相差一天时「连续 3 天」就不成立 → 第 18/19 项**假失败**（target 停留 2 次、level 仍是 info），
 *    看起来像规则退化，其实只是基准日过期。
 */
const DATE = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

const DEMO_DB = path.resolve(process.env.MYCARE_DEMO_DB_PATH || path.join(ROOT, 'data', 'mycare-demo.db'))
const TEST_DB = path.join(ROOT, 'data', '_step9-tasks.db')

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

const q = (sql, ...p) => {
  const db = new DatabaseSync(TEST_DB, { readOnly: true })
  try {
    return db.prepare(sql).all(...p)
  } finally {
    db.close()
  }
}

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

const tasksOf = (payload) => payload?.tasks || []
const byId = (payload, id) => tasksOf(payload).find((t) => t.taskId === id)
const addDays = (d, n) => {
  const t = new Date(`${d}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

async function main() {
  const server = startServer()
  const up = await waitForServer()
  const line = '─'.repeat(78)
  console.log(line)
  console.log('迈康 MyCare · Step 9 验收（二）：动态今日任务')
  console.log(line)
  console.log(`副本库 : ${TEST_DB}`)
  console.log(line)

  try {
    check('S0 服务启动（隔离端口 + 副本库）', up, `listening on ${PORT}`)
    if (!up) throw new Error('服务未启动')

    /* ============ 1. 三位示范患者：任务随疾病谱不同 ============ */
    const t1 = await req('GET', `/api/patients/patient_1/daily-tasks?date=${DATE}`)
    const t2 = await req('GET', `/api/patients/patient_2/daily-tasks?date=${DATE}`)
    const t3 = await req('GET', `/api/patients/patient_3/daily-tasks?date=${DATE}`)
    samples.patient1 = tasksOf(t1.json).map((t) => ({ id: t.taskId, target: t.target, done: t.done, level: t.level }))
    samples.patient2 = tasksOf(t2.json).map((t) => ({ id: t.taskId, target: t.target, done: t.done }))
    samples.patient3 = tasksOf(t3.json).map((t) => ({ id: t.taskId, target: t.target, weekly: t.weekly }))

    const p1Bp = byId(t1.json, 'bp_monitor')
    check(
      '1 张建国（高血压）→ 出现「血压监测」任务，且次数由规则定（3 次，因血压域已达预警）',
      Boolean(p1Bp) && p1Bp.target === 3 && p1Bp.level === 'alert',
      `bp=${JSON.stringify({ target: p1Bp?.target, level: p1Bp?.level, reason: p1Bp?.reason })}`
    )
    check(
      '2 血压任务时段为 晨起 / 午后 / 睡前（UI 显示「午后」）',
      (p1Bp?.slots || []).map((s) => s.label).join(',') === '晨起,午后,睡前',
      `slots=${(p1Bp?.slots || []).map((s) => s.label).join(',')}`
    )
    check('3 张建国**没有**血糖主任务（疾病谱决定，不机械出现）', !byId(t1.json, 'bg_monitor'), `taskIds=${tasksOf(t1.json).map((t) => t.taskId).join(',')}`)

    const p2Bg = byId(t2.json, 'bg_monitor')
    check(
      '4 李秀英（糖尿病）→ 出现「血糖监测」任务（3 次，因血糖域已达预警）',
      Boolean(p2Bg) && p2Bg.target === 3,
      `bg=${JSON.stringify({ target: p2Bg?.target, slots: (p2Bg?.slots || []).map((s) => s.label) })}`
    )
    check('5 李秀英**没有**血压主任务', !byId(t2.json, 'bp_monitor'), `taskIds=${tasksOf(t2.json).map((t) => t.taskId).join(',')}`)

    const p3Wt = byId(t3.json, 'weight_record')
    check(
      '6 王建军（肥胖症）→ 主任务为「体重记录」，不出现血压/血糖主任务',
      Boolean(p3Wt) && !byId(t3.json, 'bp_monitor') && !byId(t3.json, 'bg_monitor'),
      `taskIds=${tasksOf(t3.json).map((t) => t.taskId).join(',')}`
    )
    check(
      '7 王建军合并症（代谢综合征 / 空腹血糖受损）→ 生成低频关注项（每周 2 次 / 1 次）',
      byId(t3.json, 'DEMO-LF-BP')?.target === 2 &&
        byId(t3.json, 'DEMO-LF-BP')?.weekly === true &&
        byId(t3.json, 'DEMO-LF-BG')?.target === 1 &&
        byId(t3.json, 'DEMO-LF-BG')?.weekly === true,
      JSON.stringify(samples.patient3)
    )
    check(
      '8 低频关注项明确标注为「本项目 Demo 规则，非固定医学处方」',
      /Demo 规则/.test(byId(t3.json, 'DEMO-LF-BP')?.reason || '') && /非固定医学处方/.test(byId(t3.json, 'DEMO-LF-BP')?.reason || ''),
      String(byId(t3.json, 'DEMO-LF-BP')?.reason || '').slice(0, 60)
    )

    /* ============ 2. 服药任务：一药多时段 → 多个计划实例 ============ */
    const medTasks2 = tasksOf(t2.json).filter((t) => t.domain === 'medication')
    samples.medTasks = medTasks2.map((t) => ({ title: t.title, plannedTime: t.plannedTime }))
    const times = medTasks2.map((t) => t.plannedTime).sort().join(',')
    check(
      '9 李秀英用药 2 种（每日 2 次 + 每日 3 次）→ 拆成 5 个独立服药实例',
      medTasks2.length === 5,
      `count=${medTasks2.length} times=${times}`
    )
    check(
      '10 服药实例按时段展开（07:30 / 08:00 / 12:30 / 18:00 / 18:30），一个药物多时段不是一行',
      times === '07:30,08:00,12:30,18:00,18:30',
      times
    )
    const medTasks1 = tasksOf(t1.json).filter((t) => t.domain === 'medication')
    check('11 张建国用药 1 种每日 1 次 → 1 个服药实例（08:00）', medTasks1.length === 1 && medTasks1[0].plannedTime === '08:00', JSON.stringify(medTasks1.map((t) => t.plannedTime)))
    check('12 王建军「暂无长期用药」占位行不产生服药实例', tasksOf(t3.json).filter((t) => t.domain === 'medication').length === 0, `count=${tasksOf(t3.json).filter((t) => t.domain === 'medication').length}`)

    /* ============ 3. 服药打卡 → 进度实时变化 ============ */
    const med = q("SELECT medication_id FROM medications WHERE patient_id='patient_2' ORDER BY medication_id LIMIT 1")[0]
    const logRes = await req('POST', '/api/patients/patient_2/medication-logs', {
      date: DATE,
      medicationId: med.medication_id,
      plannedTime: '08:00',
    })
    const t2b = await req('GET', `/api/patients/patient_2/daily-tasks?date=${DATE}`)
    const doneTask = tasksOf(t2b.json).find((t) => t.medicationId === med.medication_id && t.plannedTime === '08:00')
    check('13 服药打卡写入 medication_logs', logRes.status === 201 && logRes.json?.log?.plannedTime?.includes('08:00'), `status=${logRes.status} plannedTime=${logRes.json?.log?.plannedTime}${logRes.status === 201 ? '' : ` err=${JSON.stringify(logRes.json)}`}`)
    check('14 打卡后对应服药实例进度 done=1（由当天有效 logs 派生）', doneTask?.done === 1, `done=${doneTask?.done}`)
    check('15 其余服药实例进度不受影响（仍为 0）', tasksOf(t2b.json).filter((t) => t.domain === 'medication' && t.done === 1).length === 1, `doneCount=${tasksOf(t2b.json).filter((t) => t.domain === 'medication' && t.done === 1).length}`)

    /* ============ 4. 异常升频：确定性规则，次数来自常量 ============ */
    const reg = await req('POST', '/api/patients/register', {
      username: `step9_probe_${Date.now()}`,
      name: '验收患者',
      password: 'verify123',
      age: 60,
      gender: 'male',
      height: 170,
      weight: 75,
      diseases: ['hypertension'],
    })
    const newPid = reg.json?.patientId
    check('16 新注册高血压患者用于升频验证', reg.status === 201 && Boolean(newPid), `pid=${newPid}`)

    // 7 天全部正常血压 → 该域无预警 → 每日 2 次
    for (let i = 6; i >= 0; i -= 1) {
      await req('POST', `/api/patients/${newPid}/records`, {
        date: addDays(DATE, -i),
        systolic: 118,
        diastolic: 76,
      })
    }
    const normal = await req('GET', `/api/patients/${newPid}/daily-tasks?date=${DATE}`)
    const normalBp = byId(normal.json, 'bp_monitor')
    check(
      '17 常态下每日 2 次（晨起 / 睡前）',
      normalBp?.target === 2 && (normalBp?.slots || []).map((s) => s.label).join(',') === '晨起,睡前',
      `target=${normalBp?.target} slots=${(normalBp?.slots || []).map((s) => s.label).join(',')}`
    )

    // 构造连续 3 天 ≥140 且 7 天涨幅 ≥10 → 命中 R-BP-2（预警）→ 升为每日 3 次
    for (const [d, sys] of [[-2, 145], [-1, 150], [0, 155]]) {
      await req('POST', `/api/patients/${newPid}/records`, { date: addDays(DATE, d), systolic: sys, diastolic: 92 })
    }
    const elevated = await req('GET', `/api/patients/${newPid}/daily-tasks?date=${DATE}`)
    const elevatedBp = byId(elevated.json, 'bp_monitor')
    check(
      '18 近期状态异常（血压域达预警）后按确定性规则升为每日 3 次（晨起 / 午后 / 睡前）',
      elevatedBp?.target === 3 && elevatedBp?.level === 'alert' && (elevatedBp?.slots || []).map((s) => s.label).join(',') === '晨起,午后,睡前',
      `target=${elevatedBp?.target} level=${elevatedBp?.level} slots=${(elevatedBp?.slots || []).map((s) => s.label).join(',')}`
    )
    check(
      '19 升频原因可读且指向确定性依据（不涉及任何 AI 生成）',
      /主诊断高血压/.test(elevatedBp?.reason || '') && /预警/.test(elevatedBp?.reason || ''),
      String(elevatedBp?.reason || '')
    )

    /* ============ 5. 任务次数只能来自规则常量 ============ */
    const allTargets = []
    for (const p of [t1, t2, t3, normal, elevated]) {
      for (const t of tasksOf(p.json)) allTargets.push({ id: t.taskId, target: t.target, source: t.source })
    }
    const allowed = new Set(['2', '3', '1'])
    const offenders = allTargets.filter(
      (t) => ['bp_monitor', 'bg_monitor'].includes(t.id) && !allowed.has(String(t.target))
    )
    check(
      '20 血压/血糖任务次数仅可为规则的 2 或 3（AI 不得自由生成次数）',
      offenders.length === 0,
      `offenders=${JSON.stringify(offenders)}`
    )
    check(
      '21 每个任务都带 source=rule 的确定性标记',
      allTargets.length > 0 && allTargets.every((t) => t.source === 'rule'),
      `tasks=${allTargets.length} nonRule=${allTargets.filter((t) => t.source !== 'rule').length}`
    )
    check(
      '22 响应携带固定免责声明（Demo 规则，非医学处方）',
      /Demo 规则/.test(t1.json?.disclaimer || '') && t1.json?.source === 'rule',
      String(t1.json?.disclaimer || '').slice(0, 40)
    )

    /* ============ 6. 步数目标来自 patient_targets（无则回落常量） ============ */
    const stepsTask = byId(t3.json, 'steps')
    check(
      '23 步数目标为通用任务，目标值来自个体化目标或规则回退值',
      Boolean(stepsTask) && [8000, 10000].includes(stepsTask.target),
      `steps target=${stepsTask?.target}`
    )

    /* ============ 7. 任务不落库 + 副本库零改动 ============ */
    check(
      '24 库中不存在任务/进度表（今日任务是派生视图）',
      q("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%task%' OR name LIKE '%progress%')").length === 0,
      `tables=${q("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%task%'").map((r) => r.name).join(',') || 'none'}`
    )
    const demoMeds = (() => {
      const db = new DatabaseSync(DEMO_DB, { readOnly: true })
      try {
        return db.prepare('SELECT COUNT(*) AS c FROM medication_logs').get().c
      } finally {
        db.close()
      }
    })()
    check('25 演示副本库全程零改动（medication_logs 仍为 0）', demoMeds === 0, `demo medication_logs=${demoMeds}`)

    /* ============ 8. Step 11：医生覆盖层不得动摇「规则是唯一生成者」 ============ */
    const idsBefore = tasksOf(t1.json).map((t) => t.taskId).sort()
    const baseStepsTarget = Number(byId(t1.json, 'steps')?.target)

    const putOv = await fetch(`${BASE}/api/doctors/doc_li/patients/patient_1/task-overrides`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: { steps: { target: 11000 } },
        basis: 'Step11 覆盖层验收：只改参数，不动任务域',
      }),
    })
    const putOvJson = await putOv.json().catch(() => null)

    const t1Overridden = await (await fetch(`${BASE}/api/patients/patient_1/daily-tasks`)).json()
    const idsAfter = tasksOf(t1Overridden).map((t) => t.taskId).sort()
    const ovSteps = byId(t1Overridden, 'steps')

    check(
      '26 Step11 覆盖层不新增/删除任务域（规则仍是唯一生成者）',
      putOv.status === 200 && JSON.stringify(idsBefore) === JSON.stringify(idsAfter),
      `status=${putOv.status} before=[${idsBefore.join(',')}] after=[${idsAfter.join(',')}]`
    )
    check(
      '27 Step11 覆盖后 source 恒为 rule、只改参数并带 override 回显',
      tasksOf(t1Overridden).every((t) => t.source === 'rule') &&
        Number(ovSteps?.target) === 11000 &&
        ovSteps?.override?.applied === true &&
        putOvJson?.ok === true,
      `target=${ovSteps?.target} override=${JSON.stringify(ovSteps?.override)}`
    )

    const revRes = await fetch(`${BASE}/api/doctors/doc_li/patients/patient_1/task-overrides/steps`, {
      method: 'DELETE',
    })
    const t1Revoked = await (await fetch(`${BASE}/api/patients/patient_1/daily-tasks`)).json()
    const rvSteps = byId(t1Revoked, 'steps')
    check(
      '28 Step11 撤销覆盖后完整回落规则值（覆盖态清除）',
      revRes.ok && Number(rvSteps?.target) === baseStepsTarget && !rvSteps?.override,
      `target=${rvSteps?.target} base=${baseStepsTarget} override=${JSON.stringify(rvSteps?.override)}`
    )
  } catch (e) {
    check('EX 执行未抛异常', false, e.message)
  } finally {
    server.kill()
    await sleep(500)
  }

  console.log(line)
  console.log(`==== Step 9 验收（二）动态今日任务：${passed}/${passed + failed} 通过 ====`)
  console.log(line)

  fs.writeFileSync(
    path.join(ROOT, 'data', 'step9-tasks-verify-record.json'),
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
