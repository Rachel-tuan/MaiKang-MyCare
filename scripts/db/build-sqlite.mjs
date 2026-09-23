#!/usr/bin/env node
/**
 * 迈康 MyCare · 第二阶段 Step 1 · SQLite 建库脚本
 * ---------------------------------------------------------------
 * 依据：src/database/schema.sql（SQLite DDL，P0 22 张表）
 * 驱动：Node 内置 node:sqlite（DatabaseSync），零第三方依赖
 *
 * 职责：
 *   1) 清理并新建 data/mycare.db
 *   2) 执行 schema.sql（PRAGMA foreign_keys=ON）
 *   3) 初始化 metric_definitions（18 条，一行一指标）
 *   4) 执行完整性 / 外键 / 唯一约束 / 索引 / 时序铁律 检查
 *   5) 输出结构化建库执行记录（data/step1-build-record.json + 控制台）
 *
 * 用法：node scripts/db/build-sqlite.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const SCHEMA_PATH = resolve(ROOT, 'src/database/schema.sql')
const DATA_DIR = resolve(ROOT, 'data')
// 目标库可用 MYCARE_DB_PATH 覆盖（演示副本库 / 验收副本库用）；默认仍是 data/mycare.db。
// 覆盖时记录文件写到目标库同名目录，避免污染真实库的 Step 1 记录。
const DB_PATH = process.env.MYCARE_DB_PATH
  ? resolve(process.env.MYCARE_DB_PATH)
  : resolve(DATA_DIR, 'mycare.db')
const RECORD_PATH = process.env.MYCARE_DB_PATH
  ? resolve(DB_PATH, '..', 'step1-build-record.demo.json')
  : resolve(DATA_DIR, 'step1-build-record.json')

/* ------------------------------------------------------------------ *
 * metric_definitions 初始化数据（Step 0.1 §4.3，18 条，一行一指标）
 * ------------------------------------------------------------------ */
