#!/usr/bin/env node
/**
 * 迈康 MyCare · 第二阶段 Step 3 · dataProvider 验证脚本
 * ===========================================================================
 * 依据：docs/Step0.1_取数契约冻结_v0.1.md（已批准）
 * 目的：只读验证 + 来源证明，不改业务代码、不改表结构、不进入 Step 4。
 *
 * 覆盖：
 *   A. 三位患者 profile / daily snapshot / series 实际查询结果
 *   B. source 解析（default / 合法 readings / 未建 P1 来源 / 非法来源）
 *   C. 5 类错误场景（E_INVALID_ARG / E_PATIENT_NOT_FOUND / E_UNKNOWN_METRIC / 查无数据不抛错）
 *   D. demoPatients.js 已不再作为取数来源（静态扫描 + 临时改名运行 + 写库读库回滚）
 *
 * 用法：node scripts/db/verify-dataProvider.mjs
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

import * as dp from '../../server/data/dataProvider.js'
import { openDb, listTables, DB_PATH } from '../../server/data/db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const DATA_DIR = resolve(ROOT, 'data')
const RECORD_PATH = resolve(DATA_DIR, 'step3-dataprovider-record.json')
const DEMO_SRC = resolve(ROOT, 'src', 'data', 'demoPatients.js')
const PROVIDER_DIR = resolve(ROOT, 'server', 'data')

const PATIENTS = ['patient_1', 'patient_2', 'patient_3']
const results = { checks: {}, samples: {}, errors: {}, sourceResolution: {}, proof: {} }

/** 捕获 DataProviderError → 归一为可序列化结构 */
async function capture(fn) {
  try {
    const value = await fn()
    return { ok: true, value }
  } catch (err) {
    return {
      ok: false,
      error: { name: err?.name, code: err?.code, message: err?.message, detail: err?.detail ?? null },
    }
  }
}

/* ====================================================================== *
 * D1. 静态扫描：dataProvider 层不得引用 demoPatients
 * ====================================================================== */
