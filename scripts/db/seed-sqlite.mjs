#!/usr/bin/env node
/**
 * 迈康 MyCare · 第二阶段 Step 2 · 种子数据导入脚本
 * ------------------------------------------------------------------
 * 依据：docs/Step0.1_取数契约冻结_v0.1.md（已批准）
 * 前置：scripts/db/build-sqlite.mjs 已建库（data/mycare.db，P0 22 张表）
 * 驱动：Node 内置 node:sqlite（DatabaseSync），零第三方依赖
 *
 * 原则（Step 2 边界）：
 *   1) **唯一数据源** = src/data/demoPatients.js（直接 import，不复制粘贴，避免走样）
 *      —— 只读取，不修改该文件，也不修改三个人物设定。
 *   2) 只做「数据映射」，**不新增 / 删除表、不改 DDL、不改业务代码**。
 *   3) 幂等：每次运行先清空种子表再重灌，保证结果可复现。
 *   4) 只写入有「真实来源」的数据；源里没有的字段一律留空，不臆造。
 *
 * 用法：
 *   node scripts/db/seed-sqlite.mjs
 *   SEED_END_DATE=2026-09-14 node scripts/db/seed-sqlite.mjs   # 指定 7 天窗口末日期
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { DEMO_PATIENTS, toHealthRecords } from '../../src/data/demoPatients.js'
import { evaluateClinicalRules } from '../../src/utils/clinicalRules.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const DATA_DIR = resolve(ROOT, 'data')
const DB_PATH = process.env.MYCARE_DB_PATH
  ? resolve(process.env.MYCARE_DB_PATH)
  : resolve(DATA_DIR, 'mycare.db')
// 目标库被覆盖时，记录文件写到目标库同目录，避免覆盖真实库的 Step 2 种子记录
const RECORD_PATH = process.env.MYCARE_DB_PATH
  ? resolve(DB_PATH, '..', 'step2-seed-record.demo.json')
  : resolve(DATA_DIR, 'step2-seed-record.json')

/* ================================================================== *
 * 冻结常量（与 Step 0.1 §8.1 一致，源文件中没有、由契约冻结）
 * ================================================================== */

/** 三人生日：以 2026 为基准年由原 age 派生（Step 0.1 §8.1 冻结），保证 2026 现算年龄不变 */
const BIRTH_DATE_BY_PATIENT = {
  patient_1: '1958-03-12', // 原 age 68
  patient_2: '1961-06-08', // 原 age 65
  patient_3: '1964-01-25', // 原 age 62
}

/** 医生身份：DoctorPage.jsx 固定常量「李医生｜主任医师 · 全科」 */
const DOCTOR = {
  doctor_id: 'doc_li',
  username: 'lidoctor',
  password_hash: '',
  name: '李医生',
  title: '主任医师',
  department: '全科',
  phone: null,
  email: null,
  license_number: null,
  is_active: 1,
}

/**
 * 勋章目录（badge_definitions）—— 仅登记三位示范病例**实际获得**的 2 类勋章。
 * badge_type 保留 demoPatients 原枚举（'初次记录' / '连续记录'），
 * badge_key 采用 UI 既有目录 id 约定（初次记录 → first_record；连续记录语义=连续 7 天 → week_streak）。
 */
const BADGE_DEFS = [
  {
    badge_def_id: 'badgedef_first_record',
    badge_key: 'first_record',
    badge_type: '初次记录',
    badge_name: '迈出第一步',
    description: '完成第一次健康数据记录',
    icon: '⭐',
    default_points: 10,
    level: 1,
    threshold: JSON.stringify({ records: 1 }),
  },
  {
    badge_def_id: 'badgedef_week_streak',
    badge_key: 'week_streak',
    badge_type: '连续记录',
    badge_name: '坚持不懈',
    description: '连续 7 天记录健康数据',
    icon: '📊',
    default_points: 30,
    level: 1,
    threshold: JSON.stringify({ consecutiveDays: 7 }),
  },
]
const BADGE_DEF_BY_TYPE = { 初次记录: 'badgedef_first_record', 连续记录: 'badgedef_week_streak' }

/* ================================================================== *
 * 工具
 * ================================================================== */
const b = (v) => (v ? 1 : 0) // boolean → 0/1（node:sqlite 不支持 bool 绑定）
const nz = (v) => (v === undefined ? null : v)