const METRIC_ROWS = [
  // —— 双来源指标（default_source = daily）——
  {
    metric_key: 'systolic_pressure', name_zh: '收缩压', unit: 'mmHg', direction: 'lower',
    default_source: 'daily', available_sources: ['daily', 'readings'],
    source_binding: {
      daily: { table: 'daily_health_records', value_column: 'systolic_pressure', time_column: 'record_date' },
      readings: { table: 'blood_pressure_readings', value_column: 'systolic', time_column: 'measured_at' },
    },
    applies_to: '全部',
  },
  {
    metric_key: 'diastolic_pressure', name_zh: '舒张压', unit: 'mmHg', direction: 'lower',
    default_source: 'daily', available_sources: ['daily', 'readings'],
    source_binding: {
      daily: { table: 'daily_health_records', value_column: 'diastolic_pressure', time_column: 'record_date' },
      readings: { table: 'blood_pressure_readings', value_column: 'diastolic', time_column: 'measured_at' },
    },
    applies_to: '全部',
  },
  {
    metric_key: 'fasting_glucose', name_zh: '空腹血糖', unit: 'mmol/L', direction: 'lower',
    default_source: 'daily', available_sources: ['daily', 'readings'],
    source_binding: {
      daily: { table: 'daily_health_records', value_column: 'fasting_glucose', time_column: 'record_date' },
      readings: { table: 'blood_glucose_readings', value_column: 'value', time_column: 'measured_at', filter: { measure_type: '空腹' } },
    },
    applies_to: '糖尿病 / 高危',
  },
  {
    metric_key: 'weight', name_zh: '体重', unit: 'kg', direction: 'stable',
    default_source: 'daily', available_sources: ['daily', 'readings'],
    source_binding: {
      daily: { table: 'daily_health_records', value_column: 'weight', time_column: 'record_date' },
      readings: { table: 'weight_readings', value_column: 'weight', time_column: 'measured_at', built: false },
    },
    applies_to: '超重 / 肥胖',
  },
  // —— 单来源：daily ——
  {
    metric_key: 'heart_rate', name_zh: '静息心率', unit: '次/分', direction: 'range',
    default_source: 'daily', available_sources: ['daily'],
    source_binding: { daily: { table: 'daily_health_records', value_column: 'heart_rate', time_column: 'record_date' } },
    applies_to: '全部',
  },
  {
    metric_key: 'steps', name_zh: '步数', unit: '步', direction: 'higher',
    default_source: 'daily', available_sources: ['daily'],
    source_binding: { daily: { table: 'daily_health_records', value_column: 'steps', time_column: 'record_date' } },
    applies_to: '全部',
  },
  {
    metric_key: 'exercise_minutes', name_zh: '运动时长', unit: '分钟', direction: 'higher',
    default_source: 'daily', available_sources: ['daily'],
    source_binding: { daily: { table: 'daily_health_records', value_column: 'exercise_minutes', time_column: 'record_date' } },
    applies_to: '全部',
  },
  {
    metric_key: 'sleep_hours', name_zh: '睡眠时长', unit: '小时', direction: 'higher',
    default_source: 'daily', available_sources: ['daily'],
    source_binding: { daily: { table: 'daily_health_records', value_column: 'sleep_hours', time_column: 'record_date' } },
    applies_to: '全部',
  },
  {
    metric_key: 'mood_score', name_zh: '心情评分', unit: '1–5', direction: 'higher',
    default_source: 'daily', available_sources: ['daily'],
    source_binding: { daily: { table: 'daily_health_records', value_column: 'mood_score', time_column: 'record_date' } },
    applies_to: '全部',
  },
  {
    metric_key: 'waist', name_zh: '腰围', unit: 'cm', direction: 'lower',
    default_source: 'daily', available_sources: ['daily'],
    source_binding: { daily: { table: 'daily_health_records', value_column: 'waist', time_column: 'record_date' } },
    applies_to: '中心性肥胖',
  },
  // —— 单来源：readings ——
  {
    metric_key: 'pulse', name_zh: '脉搏', unit: '次/分', direction: 'range',
    default_source: 'readings', available_sources: ['readings'],
    source_binding: { readings: { table: 'blood_pressure_readings', value_column: 'pulse', time_column: 'measured_at' } },
    applies_to: '全部',
  },
  {
    metric_key: 'postprandial_glucose', name_zh: '餐后 2h 血糖', unit: 'mmol/L', direction: 'lower',
    default_source: 'readings', available_sources: ['readings'],
    source_binding: { readings: { table: 'blood_glucose_readings', value_column: 'value', time_column: 'measured_at', filter: { measure_type: '餐后2h' } } },
    applies_to: '糖尿病',
  },
  {
    metric_key: 'body_fat', name_zh: '体脂率', unit: '%', direction: 'lower',
    default_source: 'readings', available_sources: ['readings'],
    source_binding: { readings: { table: 'weight_readings', value_column: 'body_fat', time_column: 'measured_at', built: false } },
    applies_to: '超重 / 肥胖',
  },
  // —— 单来源：lab ——
  {
    metric_key: 'hba1c', name_zh: '糖化血红蛋白', unit: '%', direction: 'lower',
    default_source: 'lab', available_sources: ['lab'],
    source_binding: { lab: { table: 'lab_results', value_column: 'value', time_column: 'test_date', filter: { item_name: 'HbA1c' } } },
    applies_to: '糖尿病',
  },
  {
    metric_key: 'tg', name_zh: '甘油三酯', unit: 'mmol/L', direction: 'lower',
    default_source: 'lab', available_sources: ['lab'],
    source_binding: { lab: { table: 'lab_results', value_column: 'value', time_column: 'test_date', filter: { item_name: 'TG' } } },
    applies_to: '血脂异常',
  },
  {
    metric_key: 'hdl_c', name_zh: '高密度脂蛋白胆固醇', unit: 'mmol/L', direction: 'higher',
    default_source: 'lab', available_sources: ['lab'],
    source_binding: { lab: { table: 'lab_results', value_column: 'value', time_column: 'test_date', filter: { item_name: 'HDL-C' } } },
    applies_to: '血脂异常',
  },
  {
    metric_key: 'ldl_c', name_zh: '低密度脂蛋白胆固醇', unit: 'mmol/L', direction: 'lower',
    default_source: 'lab', available_sources: ['lab'],
    source_binding: { lab: { table: 'lab_results', value_column: 'value', time_column: 'test_date', filter: { item_name: 'LDL-C' } } },
    applies_to: '血脂异常',
  },
  {
    metric_key: 'urine_microalbumin', name_zh: '尿微量白蛋白', unit: 'mg/L', direction: 'lower',
    default_source: 'lab', available_sources: ['lab'],
    source_binding: { lab: { table: 'lab_results', value_column: 'value', time_column: 'test_date', filter: { item_name: '尿微量白蛋白' } } },
    applies_to: '高血压 / 糖尿病',
  },
]

