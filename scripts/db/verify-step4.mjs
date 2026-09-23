/**
 * 迈康 MyCare · 第二阶段 Step 4 验证脚本
 * ===========================================================================
 * 验证目标：**前端 → API → dataProvider → SQLite → 页面** 这条链真的跑通，
 * 且运行时不再依赖 src/data/demoPatients.js。
 *
 * 做法：脚本自行在隔离端口拉起 Express（子进程），逐个打真实 HTTP 接口，
 *       校验返回结构与规则结果，并做「录入 → 落库 → 再查询」的动态验证；
 *       最后临时把 demoPatients.js 改名 .bak，重启后端证明运行时不依赖它，再还原。
 *
 * 运行：node scripts/db/verify-step4.mjs
 * 产物：data/step4-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const NODE = process.execPath
const PORT = 3021
const BASE = `http://127.0.0.1:${PORT}`
// 目标库可用 MYCARE_DB_PATH 覆盖（Step 9：验收统一跑在 reset-demo 生成的干净副本库上，
// 真实库 data/mycare.db 零改动）。脚本自起的后端子进程会继承该环境变量，
// 此处的直连 SQLite 也必须指向同一个库，否则两边数据不一致。
const DB_PATH = process.env.MYCARE_DB_PATH
  ? path.resolve(process.env.MYCARE_DB_PATH)
  : path.join(ROOT, 'data', 'mycare.db')
const DEMO_SRC = path.join(ROOT, 'src', 'data', 'demoPatients.js')
const DEMO_BAK = `${DEMO_SRC}.bak`

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

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await req('GET', '/api/status')
      if (r.status === 200) return true
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  return false
}

function startServer(port) {
  const child = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

function sqliteRun(sql, ...params) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA foreign_keys = ON;')
    return db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

function sqliteGet(sql, ...params) {
  const db = new DatabaseSync(DB_PATH)
  try {
    return db.prepare(sql).get(...params)
  } finally {
    db.close()
  }
}

/** 静态扫描：运行时模块不得 import demoPatients */
function scanRuntimeForDemoRefs() {
  const targets = [
    path.join(ROOT, 'server', 'index.js'),
    ...fs.readdirSync(path.join(ROOT, 'server', 'data')).map((f) => path.join(ROOT, 'server', 'data', f)),
    ...fs.readdirSync(path.join(ROOT, 'src', 'contexts')).map((f) => path.join(ROOT, 'src', 'contexts', f)),
    ...fs.readdirSync(path.join(ROOT, 'src', 'pages')).map((f) => path.join(ROOT, 'src', 'pages', f)),
    ...fs.readdirSync(path.join(ROOT, 'src', 'services')).map((f) => path.join(ROOT, 'src', 'services', f)),
  ].filter((f) => /\.(js|jsx)$/.test(f))

  const offenders = []
  for (const f of targets) {
    const text = fs.readFileSync(f, 'utf8')
    // 只匹配真正的导入语句，注释里提到文件名不算
    if (/(from|import|require\()\s*['"][^'"]*demoPatients/.test(text)) {
      offenders.push(path.relative(ROOT, f))
    }
  }
  return { scanned: targets.length, offenders }
}

const main = async () => {
  const record = { generatedAt: new Date().toISOString(), base: BASE, checks, samples, writeTest: null, renameTest: null }
  let server = startServer(PORT)

  try {
    const up = await waitForServer()
    check('S0 服务启动', up, up ? `listening on ${PORT}` : '启动超时')
    if (!up) throw new Error('后端未启动，终止验证')

    /* ---------------- A. 示范入口（登录页） ---------------- */
    const list = await req('GET', '/api/patients')
    const patients = list.json?.patients || []
    samples.patientEntries = patients
    check(
      'A1 /api/patients 返回 3 位示范患者',
      list.status === 200 && patients.length === 3,
      patients.map((p) => `${p.id}:${p.name}`).join(' ')
    )
    check(
      'A2 入口含年龄/性别/病名（来自数据库派生）',
      patients.every((p) => p.age && p.gender && p.disease),
      patients.map((p) => `${p.name} ${p.age}岁 ${p.gender} ${p.disease}`).join(' | ')
    )

    /* ---------------- B. 登录身份（patient_id 唯一键） ---------------- */
    const login1 = await req('POST', '/api/patients/login', { patientId: 'patient_1' })
    samples.login = { patientId: login1.json?.patientId, name: login1.json?.view?.name, bmi: login1.json?.view?.bmi }
    check(
      'B1 登录 patient_1 → 200 且身份正确',
      login1.status === 200 && login1.json?.patientId === 'patient_1' && login1.json?.view?.name === '张建国',
      JSON.stringify(samples.login)
    )
    check(
      'B2 登录档案含医学设定与生活画像（DB 派生）',
      Boolean(login1.json?.view?.medical?.demoThresholdNote) && Boolean(login1.json?.view?.lifestyle?.diet),
      `controlTarget=${login1.json?.view?.medical?.controlTarget}`
    )
    const loginAlias = await req('POST', '/api/patients/login', { userId: 'patient_3' })
    check('B3 入站 user_id 别名可归一为 patient_id', loginAlias.status === 200 && loginAlias.json?.patientId === 'patient_3', 'userId=patient_3')
    const loginBad = await req('POST', '/api/patients/login', { username: 'nobody' })
    check(
      'B4 未知用户名 → 404 E_PATIENT_NOT_FOUND（不回落默认患者）',
      loginBad.status === 404 && loginBad.json?.code === 'E_PATIENT_NOT_FOUND',
      `status=${loginBad.status} code=${loginBad.json?.code}`
    )

    /* ---------------- C. 首页：当日快照 ---------------- */
    const snap = await req('GET', '/api/patients/patient_1/snapshot')
    samples.snapshot = { exists: snap.json?.exists, date: snap.json?.date, values: snap.json?.values && { sbp: snap.json.values.systolic_pressure, fpg: snap.json.values.fasting_glucose, weight: snap.json.values.weight } }
    check('C1 getDailySnapshot 命中当日且含核心指标', snap.status === 200 && snap.json?.exists === true && snap.json.values.systolic_pressure != null, JSON.stringify(samples.snapshot))

    /* ---------------- D. 健康趋势：getSeries ---------------- */
    const ser = await req('GET', '/api/patients/patient_1/series/systolic_pressure?days=7')
    samples.seriesSbp = { count: ser.json?.count, stats: ser.json?.stats, window: ser.json?.window, sourceKey: ser.json?.sourceKey }
    check(
      'D1 getSeries 收缩压 7 点 / 上升 / 默认 source=daily',
      ser.status === 200 && ser.json?.count === 7 && ser.json?.stats?.direction === 'rising' && ser.json?.sourceKey === 'daily',
      `count=${ser.json?.count} dir=${ser.json?.stats?.direction} latest=${ser.json?.stats?.latest}`
    )
    const serW = await req('GET', '/api/patients/patient_1/series/weight?days=7&source=readings')
    check(
      'D2 P1 来源未建 → 400 source_not_built（不静默回落）',
      serW.status === 400 && serW.json?.code === 'E_INVALID_ARG' && serW.json?.detail?.reason === 'source_not_built',
      `status=${serW.status} reason=${serW.json?.detail?.reason}`
    )
    const serLab = await req('GET', '/api/patients/patient_1/series/systolic_pressure?days=7&source=lab')
    check('D3 非法来源 → 400 E_INVALID_ARG', serLab.status === 400 && serLab.json?.code === 'E_INVALID_ARG', `status=${serLab.status}`)

    /* ---------------- E. 记录列表 ---------------- */
    const recs7 = await req('GET', '/api/patients/patient_2/records?days=7')
    samples.records = { count: recs7.json?.count, window: recs7.json?.window, last: recs7.json?.records?.[recs7.json.records.length - 1]?.record_date }
    check('E1 记录列表 7 天锚定最新记录日', recs7.status === 200 && recs7.json?.count === 7, JSON.stringify(samples.records))

    /* ---------------- F. 勋章 ---------------- */
    const badges = await req('GET', '/api/patients/patient_1/badges')
    samples.badges = badges.json?.badges
    check(
      'F1 勋章来自 badges ⋈ badge_definitions（含 badgeKey）',
      badges.status === 200 && (badges.json?.badges || []).length === 2 && badges.json.badges.every((b) => b.badgeKey),
      (badges.json?.badges || []).map((b) => b.badgeKey).join(',')
    )

    /* ---------------- G. 医生端（doctor_patient_relations） ---------------- */
    const doc = await req('GET', '/api/doctors/doc_li/patients')
    const dpatients = doc.json?.patients || []
    samples.doctor = { name: doc.json?.doctor?.name, patients: dpatients.map((p) => ({ id: p.id, name: p.name, status: p.status, rules: p.evaluation.matched.map((m) => m.ruleId) })) }
    check(
      'G1 医生端经关系表返回 3 位患者',
      doc.status === 200 && dpatients.length === 3,
      dpatients.map((p) => `${p.name}/${p.status}`).join(' ')
    )
    check(
      'G2 规则判定与演示口径一致（R-BP-2 / R-BG-3+R-BG-2 / R-WT-2+R-WT-3）',
      dpatients.find((p) => p.id === 'patient_1')?.evaluation.matched.some((m) => m.ruleId === 'R-BP-2') &&
        dpatients.find((p) => p.id === 'patient_2')?.evaluation.matched.some((m) => m.ruleId === 'R-BG-3') &&
        dpatients.find((p) => p.id === 'patient_3')?.evaluation.matched.some((m) => m.ruleId === 'R-WT-3'),
      JSON.stringify(samples.doctor.patients.map((p) => p.rules))
    )
    check(
      'G3 患者数据经脱敏（手机号掩码）',
      dpatients.every((p) => /^\d{3}\*{4}\d{4}$/.test(p.phone)),
      dpatients.map((p) => p.phone).join(' ')
    )

    /* ---------------- H. 动态写入：录入 → 落库 → 再查询 ---------------- */
    const TEST_DATE = '2026-09-20'
    sqliteRun('DELETE FROM daily_health_records WHERE patient_id = ? AND record_date = ?', 'patient_1', TEST_DATE)
    const before = await req('GET', '/api/patients/patient_1/series/systolic_pressure?days=7')
    const before14 = await req('GET', '/api/patients/patient_1/records?days=14')

    const posted = await req('POST', '/api/patients/patient_1/records', {
      date: TEST_DATE,
      steps: 7000,
      systolic: 150,
      diastolic: 95,
      bloodSugar: 5.6,
      weight: 74.5,
    })
    const rowInDb = sqliteGet('SELECT record_date, systolic_pressure, diastolic_pressure, weight FROM daily_health_records WHERE patient_id = ? AND record_date = ?', 'patient_1', TEST_DATE)

    const after = await req('GET', '/api/patients/patient_1/series/systolic_pressure?days=7')
    const after14 = await req('GET', '/api/patients/patient_1/records?days=14')

    record.writeTest = {
      testDate: TEST_DATE,
      postStatus: posted.status,
      created: posted.json?.created,
      rowInDb,
      before: { windowTo: before.json?.window?.to, latest: before.json?.stats?.latest, count14: before14.json?.count },
      after: { windowTo: after.json?.window?.to, latest: after.json?.stats?.latest, count14: after14.json?.count },
    }

    check('H1 录入接口写入成功（200/created）', posted.status === 200 && posted.json?.created === true, `created=${posted.json?.created}`)
    check('H2 数据真正写入 SQLite', rowInDb?.systolic_pressure === 150 && rowInDb?.record_date === TEST_DATE, JSON.stringify(rowInDb))
    check(
      'H3 重新查询窗口前移且可见新值（趋势图变化）',
      after.json?.window?.to === TEST_DATE && after.json?.stats?.latest === 150,
      `windowTo ${before.json?.window?.to} → ${after.json?.window?.to}, latest ${before.json?.stats?.latest} → ${after.json?.stats?.latest}`
    )
    check(
      'H4 历史追加不覆盖（14 天计数 +1）',
      after14.json?.count === before14.json?.count + 1,
      `${before14.json?.count} → ${after14.json?.count}`
    )

    const upsert = await req('POST', '/api/patients/patient_1/records', { date: TEST_DATE, systolic: 152 })
    const afterUpsert = await req('GET', '/api/patients/patient_1/records?days=14')
    const rowAfterUpsert = sqliteGet('SELECT systolic_pressure, steps, weight, record_status FROM daily_health_records WHERE patient_id = ? AND record_date = ?', 'patient_1', TEST_DATE)
    check(
      'H5 同日再录入为当日修正（不新增行、未提交字段保留）',
      upsert.json?.updated === true && afterUpsert.json?.count === after14.json?.count && rowAfterUpsert?.systolic_pressure === 152 && rowAfterUpsert?.steps === 7000,
      JSON.stringify(rowAfterUpsert)
    )

    // 清理测试行，恢复种子状态
    sqliteRun('DELETE FROM daily_health_records WHERE patient_id = ? AND record_date = ?', 'patient_1', TEST_DATE)
    const cleaned = sqliteGet('SELECT COUNT(*) AS c FROM daily_health_records WHERE patient_id = ? AND record_date = ?', 'patient_1', TEST_DATE)
    check('H6 测试行已清理（DB 恢复种子状态）', cleaned?.c === 0, `rows=${cleaned?.c}`)

    /* ---------------- I. 静态扫描：运行时不依赖 demoPatients ---------------- */
    const scan = scanRuntimeForDemoRefs()
    record.staticScan = scan
    check('I1 运行时模块无 demoPatients 导入', scan.offenders.length === 0, `scanned=${scan.scanned} offenders=${scan.offenders.join(',') || 'none'}`)

    /* ---------------- J. 后端脱离 demoPatients 运行 ---------------- */
    server.kill()
    await sleep(800)
    let renamed = false
    let renameOk = false
    let renameRestored = false
    try {
      fs.renameSync(DEMO_SRC, DEMO_BAK)
      renamed = true
      const s2 = startServer(PORT + 1)
      const BASE_SAVE = BASE
      const deadline = Date.now() + 20000
      let up2 = false
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${BASE_SAVE.replace(String(PORT), String(PORT + 1))}/api/status`)
          if (r.status === 200) {
            up2 = true
            break
          }
        } catch {
          /* retry */
        }
        await sleep(300)
      }
      if (up2) {
        const b2 = BASE_SAVE.replace(String(PORT), String(PORT + 1))
        const list2 = await fetch(`${b2}/api/patients`).then((r) => r.json())
        const login2 = await fetch(`${b2}/api/patients/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patientId: 'patient_1' }),
        }).then((r) => r.json())
        renameOk = (list2.patients || []).length === 3 && login2.patientId === 'patient_1'
      }
      s2.kill()
    } catch (e) {
      renameOk = false
      record.renameTestError = String(e?.message || e)
    } finally {
      if (renamed) {
        fs.renameSync(DEMO_BAK, DEMO_SRC)
        renameRestored = fs.existsSync(DEMO_SRC)
      }
    }
    record.renameTest = { renamed, renameOk, renameRestored }
    check('J1 demoPatients.js 改名 .bak 后后端仍可服务', renameOk, `renamed=${renamed} ok=${renameOk}`)
    check('J2 demoPatients.js 已还原', renameRestored, `restored=${renameRestored}`)

    /* ---------------- K. 前端构建产物不含 demoPatients ---------------- */
    const distDir = path.join(ROOT, 'dist', 'assets')
    let bundleHit = null
    if (fs.existsSync(distDir)) {
      const jsFiles = fs.readdirSync(distDir).filter((f) => f.endsWith('.js'))
      bundleHit = jsFiles.filter((f) => fs.readFileSync(path.join(distDir, f), 'utf8').includes('demoPatients'))
    }
    record.bundleScan = { distDir: fs.existsSync(distDir), hits: bundleHit }
    check('K1 前端构建产物不含 demoPatients 引用', bundleHit !== null && bundleHit.length === 0, bundleHit ? `hits=${bundleHit.join(',') || 'none'}` : 'dist 不存在（跳过）')

    record.summary = { passed, failed, total: passed + failed, allPass: failed === 0 }
    fs.writeFileSync(path.join(ROOT, 'data', 'step4-verify-record.json'), JSON.stringify(record, null, 2), 'utf8')

    console.log(`\n==== Step 4 验证：${passed}/${passed + failed} 通过 ====`)
  } catch (err) {
    console.error('验证中断：', err)
    try {
      server.kill()
    } catch {
      /* ignore */
    }
    record.summary = { passed, failed, total: passed + failed, allPass: false, error: String(err?.message || err) }
    fs.writeFileSync(path.join(ROOT, 'data', 'step4-verify-record.json'), JSON.stringify(record, null, 2), 'utf8')
    process.exitCode = 1
  } finally {
    try {
      if (fs.existsSync(DEMO_BAK)) fs.renameSync(DEMO_BAK, DEMO_SRC)
    } catch {
      /* ignore */
    }
  }
}

main()