/** 东八区「今天」→ YYYY-MM-DD */
function todayCST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

/** 以 end(YYYY-MM-DD) 为第 0 天，返回往前 offset 天的日期 */
function dateForOffset(end, offset) {
  const [y, m, d] = end.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  t.setUTCDate(t.getUTCDate() - offset)
  return t.toISOString().slice(0, 10)
}

/** 以 end(YYYY-MM-DD) 为基准，往前 months 个月的日期（日取 min(day,28) 防越界） */
function monthsAgo(end, months) {
  const [y, m, d] = end.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 - months, Math.min(d, 28), 12, 0, 0))
  return t.toISOString().slice(0, 10)
}

/** 两个 YYYY-MM-DD 之间的整月数（近似，按 30.44 天/月） */
function monthsBetween(from, to) {
  const diff = (new Date(to) - new Date(from)) / 86400000
  return Math.round(diff / 30.44)
}

/* ================================================================== *
 * 主流程
 * ================================================================== */
function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`❌ 未找到数据库文件：${DB_PATH}\n   请先运行：node scripts/db/build-sqlite.mjs`)
    process.exit(1)
  }
  mkdirSync(DATA_DIR, { recursive: true })

  const END = process.env.SEED_END_DATE || todayCST()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(END)) {
    console.error(`❌ SEED_END_DATE 格式非法：${END}（应为 YYYY-MM-DD）`)
    process.exit(1)
  }

  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA foreign_keys = ON;')

  /* ---------- 1) 幂等清理（先子后父；metric_definitions 保留 Step 1 结果） ---------- */
  const CLEAR_ORDER = [
    'badges', 'daily_health_records', 'lab_results', 'medication_logs', 'doctor_notes',
    'patient_targets', 'medications', 'patient_lifestyle', 'patient_conditions', 'patient_contacts',
    'doctor_patient_relations', 'prescriptions', 'reminders', 'alerts', 'agent_runs', 'vision_records',
    'patients', 'doctors', 'badge_definitions',
  ]
  db.exec('BEGIN')
  for (const t of CLEAR_ORDER) db.exec(`DELETE FROM ${t};`)

  /* ---------- 2) 写入医生 & 勋章目录 ---------- */
  const insDoctor = db.prepare(
    `INSERT INTO doctors (doctor_id, username, password_hash, name, title, department, phone, email, license_number, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  insDoctor.run(
    DOCTOR.doctor_id, DOCTOR.username, DOCTOR.password_hash, DOCTOR.name,
    DOCTOR.title, DOCTOR.department, DOCTOR.phone, DOCTOR.email, DOCTOR.license_number, DOCTOR.is_active
  )

  const insBadgeDef = db.prepare(
    `INSERT INTO badge_definitions (badge_def_id, badge_key, badge_type, badge_name, description, icon, default_points, level, threshold)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const d of BADGE_DEFS) {
    insBadgeDef.run(d.badge_def_id, d.badge_key, d.badge_type, d.badge_name, d.description, d.icon, d.default_points, d.level, d.threshold)
  }

  /* ---------- 3) 逐位患者写入 ---------- */
  const insPatient = db.prepare(
    `INSERT INTO patients
      (patient_id, username, password_hash, name, gender, birth_date, height, phone, occupation, elderly_mode, voice_enabled, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insContact = db.prepare(
    `INSERT INTO patient_contacts (contact_id, patient_id, contact_name, relation, contact_phone, authorized, authorized_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const insCondition = db.prepare(
    `INSERT INTO patient_conditions
      (condition_id, patient_id, disease_name, disease_grade, is_primary, diagnosed_at, duration_text,
       risk_stratification, risk_basis, comorbidities, organ_damage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insLifestyle = db.prepare(
    `INSERT INTO patient_lifestyle (patient_id, diet, exercise, sleep, biggest_difficulty, motivation, ai_style, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insTarget = db.prepare(
    `INSERT INTO patient_targets
      (target_id, patient_id, systolic_target, diastolic_target, fasting_glucose_target, hba1c_target,
       bmi_target, waist_target, steps_target, weight_change_target, basis, effective_from, set_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insMedication = db.prepare(
    `INSERT INTO medications (medication_id, patient_id, name, dosage, time, frequency, note, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insRelation = db.prepare(
    `INSERT INTO doctor_patient_relations (relation_id, doctor_id, patient_id, is_active)
     VALUES (?, ?, ?, 1)`
  )
  const insDaily = db.prepare(
    `INSERT INTO daily_health_records
      (record_id, patient_id, record_date, steps, systolic_pressure, diastolic_pressure, fasting_glucose,
       weight, waist, heart_rate, exercise_minutes, sleep_hours, mood_score, notes, source, record_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'valid')`
  )
  const insLab = db.prepare(
    `INSERT INTO lab_results
      (lab_id, patient_id, test_date, item_name, value, unit, reference_range, is_abnormal, source, record_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'valid')`
  )
  const insBadge = db.prepare(
    `INSERT INTO badges (badge_id, patient_id, badge_def_id, earned_date, level, points)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  const summary = { endDate: END, patients: [] }

  for (const p of DEMO_PATIENTS) {
    const pid = p.id
    const pr = p.profile
    const md = p.medical
    const lf = p.lifestyle

    /* —— patients（身份：height 唯一归属本表；不含 waist） —— */
    insPatient.run(
      pid, pr.username, '', pr.name, pr.gender,
      BIRTH_DATE_BY_PATIENT[pid] || null, pr.height, pr.phone, pr.occupation,
      b(pr.elderlyMode), b(pr.voiceEnabled), 1
    )

    /* —— patient_contacts（紧急联系人，含授权红线字段） —— */
    const ec = pr.emergencyContact
    insContact.run(
      `contact_${pid}_1`, pid, ec.name, ec.relation, ec.phone, b(ec.authorized),
      ec.authorized ? null : null // 源无授权时间，留空，不臆造
    )

    /* —— patient_conditions（主诊断 1 条 + 合并症逐条） —— */
    insCondition.run(
      `condition_${pid}_primary`, pid, md.primaryDisease, nz(md.diseaseGrade), 1,
      null, // 源仅有「病程文本」，无确诊日期 → 留空，不臆造
      nz(md.diseaseDuration), nz(md.riskStratification), nz(md.riskStratificationBasis),
      JSON.stringify(md.comorbidities || []), nz(md.organDamage)
    )
    ;(md.secondaryDiseases || []).forEach((name, i) => {
      insCondition.run(
        `condition_${pid}_secondary_${i + 1}`, pid, name, null, 0,
        null, null, null, null, JSON.stringify([]), null
      )
    })

    /* —— patient_lifestyle（1:1，tags 为 9 项行为标签 JSON） —— */
    insLifestyle.run(
      pid, nz(lf.diet), nz(lf.exercise), nz(lf.sleep), nz(lf.biggestDifficulty),
      nz(lf.motivation), nz(lf.aiStyle), JSON.stringify(lf.tags || {})
    )

    /* —— patient_targets（个体化控制目标：演示阈值唯一来源） —— */
    const dt = md.demoThreshold || {}
    // basis 承载目标相关的三处文本（basis=指南依据 / controlTarget=控制目标 / demoThresholdNote=演示阈值说明）
    // —— 22 表中 patient_targets 仅有 basis 一个叙述列，此处无损承载，供 Step 3 归一（见 Step2 记录 §待确认）
    const basisPayload = JSON.stringify({
      basis: md.targetBasis ?? null,
      controlTarget: md.controlTarget ?? null,
      demoThresholdNote: md.demoThresholdNote ?? null,
    })
    insTarget.run(
      `target_${pid}_1`, pid,
      nz(dt.systolic), nz(dt.diastolic), nz(dt.fastingGlucose), null,
      nz(dt.bmi), nz(dt.waist), null, null,
      basisPayload, null, null
    )

    /* —— medications（长期用药计划；源含占位行「暂无长期用药」亦原样保留） —— */
    ;(p.medications || []).forEach((m, i) => {
      insMedication.run(
        `med_${pid}_${i + 1}`, pid, m.name, nz(m.dosage), nz(m.time), nz(m.frequency), nz(m.note), 1
      )
    })

    /* —— doctor_patient_relations（李医生 ↔ 每位患者） —— */
    insRelation.run(`rel_${DOCTOR.doctor_id}_${pid}`, DOCTOR.doctor_id, pid)

    /* —— daily_health_records（7 天宽表；blood_sugar → fasting_glucose；waist 仅最新一行） —— */
    const records = toHealthRecords(p, parseEndDate(END))
    records.forEach((r) => {
      const isLatest = r.record_date === END
      insDaily.run(
        r.record_id, pid, r.record_date, r.steps, r.systolic_pressure, r.diastolic_pressure,
        r.blood_sugar, r.weight, isLatest ? pr.waist : null, r.heart_rate,
        r.exercise_minutes, r.sleep_hours, r.mood_score, r.notes || ''
      )
    })

    /* —— lab_results（仅糖尿病病例有结构化 HbA1c） —— */
    if (md.hba1c !== null && md.hba1c !== undefined) {
      const testDate = monthsAgo(END, Number(md.hba1cLastTestMonthsAgo) || 2)
      insLab.run(
        `lab_${pid}_hba1c`, pid, testDate, 'HbA1c', md.hba1c, '%', '<7.0', 1
      )
    }

    /* —— badges（患者已获勋章，引用 badge_definitions） —— */
    ;(p.badges || []).forEach((bg, i) => {
      insBadge.run(
        `${pid}_badge_${i + 1}`, pid, BADGE_DEF_BY_TYPE[bg.type] || null,
        `${END}T12:00:00+08:00`, 1, bg.points
      )
    })

    summary.patients.push({
      patientId: pid, name: pr.name,
      contact: ec.name, authorized: ec.authorized,
      conditions: 1 + (md.secondaryDiseases || []).length,
      medications: (p.medications || []).length,
      dailyRecords: records.length,
      badges: (p.badges || []).length,
      lab: md.hba1c != null ? 1 : 0,
    })
  }
  db.exec('COMMIT')

  /* ================================================================== *
   * 4) 校验
   * ================================================================== */
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  const counts = {}
  for (const t of [
    'patients', 'patient_contacts', 'patient_conditions', 'patient_lifestyle', 'patient_targets',
    'medications', 'doctors', 'doctor_patient_relations', 'badge_definitions', 'badges',
    'daily_health_records', 'lab_results', 'metric_definitions',
  ]) counts[t] = count(t)

  const fkViolations = db.prepare('PRAGMA foreign_key_check').all()
  const integrity = db.prepare('PRAGMA integrity_check').get()

  /* —— 每患者完整性 —— */
  const perPatient = DEMO_PATIENTS.map((p) => {
    const pid = p.id
    const q = (sql) => db.prepare(sql).get(pid)
    const daily = db.prepare(
      `SELECT record_date, waist FROM daily_health_records WHERE patient_id = ? ORDER BY record_date`
    ).all(pid)
    const dates = daily.map((x) => x.record_date)
    const consecutive = dates.every((d, i) => i === 0 || (new Date(d) - new Date(dates[i - 1])) === 86400000)
    const waistRows = daily.filter((x) => x.waist !== null)
    return {
      patientId: pid,
      name: p.profile.name,
      contact: q('SELECT COUNT(*) AS n FROM patient_contacts WHERE patient_id = ?').n,
      conditions: q('SELECT COUNT(*) AS n FROM patient_conditions WHERE patient_id = ?').n,
      primaryCondition: q('SELECT COUNT(*) AS n FROM patient_conditions WHERE patient_id = ? AND is_primary = 1').n,
      lifestyle: q('SELECT COUNT(*) AS n FROM patient_lifestyle WHERE patient_id = ?').n,
      targets: q('SELECT COUNT(*) AS n FROM patient_targets WHERE patient_id = ?').n,
      medications: q('SELECT COUNT(*) AS n FROM medications WHERE patient_id = ?').n,
      relations: q('SELECT COUNT(*) AS n FROM doctor_patient_relations WHERE patient_id = ?').n,
      badges: q('SELECT COUNT(*) AS n FROM badges WHERE patient_id = ?').n,
      dailyRecords: daily.length,
      dailyConsecutive: consecutive,
      earliest: dates[0],
      latest: dates[dates.length - 1],
      waistRows: waistRows.length,
      waistOnLatest: daily[daily.length - 1]?.waist ?? null,
    }
  })

  /* —— height / waist 归属检查（结构级） —— */
  const patientCols = db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name)
  const dailyCols = db.prepare('PRAGMA table_info(daily_health_records)').all().map((c) => c.name)
  const ownership = {
    patientsHasHeight: patientCols.includes('height'),
    patientsHasWaist: patientCols.includes('waist'),
    dailyHasWaist: dailyCols.includes('waist'),
  }

  /* —— 规则引擎复算：用数据库里的数据重放，核对是否复现原演示结论 —— */
  const replay = DEMO_PATIENTS.map((p) => {
    const pid = p.id
    const rows = db.prepare(
      `SELECT record_date, systolic_pressure, diastolic_pressure, fasting_glucose, weight, steps, exercise_minutes
       FROM daily_health_records WHERE patient_id = ? ORDER BY record_date`
    ).all(pid)
    const recordsForRules = rows.map((r) => ({
      record_date: r.record_date,
      systolic_pressure: r.systolic_pressure,
      diastolic_pressure: r.diastolic_pressure,
      blood_sugar: r.fasting_glucose, // 宽表列名 → 规则引擎字段名
      weight: r.weight,
      steps: r.steps,
      exercise_minutes: r.exercise_minutes,
    }))
    const t = db.prepare('SELECT * FROM patient_targets WHERE patient_id = ?').get(pid)
    const lab = db.prepare("SELECT test_date FROM lab_results WHERE patient_id = ? AND item_name = 'HbA1c'").get(pid)
    const medThreshold = {}
    if (t.systolic_target != null) medThreshold.systolic = t.systolic_target
    if (t.diastolic_target != null) medThreshold.diastolic = t.diastolic_target
    if (t.fasting_glucose_target != null) medThreshold.fastingGlucose = t.fasting_glucose_target
    const badgeTypes = db.prepare('SELECT bd.badge_type FROM badges b JOIN badge_definitions bd ON bd.badge_def_id = b.badge_def_id WHERE b.patient_id = ?').all(pid).map((x) => x.badge_type)
    const contact = db.prepare('SELECT authorized FROM patient_contacts WHERE patient_id = ?').get(pid)

    const patientLike = {
      profile: { emergencyContact: { authorized: !!contact?.authorized } },
      medical: {
        demoThreshold: medThreshold,
        demoThresholdNote: JSON.parse(t.basis || '{}').demoThresholdNote ?? null,
        hba1cLastTestMonthsAgo: lab ? monthsBetween(lab.test_date, END) : undefined,
      },
      lifestyle: { tags: p.lifestyle.tags },
      badges: badgeTypes.map((type) => ({ type })),
    }
    const ev = evaluateClinicalRules(patientLike, recordsForRules)
    return {
      patientId: pid,
      matchedRules: ev.matched.map((r) => r.ruleId),
      highestLevel: ev.highestLevel,
      bpCompliance: ev.stats.bloodPressure?.complianceRate ?? null,
      bgCompliance: ev.stats.bloodSugar?.complianceRate ?? null,
      weightNetChange: ev.stats.weightBehavior?.netChange ?? null,
      expectedRules: p.demoScenario.expectedRules,
      forbiddenRules: p.demoScenario.forbiddenRules,
    }
  })

  /* —— 期望值断言 —— */
  const expectations = {
    'patient_1': { must: ['R-BP-2'], mustNot: ['R-BP-3'], bpCompliance: 42.9 },
    'patient_2': { must: ['R-BG-2', 'R-BG-3'], mustNot: ['R-BG-1'], bgCompliance: 57.1 },
    'patient_3': { must: ['R-WT-2', 'R-WT-3', 'R-WT-4', 'R-WT-5'], mustNot: [], weightNetChange: -1.2 },
  }
  const assertResults = replay.map((r) => {
    const exp = expectations[r.patientId] || {}
    const mustOK = (exp.must || []).every((x) => r.matchedRules.includes(x))
    const mustNotOK = (exp.mustNot || []).every((x) => !r.matchedRules.includes(x))
    const numOK =
      (exp.bpCompliance === undefined || r.bpCompliance === exp.bpCompliance) &&
      (exp.bgCompliance === undefined || r.bgCompliance === exp.bgCompliance) &&
      (exp.weightNetChange === undefined || r.weightNetChange === exp.weightNetChange)
    return { patientId: r.patientId, mustOK, mustNotOK, numOK, ok: mustOK && mustNotOK && numOK }
  })

  const checks = {
    patientCount: counts.patients === DEMO_PATIENTS.length,
    doctorCount: counts.doctors === 1,
    badgeDefCount: counts.badge_definitions === BADGE_DEFS.length,
    perPatientComplete: perPatient.every((x) => x.contact === 1 && x.primaryCondition === 1 && x.lifestyle === 1 && x.targets === 1 && x.relations === 1 && x.medications >= 1),
    daily7Each: perPatient.every((x) => x.dailyRecords === 7),
    dailyConsecutive: perPatient.every((x) => x.dailyConsecutive),
    latestIsEnd: perPatient.every((x) => x.latest === END),
    badge2Each: perPatient.every((x) => x.badges === 2),
    ownershipHeightOnlyPatients: ownership.patientsHasHeight && !ownership.patientsHasWaist && ownership.dailyHasWaist,
    waistOnlyLatest: perPatient.every((x) => x.waistRows === 1 && x.waistOnLatest !== null),
    noFkViolations: fkViolations.length === 0,
    integrityOK: integrity?.integrity_check === 'ok',
    ruleReplayOK: assertResults.every((x) => x.ok),
  }

  const allPass = Object.values(checks).every(Boolean)

  const report = {
    generatedAt: new Date().toISOString(),
    dbPath: DB_PATH,
    driver: 'node:sqlite (DatabaseSync)',
    seedEndDate: END,
    sourceOfTruth: 'src/data/demoPatients.js',
    counts,
    perPatient,
    ownership,
    replay,
    assertResults,
    checks,
    allPass,
    foreignKeyViolations: fkViolations,
  }
  writeFileSync(RECORD_PATH, JSON.stringify(report, null, 2), 'utf8')
  db.close()

  /* ---------- 5) 控制台摘要 ---------- */
  const line = '─'.repeat(78)
  console.log(line)
  console.log('迈康 MyCare · Step 2 种子数据导入记录')
  console.log(line)
  console.log(`DB 文件        : ${DB_PATH}`)
  console.log(`唯一数据源     : src/data/demoPatients.js（直接 import）`)
  console.log(`7 天窗口末日   : ${END}（可用 SEED_END_DATE 覆盖）`)
  console.log(line)
  console.log('写入行数：')
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(26)} ${v}`)
  console.log(line)
  console.log('三位患者完整性：')
  for (const x of perPatient) {
    console.log(`  ${x.patientId} ${x.name}  daily=${x.dailyRecords}期(${x.earliest}~${x.latest}) 联系人=${x.contact} 诊断=${x.conditions}(主${x.primaryCondition}) 画像=${x.lifestyle} 目标=${x.targets} 用药=${x.medications} 关系=${x.relations} 勋章=${x.badges} waist行=${x.waistRows}(${x.waistOnLatest})`)
  }
  console.log(line)
  console.log('height / waist 归属：')
  console.log(`  patients.height=${ownership.patientsHasHeight ? 'Y' : 'N'}  patients.waist=${ownership.patientsHasWaist ? 'Y ❌' : 'N ✅'}  daily_health_records.waist=${ownership.dailyHasWaist ? 'Y ✅' : 'N ❌'}`)
  console.log(line)
  console.log('规则引擎复算（用数据库数据重放）：')
  for (const r of replay) {
    console.log(`  ${r.patientId}  命中=[${r.matchedRules.join(', ')}]  等级=${r.highestLevel}  BP达标=${r.bpCompliance}%  BG达标=${r.bgCompliance}%  体重净变化=${r.weightNetChange}kg`)
  }
  console.log('  期望断言：')
  for (const a of assertResults) {
    console.log(`    ${a.ok ? '✅' : '❌'} ${a.patientId}  must=${a.mustOK ? 'Y' : 'N'} mustNot=${a.mustNotOK ? 'Y' : 'N'} number=${a.numOK ? 'Y' : 'N'}`)
  }
  console.log(line)
  console.log('总检查：')
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✅' : '❌'} ${k}`)
  console.log(line)
  console.log(`外键违规=${fkViolations.length}  integrity_check=${integrity?.integrity_check}`)
  console.log(`记录已写入: ${RECORD_PATH}`)
  console.log(allPass ? '✅ Step 2 种子导入全部通过' : '❌ 存在未通过项，请检查上方 ❌')
  if (!allPass) process.exitCode = 2
}

function parseEndDate(end) {
  const [y, m, d] = end.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0) // 本地正午，避免时区导致串日
}

main()