/* ------------------------------------------------------------------ *
 * 期望的 P0 22 张表 & 时序铁律（用于自检）
 * ------------------------------------------------------------------ */
const EXPECTED_TABLES = [
  // 1-10 主数据/元数据
  'patients', 'patient_contacts', 'patient_conditions', 'patient_lifestyle', 'patient_targets',
  'medications', 'doctors', 'doctor_patient_relations', 'metric_definitions', 'badge_definitions',
  // 11-14 时序·健康指标
  'daily_health_records', 'blood_pressure_readings', 'blood_glucose_readings', 'lab_results',
  // 15-20 事件
  'alerts', 'reminders', 'doctor_notes', 'medication_logs', 'agent_runs', 'vision_records',
  // 21-22 处方 / 激励
  'prescriptions', 'badges',
]

// 时序表铁律：patient_id + 时间字段 + source；测量事实型另带 record_status
const TIMESERIES_SPEC = [
  { table: 'daily_health_records', time: 'record_date', fact: true },
  { table: 'blood_pressure_readings', time: 'measured_at', fact: true },
  { table: 'blood_glucose_readings', time: 'measured_at', fact: true },
  { table: 'lab_results', time: 'test_date', fact: true },
  { table: 'medication_logs', time: 'planned_time', fact: true },
  { table: 'alerts', time: 'created_at', fact: false },
  { table: 'doctor_notes', time: 'created_at', fact: false },
  { table: 'agent_runs', time: 'created_at', fact: false },
  { table: 'vision_records', time: 'created_at', fact: false },
]

const FORBIDDEN_TABLES = ['weight_readings', 'point_transactions', 'user_levels', 'community_activities', 'user_activity_participations']