function staticScan() {
  const files = fs.readdirSync(PROVIDER_DIR).filter((f) => f.endsWith('.js'))
  const hits = []
  for (const f of files) {
    const text = fs.readFileSync(join(PROVIDER_DIR, f), 'utf8')
    // 排除注释/文档中的说明性提及：只统计 import/require/路径引用
    const refs = text
      .split(/\r?\n/)
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /demoPatients/.test(text))
      .filter(({ text }) => /import\s|require\(|from\s+['"].*demoPatients/.test(text))
    for (const r of refs) hits.push({ file: f, line: r.line, text: r.text.trim() })
  }
  results.proof.staticScan = {
    scannedFiles: files,
    importReferences: hits,
    pass: hits.length === 0,
  }
  return hits.length === 0
}

/* ====================================================================== *
 * A. 三位患者取数
 * ====================================================================== */
async function perPatient() {
  const out = []
  for (const pid of PATIENTS) {
    const profile = await dp.getPatientProfile(pid)
    const view = dp.toUserProfileView(profile)
    const latestDate = profile.latestMeasurements?.date ?? dp.todayCST()
    const snap = await dp.getDailySnapshot(pid, latestDate)
    const seriesKeys = ['systolic_pressure', 'fasting_glucose', 'weight', 'waist', 'steps']
    const series = {}
    for (const k of seriesKeys) series[k] = await dp.getSeries(pid, k, 7)

    out.push({
      patientId: pid,
      identity: profile.identity,
      latestMeasurements: profile.latestMeasurements,
      derived: profile.derived,
      targetsBrief: profile.targets
        ? {
            systolicTarget: profile.targets.systolicTarget,
            diastolicTarget: profile.targets.diastolicTarget,
            fastingGlucoseTarget: profile.targets.fastingGlucoseTarget,
            bmiTarget: profile.targets.bmiTarget,
            waistTarget: profile.targets.waistTarget,
            controlTarget: profile.targets.controlTarget,
          }
        : null,
      counts: {
        contacts: profile.contacts.length,
        conditions: profile.conditions.length,
        medications: profile.medications.length,
        doctors: profile.doctors.length,
      },
      snapshot: {
        date: snap.date,
        exists: snap.exists,
        values: snap.values,
        bloodPressureDetailCount: snap.details.blood_pressure.length,
        bloodGlucoseDetailCount: snap.details.blood_glucose.length,
        weightDetailCount: snap.details.weight.length,
        labCount: snap.lab.length,
      },
      series: Object.fromEntries(
        Object.entries(series).map(([k, s]) => [
          k,
          {
            sourceKey: s.sourceKey,
            resolvedSource: s.resolvedSource,
            unit: s.unit,
            target: s.target,
            window: s.window,
            count: s.count,
            empty: s.empty,
            values: s.points.map((p) => p.value),
            stats: s.stats
              ? { mean: s.stats.mean, min: s.stats.min, max: s.stats.max, latest: s.stats.latest, slope: s.stats.slope, direction: s.stats.direction }
              : null,
          },
        ])
      ),
      // 契约兼容视图抽样（证明可还原为旧 toUserProfile() 同形）
      viewBrief: {
        user_id: view.user_id,
        name: view.name,
        age: view.age,
        height: view.height,
        weight: view.weight,
        waist: view.waist,
        bmi: view.bmi,
        disease_types: view.disease_types,
        demoThreshold: view.medical.demoThreshold,
        emergency_authorized: view.emergencyContact?.authorized,
      },
    })
  }
  results.samples.patients = out
  return out
}

/* ====================================================================== *
 * B. source 解析
 * ====================================================================== */
async function sourceResolution() {
  const r = {}
  // B1. 未指定 source → default_source = daily
  r.b1_default_daily = await dp.getSeries('patient_1', 'systolic_pressure', 7)
  // B2. 指定 readings（表已建，但种子未灌该细表 → 合法来源、查无数据、不抛错）
  r.b2_explicit_readings_valid = await capture(() =>
    dp.getSeries('patient_1', 'systolic_pressure', 7, { source: 'readings' })
  )
  // B3. weight 的 readings 指向 P1 weight_readings（未建）→ E_INVALID_ARG / source_not_built
  r.b3_weight_readings_not_built = await capture(() =>
    dp.getSeries('patient_1', 'weight', 7, { source: 'readings' })
  )
  // B4. source 不在 available_sources → E_INVALID_ARG
  r.b4_invalid_source = await capture(() =>
    dp.getSeries('patient_1', 'systolic_pressure', 7, { source: 'lab' })
  )
  results.sourceResolution = {
    b1: { sourceKey: r.b1_default_daily.sourceKey, resolvedSource: r.b1_default_daily.resolvedSource, count: r.b1_default_daily.count },
    b2: r.b2_explicit_readings_valid.ok
      ? {
          sourceKey: r.b2_explicit_readings_valid.value.sourceKey,
          resolvedSource: r.b2_explicit_readings_valid.value.resolvedSource,
          count: r.b2_explicit_readings_valid.value.count,
          empty: r.b2_explicit_readings_valid.value.empty,
        }
      : r.b2_explicit_readings_valid.error,
    b3: r.b3_weight_readings_not_built.ok
      ? { unexpected: '应当抛错却成功' }
      : r.b3_weight_readings_not_built.error,
    b4: r.b4_invalid_source.ok ? { unexpected: '应当抛错却成功' } : r.b4_invalid_source.error,
  }
  return r
}

/* ====================================================================== *
 * C. 错误场景 + 「查无数据不抛错」
 * ====================================================================== */
async function errorScenarios() {
  const c = {
    e1_missing_patientId: await capture(() => dp.getSeries('', 'systolic_pressure')),
    e2_unknown_patient: await capture(() => dp.getPatientProfile('patient_999')),
    e3_unknown_metric: await capture(() => dp.getSeries('patient_1', 'not_a_metric')),
    e4_bad_days: await capture(() => dp.getSeries('patient_1', 'weight', 0)),
    e5_bad_date: await capture(() => dp.getDailySnapshot('patient_1', '2026/09/14')),
    e6_empty_window: await capture(() =>
      dp.getSeries('patient_1', 'systolic_pressure', 7, { from: '2030-01-01', to: '2030-01-07' })
    ),
    e7_no_snapshot_day: await capture(() => dp.getDailySnapshot('patient_1', '2026-01-01')),
  }
  results.errors = {
    e1: c.e1_missing_patientId.ok ? { unexpected: '应当抛错' } : c.e1_missing_patientId.error,
    e2: c.e2_unknown_patient.ok ? { unexpected: '应当抛错' } : c.e2_unknown_patient.error,
    e3: c.e3_unknown_metric.ok ? { unexpected: '应当抛错' } : c.e3_unknown_metric.error,
    e4: c.e4_bad_days.ok ? { unexpected: '应当抛错' } : c.e4_bad_days.error,
    e5: c.e5_bad_date.ok ? { unexpected: '应当抛错' } : c.e5_bad_date.error,
    e6_emptyWindow: c.e6_empty_window.ok
      ? { count: c.e6_empty_window.value.count, empty: c.e6_empty_window.value.empty, stats: c.e6_empty_window.value.stats, noThrow: true }
      : c.e6_empty_window.error,
    e7_noSnapshotDay: c.e7_no_snapshot_day.ok
      ? { exists: c.e7_no_snapshot_day.value.exists, values: c.e7_no_snapshot_day.value.values, noThrow: true }
      : c.e7_no_snapshot_day.error,
  }
  return c
}

/* ====================================================================== *
 * D2/D3. 来源证明：临时改名运行 + 写库读库回滚
 * ====================================================================== */
async function runtimeProof() {
  // D2. 临时把 demoPatients.js 改名为 .bak，dataProvider 仍可正常工作
  const bak = `${DEMO_SRC}.bak`
  let renamed = false
  let renamedRun = null
  try {
    fs.renameSync(DEMO_SRC, bak)
    renamed = true
    const s = await dp.getSeries('patient_1', 'systolic_pressure', 7)
    const prof = await dp.getPatientProfile('patient_1')
    renamedRun = {
      ok: true,
      seriesCount: s.count,
      seriesLatest: s.stats?.latest,
      profileName: prof.identity.name,
      demoPatientsVisibleToNode: false,
    }
  } catch (err) {
    renamedRun = { ok: false, error: err.message }
  } finally {
    if (renamed) fs.renameSync(bak, DEMO_SRC)
  }

  // D3. 写库 → 读库（同连接事务内）→ 回滚；证明取数确实来自 SQLite 且历史追加不覆盖
  //     固定 7 天窗口锚定「最新记录日」：追加更晚记录 → 末端前移、窗口仍 7 点（契约 §5.3 理由③）
  //     显式宽窗口 [09-08, 09-15]：追加后点数 7 → 8，直接证明「历史追加而非覆盖」
  const db = openDb()
  /* 动态选定「更晚的一天」，不再写死日期。
     原实现写死 WIDE = [2026-09-08, 2026-09-15]、插入日 2026-09-15；
     而种子数据的记录日会随日历滚动（reset-demo 生成的是「截至今天的 7 天」），
     写死的日期迟早落进既有记录，INSERT 直接撞 UNIQUE 约束（脚本崩溃在 259 行）。
     现改为：以 patient_1 现有最新记录日为基准，插入「最新日 + 1 天」，
     宽窗口 = [最新日 − 6, 最新日 + 1]。断言语义与原实现完全一致。 */
  const shiftDay = (d, n) => {
    const t = new Date(`${d}T00:00:00Z`)
    t.setUTCDate(t.getUTCDate() + n)
    return t.toISOString().slice(0, 10)
  }
  const latestDay = String(
    db
      .prepare(
        "SELECT MAX(record_date) d FROM daily_health_records WHERE patient_id = 'patient_1' AND record_status != 'void'"
      )
      .get()?.d || ''
  ).slice(0, 10)
  if (!latestDay) throw new Error('patient_1 没有任何日记录，无法进行「写库 → 读库 → 回滚」证明')
  const INSERT_DAY = shiftDay(latestDay, 1)
  const WIDE = { from: shiftDay(latestDay, -6), to: INSERT_DAY }
  const before = await dp.getSeries('patient_1', 'systolic_pressure', 7)
  const beforeWide = await dp.getSeries('patient_1', 'systolic_pressure', 7, WIDE)
  let writeProof = null
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO daily_health_records
         (record_id, patient_id, record_date, systolic_pressure, diastolic_pressure, fasting_glucose, weight, heart_rate, steps, source, record_status)
       VALUES (?, 'patient_1', ?, 170, 100, 5.6, 74.8, 88, 5000, 'manual', 'valid')`
    ).run('__verify_tmp_probe__', INSERT_DAY)
    const after = await dp.getSeries('patient_1', 'systolic_pressure', 7)
    const afterWide = await dp.getSeries('patient_1', 'systolic_pressure', 7, WIDE)
    writeProof = {
      defaultWindow: {
        before: { count: before.count, latest: before.stats?.latest, windowTo: before.window.to },
        after: { count: after.count, latest: after.stats?.latest, windowTo: after.window.to },
      },
      explicitWindow: { from: WIDE.from, to: WIDE.to, beforeCount: beforeWide.count, afterCount: afterWide.count, grew: afterWide.count === beforeWide.count + 1 },
      windowAdvanced: after.window.to === INSERT_DAY,
      latestAdvanced: after.stats?.latest === 170,
      grew: afterWide.count === beforeWide.count + 1,
    }
  } finally {
    db.exec('ROLLBACK')
  }
  const restored = await dp.getSeries('patient_1', 'systolic_pressure', 7)

  results.proof = {
    ...results.proof,
    renameDemoPatients: { sourceFile: DEMO_SRC, renamedRun, restored: fs.existsSync(DEMO_SRC) },
    dbRoundtrip: { ...writeProof, rolledBackTo: { count: restored.count, latest: restored.stats?.latest, windowTo: restored.window.to } },
  }
  return { renamedRun, writeProof }
}

/* ====================================================================== *
 * 主流程
 * ====================================================================== */
async function main() {
  const staticOK = staticScan()
  const patients = await perPatient()
  await sourceResolution()
  await errorScenarios()
  await runtimeProof()

  const tables = listTables()
  const P0 = [
    'patients', 'patient_contacts', 'patient_conditions', 'patient_lifestyle', 'patient_targets',
    'medications', 'doctors', 'doctor_patient_relations', 'metric_definitions', 'badge_definitions',
    'daily_health_records', 'blood_pressure_readings', 'blood_glucose_readings', 'lab_results',
    'alerts', 'reminders', 'doctor_notes', 'medication_logs', 'agent_runs', 'vision_records',
    'prescriptions', 'badges',
  ]
  const P1P2_ABSENT = !tables.includes('weight_readings') && !tables.includes('point_transactions') && !tables.includes('user_levels')

  /* 默认 7 天窗口应锚定「最新记录日」。原实现写死 2026-09-14，
     种子数据的记录日随日历滚动后会失效，故改为直接取库内三位示范患者的最新记录日。 */
  const anchorDay = String(
    openDb()
      .prepare(
        "SELECT MAX(record_date) d FROM daily_health_records WHERE patient_id IN ('patient_1','patient_2','patient_3') AND record_status != 'void'"
      )
      .get()?.d || ''
  ).slice(0, 10)
  const p1 = patients[0]
  const checks = {
    // A. 三契约抽样
    profileThreePatients: patients.every((p) => p.identity?.name && p.latestMeasurements?.date),
    snapshotThreePatients: patients.every((p) => p.snapshot.exists === true && p.snapshot.values?.systolic_pressure != null),
    seriesSevenPoints: patients.every((p) => p.series.systolic_pressure.count === 7 && p.series.systolic_pressure.window.days === 7),
    defaultAnchorLatest: patients.every((p) => p.series.systolic_pressure.window.anchorMode === 'latest' && p.series.systolic_pressure.window.to === anchorDay),
    waistSinglePoint: patients.every((p) => p.series.waist.count === 1),
    bmiDerived: patients.every((p) => typeof p.derived.bmi === 'number'),
    ageDerived: patients.every((p) => [68, 65, 62].includes(p.identity.age)),
    heightOnlyIdentity: patients.every((p) => typeof p.identity.height === 'number'),
    // B. source 解析
    sourceDefaultDaily: results.sourceResolution.b1.sourceKey === 'daily',
    sourceReadingsValidEmpty: results.sourceResolution.b2?.sourceKey === 'readings' && results.sourceResolution.b2?.empty === true,
    sourceNotBuiltThrows: results.sourceResolution.b3?.code === 'E_INVALID_ARG' && results.sourceResolution.b3?.detail?.reason === 'source_not_built',
    invalidSourceThrows: results.sourceResolution.b4?.code === 'E_INVALID_ARG',
    // C. 错误场景
    missingPatientIdThrows: results.errors.e1?.code === 'E_INVALID_ARG',
    unknownPatientThrows: results.errors.e2?.code === 'E_PATIENT_NOT_FOUND',
    unknownMetricThrows: results.errors.e3?.code === 'E_UNKNOWN_METRIC',
    badDaysThrows: results.errors.e4?.code === 'E_INVALID_ARG',
    badDateThrows: results.errors.e5?.code === 'E_INVALID_ARG',
    emptyWindowNoThrow: results.errors.e6_emptyWindow?.noThrow === true && results.errors.e6_emptyWindow?.empty === true,
    noSnapshotNoThrow: results.errors.e7_noSnapshotDay?.noThrow === true && results.errors.e7_noSnapshotDay?.exists === false,
    // D. 来源证明
    staticNoDemoPatientsRef: staticOK,
    renameProof: results.proof.renameDemoPatients.renamedRun?.ok === true,
    renameRestored: results.proof.renameDemoPatients.restored === true,
    dbRoundtripGrew: results.proof.dbRoundtrip.grew === true && results.proof.dbRoundtrip.windowAdvanced === true,
    dbRoundtripRolledBack: results.proof.dbRoundtrip.rolledBackTo.count === 7,
    // 结构边界
    p0Count22: P0.every((t) => tables.includes(t)) && P0.length === 22,
    p1p2Absent: P1P2_ABSENT,
  }

  const allPass = Object.values(checks).every(Boolean)

  const report = {
    generatedAt: new Date().toISOString(),
    dbPath: DB_PATH,
    driver: 'node:sqlite (DatabaseSync)',
    providerFiles: ['server/data/errors.js', 'server/data/db.js', 'server/data/dataProvider.js'],
    contracts: ['getSeries', 'getDailySnapshot', 'getPatientProfile', 'toUserProfileView'],
    tables,
    p0Count: P0.length,
    samples: results.samples,
    sourceResolution: results.sourceResolution,
    errors: results.errors,
    proof: results.proof,
    checks,
    allPass,
    boundary: {
      dbCreatedInThisStep: false,
      ddlExecuted: false,
      businessLogicModified: false,
      frontendModified: false,
      agentModified: false,
      tablesAdded: false,
    },
  }
  fs.writeFileSync(RECORD_PATH, JSON.stringify(report, null, 2), 'utf8')

  /* ---------- 控制台摘要 ---------- */
  const line = '─'.repeat(78)
  console.log(line)
  console.log('迈康 MyCare · Step 3 dataProvider 验证')
  console.log(line)
  console.log(`DB：${DB_PATH}`)
  console.log(`表数量：${tables.length}（P0 22 张齐备=${checks.p0Count22}；P1/P2 未建=${checks.p1p2Absent}）`)
  console.log(line)
  for (const p of patients) {
    console.log(`${p.patientId} ${p.identity.name}｜age=${p.identity.age} height=${p.identity.height} bmi=${p.derived.bmi}｜latest=${p.latestMeasurements.date}`)
    console.log(`   snapshot ${p.snapshot.date} exists=${p.snapshot.exists} SBP=${p.snapshot.values?.systolic_pressure} FPG=${p.snapshot.values?.fasting_glucose} wt=${p.snapshot.values?.weight} waist=${p.snapshot.values?.waist}`)
    console.log(`   series: SBP n=${p.series.systolic_pressure.count} [${p.series.systolic_pressure.values.join(',')}] slope=${p.series.systolic_pressure.stats?.slope} ${p.series.systolic_pressure.stats?.direction}`)
    console.log(`           FPG n=${p.series.fasting_glucose.count} mean=${p.series.fasting_glucose.stats?.mean} target=${p.series.fasting_glucose.target}`)
    console.log(`           waist n=${p.series.waist.count} values=[${p.series.waist.values.join(',')}]`)
  }
  console.log(line)
  console.log('source 解析：')
  console.log(`  default(daily)         → ${JSON.stringify(results.sourceResolution.b1)}`)
  console.log(`  systolic+readings      → ${JSON.stringify(results.sourceResolution.b2)}`)
  console.log(`  weight+readings(P1未建) → ${results.sourceResolution.b3.code} reason=${results.sourceResolution.b3.detail?.reason}`)
  console.log(`  systolic+lab(非法)      → ${results.sourceResolution.b4.code}`)
  console.log('错误场景：')
  for (const [k, v] of Object.entries(results.errors)) {
    console.log(`  ${k}: ${v.code ?? '(no-throw) ' + JSON.stringify(v)}`)
  }
  console.log('来源证明：')
  console.log(`  静态扫描无 demoPatients 引用：${checks.staticNoDemoPatientsRef}`)
  console.log(`  临时改名 demoPatients 后仍可取数：${checks.renameProof}（已还原=${checks.renameRestored}）`)
  const rt = results.proof.dbRoundtrip
  console.log(`  写库→读库（默认7天窗口，锚定最新）：${JSON.stringify(rt.defaultWindow.before)} → ${JSON.stringify(rt.defaultWindow.after)}`)
  console.log(`  写库→读库（显式窗口 ${rt.explicitWindow.from}~${rt.explicitWindow.to}）：count ${rt.explicitWindow.beforeCount} → ${rt.explicitWindow.afterCount}（追加不覆盖=${rt.explicitWindow.grew}）`)
  console.log(`  回滚后复原：${JSON.stringify(rt.rolledBackTo)}`)
  console.log(line)
  console.log('总检查：')
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✅' : '❌'} ${k}`)
  console.log(line)
  console.log(`记录已写入：${RECORD_PATH}`)
  console.log(allPass ? '✅ Step 3 dataProvider 全部检查通过' : '❌ 存在未通过项')
  if (!allPass) process.exitCode = 2
}

main().catch((err) => {
  console.error('❌ 验证脚本异常：', err)
  process.exit(1)
})