/* ------------------------------------------------------------------ */
function main() {
  mkdirSync(DATA_DIR, { recursive: true })

  // 1) 干净重建
  let rebuilt = false
  if (existsSync(DB_PATH)) { rmSync(DB_PATH); rebuilt = true }

  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA foreign_keys = ON;')

  // 2) 执行 schema
  const ddl = readFileSync(SCHEMA_PATH, 'utf8')
  const statements = ddl.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter((s) => s && !s.startsWith('--') && !/^PRAGMA\s+foreign_keys/i.test(s))
  db.exec(ddl)

  // 3) 初始化 metric_definitions
  const insMetric = db.prepare(
    `INSERT INTO metric_definitions
      (metric_key, name_zh, unit, direction, default_source, available_sources, source_binding, applies_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const metricErrors = []
  for (const m of METRIC_ROWS) {
    const avail = m.available_sources
    if (!avail.includes(m.default_source)) {
      metricErrors.push(`${m.metric_key}: default_source(${m.default_source}) ∉ available_sources`)
    }
    insMetric.run(
      m.metric_key, m.name_zh, m.unit, m.direction,
      m.default_source, JSON.stringify(avail), JSON.stringify(m.source_binding), m.applies_to
    )
  }

  // 4) 检查
  const integrity = db.prepare('PRAGMA integrity_check').get()
  const fkCheck = db.prepare('PRAGMA foreign_key_check').all()
  const fkOn = db.prepare('PRAGMA foreign_keys').get()

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)

  const tableDetail = tables.map((t) => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => ({ name: c.name, type: c.type, notnull: !!c.notnull, pk: c.pk, dflt: c.dflt_value }))
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => ({ from: f.from, table: f.table, to: f.to, on_delete: f.on_delete }))
    const idxList = db.prepare(`PRAGMA index_list(${t})`).all()
    const indexes = idxList.map((ix) => ({
      name: ix.name, unique: !!ix.unique, origin: ix.origin, // c=CREATE INDEX, u=UNIQUE constraint, pk=PRIMARY KEY
      columns: db.prepare(`PRAGMA index_info(${ix.name})`).all().map((c) => c.name),
    }))
    return { table: t, columnCount: cols.length, columns: cols, foreignKeys: fks, indexes }
  })

  // 时序铁律自检
  const tsChecks = TIMESERIES_SPEC.map((spec) => {
    const det = tableDetail.find((d) => d.table === spec.table)
    const colNames = det ? det.columns.map((c) => c.name) : []
    const hasPatient = colNames.includes('patient_id')
    const hasTime = colNames.includes(spec.time)
    const hasSource = colNames.includes('source')
    const hasRecordStatus = colNames.includes('record_status')
    const hasCompositeIndex = det
      ? det.indexes.some((ix) => ix.columns[0] === 'patient_id' && ix.columns[1] === spec.time)
      : false
    const rsOK = spec.fact ? hasRecordStatus === true : hasRecordStatus === false
    return {
      table: spec.table, type: spec.fact ? '测量事实型' : '事件型', timeColumn: spec.time,
      patient_id: hasPatient, source: hasSource, record_status: hasRecordStatus,
      record_status_rule_ok: rsOK, compositeIndex: hasCompositeIndex,
      ok: hasPatient && hasTime && hasSource && rsOK && hasCompositeIndex,
    }
  })

  // 唯一约束检查（origin='u' 或 复合 UNIQUE）
  const uniqueChecks = [
    { table: 'patients', desc: 'username UNIQUE', ok: tableDetail.find((d) => d.table === 'patients')?.columns.some((c) => c.name === 'username') ?? false },
    { table: 'daily_health_records', desc: 'UNIQUE(patient_id, record_date)', ok: idxHasUnique(tableDetail, 'daily_health_records', ['patient_id', 'record_date']) },
    { table: 'doctor_patient_relations', desc: 'UNIQUE(doctor_id, patient_id)', ok: idxHasUnique(tableDetail, 'doctor_patient_relations', ['doctor_id', 'patient_id']) },
    { table: 'metric_definitions', desc: 'PK(metric_key) 一行一指标', ok: tableDetail.find((d) => d.table === 'metric_definitions')?.columns.some((c) => c.name === 'metric_key' && c.pk === 1) ?? false },
    { table: 'patient_lifestyle', desc: 'PK(patient_id) 一对一', ok: tableDetail.find((d) => d.table === 'patient_lifestyle')?.columns.some((c) => c.name === 'patient_id' && c.pk === 1) ?? false },
  ]

  const metricCount = db.prepare('SELECT COUNT(*) AS n FROM metric_definitions').get().n
  const metricRows = db.prepare('SELECT metric_key, default_source, available_sources FROM metric_definitions ORDER BY metric_key').all()
  const metricJsonOK = metricRows.every((r) => {
    try { const a = JSON.parse(r.available_sources); return Array.isArray(a) && a.includes(r.default_source) } catch { return false }
  })

  const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t))
  const extra = tables.filter((t) => !EXPECTED_TABLES.includes(t))
  const forbiddenPresent = FORBIDDEN_TABLES.filter((t) => tables.includes(t))

  const report = {
    generatedAt: new Date().toISOString(),
    dbPath: DB_PATH,
    driver: 'node:sqlite (DatabaseSync)',
    rebuilt,
    ddlStatementCount: statements.length,
    pragmaForeignKey: fkOn?.foreign_keys === 1 || fkOn?.foreign_keys === true,
    integrityCheck: integrity?.integrity_check,
    foreignKeyCheckViolations: fkCheck.length,
    tableCount: tables.length,
    expectedTableCount: EXPECTED_TABLES.length,
    tables,
    missingTables: missing,
    extraTables: extra,
    forbiddenTablesPresent: forbiddenPresent,
    metricDefinitions: { count: metricCount, expected: METRIC_ROWS.length, allDefaultInAvailable: metricJsonOK, errors: metricErrors },
    timeSeriesSpecChecks: tsChecks,
    uniqueChecks,
    tableDetail,
  }

  writeFileSync(RECORD_PATH, JSON.stringify(report, null, 2), 'utf8')
  db.close()

  // ---- 控制台摘要 ----
  const line = '─'.repeat(78)
  console.log(line)
  console.log('迈康 MyCare · Step 1 建库执行记录')
  console.log(line)
  console.log(`DB 文件        : ${DB_PATH}`)
  console.log(`驱动           : node:sqlite（零第三方依赖）`)
  console.log(`干净重建       : ${rebuilt ? '是（已删除旧文件）' : '否（新建）'}`)
  console.log(`foreign_keys   : ${report.pragmaForeignKey ? 'ON ✅' : 'OFF ❌'}`)
  console.log(`integrity_check: ${report.integrityCheck} ${report.integrityCheck === 'ok' ? '✅' : '❌'}`)
  console.log(`外键违规       : ${report.foreignKeyCheckViolations} ${report.foreignKeyCheckViolations === 0 ? '✅' : '❌'}`)
  console.log(line)
  console.log(`表数量         : ${report.tableCount} / 期望 ${report.expectedTableCount} ${report.tableCount === report.expectedTableCount ? '✅' : '❌'}`)
  console.log(`缺失表         : ${missing.length ? missing.join(', ') : '无 ✅'}`)
  console.log(`多余表         : ${extra.length ? extra.join(', ') : '无 ✅'}`)
  console.log(`P1/P2 误入     : ${forbiddenPresent.length ? forbiddenPresent.join(', ') : '无 ✅'}`)
  console.log(line)
  console.log(`metric_definitions: ${metricCount} / 期望 ${METRIC_ROWS.length} ${metricCount === METRIC_ROWS.length ? '✅' : '❌'} | default∈available: ${metricJsonOK ? '✅' : '❌'}`)
  console.log(line)
  console.log('时序表铁律自检：')
  for (const c of tsChecks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.table.padEnd(26)} ${c.type}  time=${c.timeColumn.padEnd(12)} patient_id=${c.patient_id ? 'Y' : 'N'} source=${c.source ? 'Y' : 'N'} record_status=${c.record_status ? 'Y' : 'N'}(${c.record_status_rule_ok ? '合规' : '违规'}) idx(patient_id,time)=${c.compositeIndex ? 'Y' : 'N'}`)
  }
  console.log(line)
  console.log('唯一约束检查：')
  for (const u of uniqueChecks) console.log(`  ${u.ok ? '✅' : '❌'} ${u.table} — ${u.desc}`)
  console.log(line)
  console.log(`建库执行记录已写入: ${RECORD_PATH}`)
}

function idxHasUnique(detail, table, cols) {
  const d = detail.find((x) => x.table === table)
  if (!d) return false
  return d.indexes.some((ix) => ix.unique && ix.columns.length === cols.length && cols.every((c, i) => ix.columns[i] === c))
}

main()
