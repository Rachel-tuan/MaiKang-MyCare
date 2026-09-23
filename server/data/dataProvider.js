/**
 * 迈康 MyCare · 后端 dataProvider（第二阶段 Step 3）
 * ===========================================================================
 * 依据：docs/Step0.1_取数契约冻结_v0.1.md（已批准）
 * 定位：**页面与 Agent 唯一的取数入口**，位于后端，直接查询 SQLite。
 *
 * 三契约：
 *   · getSeries(patientId, metricKey, days = 7, options = {}) => SeriesResult
 *   · getDailySnapshot(patientId, date = <今天·东八区>)        => SnapshotResult
 *   · getPatientProfile(patientId)                            => ProfileResult
 * 辅助：
 *   · toUserProfileView(profile)  —— 纯函数，把 ProfileResult 还原成现有
 *     demoPatients.js → toUserProfile() 的同形对象（派生视图，不是数据源）。
 *
 * 铁律（Step 3 边界）：
 *   1. 所有数据均从 SQLite 查询；**不读取 src/data/demoPatients.js**（静态与运行时双重证明见验证脚本）。
 *   2. patient_id 为唯一规范键；缺失 → E_INVALID_ARG，查不到 → E_PATIENT_NOT_FOUND；**禁止默认患者兜底**。
 *   3. metricKey 必须从 metric_definitions 解析，未注册 → E_UNKNOWN_METRIC。
 *   4. options.source 必须 ∈ available_sources；来源表未建（P1/P2）→ E_INVALID_ARG + detail.reason='source_not_built'。
 *   5. BMI / 年龄 / 趋势 / 均值 / 达标率等派生值一律现算，不落库。
 *   6. 「查无数据」不抛错，返回空结构。
 */
import { DataProviderError, ERROR_CODES, asDataProviderError } from './errors.js'
import { openDb, get, all, tableExists, tableColumns, DB_PATH } from './db.js'

/* ================================================================== *
 * 常量与工具
 * ================================================================== */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86400000

/** metricKey → patient_targets 的目标列（无对应者返回 null，不臆造） */
const METRIC_TARGET_COLUMN = {
  systolic_pressure: 'systolic_target',
  diastolic_pressure: 'diastolic_target',
  fasting_glucose: 'fasting_glucose_target',
  hba1c: 'hba1c_target',
  waist: 'waist_target',
  steps: 'steps_target',
}

const DEFAULT_RECORD_STATUSES = ['valid', 'corrected']

const round = (n, d = 1) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null
  const p = 10 ** d
  return Math.round((Number(n) + Number.EPSILON) * p) / p
}

const toNum = (v) => (v === null || v === undefined ? null : Number(v))
const toBool = (v) => (v === null || v === undefined ? null : Boolean(v))

/** 东八区「今天」YYYY-MM-DD */
export function todayCST(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const t = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s
}

function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + delta)
  return t.toISOString().slice(0, 10)
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY_MS)
}

/** age 由 birth_date 现算（不落库） */
export function calcAge(birthDate, onDate = todayCST()) {
  if (!isValidDateStr(birthDate)) return null
  const [by, bm, bd] = birthDate.split('-').map(Number)
  const [oy, om, od] = onDate.split('-').map(Number)
  let age = oy - by
  if (om < bm || (om === bm && od < bd)) age -= 1
  return age
}

const safeJson = (text, fallback) => {
  if (text === null || text === undefined || text === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/* ================================================================== *
 * 断言
 * ================================================================== */

function assertPatientId(patientId, fn) {
  if (typeof patientId !== 'string' || patientId.trim() === '') {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'patientId 必填且不能为空', {
      fn,
      patientId: patientId ?? null,
    })
  }
}

function assertPatientExists(patientId, fn) {
  const row = get('SELECT patient_id, name FROM patients WHERE patient_id = ?', patientId)
  if (!row) {
    throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到患者：${patientId}`, {
      fn,
      patientId,
    })
  }
  return row
}

function assertDays(days) {
  const n = Number(days)
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'days 必须为 1–365 的整数', { days })
  }
  return n
}

/* ================================================================== *
 * metric_definitions 解析与来源消歧（契约 §4.2 / §1.1 规则 1–4）
 * ================================================================== */

function loadMetric(metricKey) {
  if (typeof metricKey !== 'string' || metricKey.trim() === '') {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'metricKey 必填且不能为空', { metricKey })
  }
  const def = get(
    'SELECT metric_key, name_zh, unit, direction, default_source, available_sources, source_binding FROM metric_definitions WHERE metric_key = ?',
    metricKey
  )
  if (!def) {
    throw new DataProviderError(ERROR_CODES.E_UNKNOWN_METRIC, `指标未在 metric_definitions 注册：${metricKey}`, {
      metricKey,
    })
  }
  return def
}

/**
 * source 解析：
 *   1. 未传 source → default_source
 *   2. 传了 source → 必须 ∈ available_sources，否则 E_INVALID_ARG
 *   3. source 合法但来源表未建（built:false 或表不存在）→ E_INVALID_ARG + detail.reason='source_not_built'
 *   4. 返回 resolvedSource（物理表名）与 sourceKey（枚举）
 */
function resolveSource(def, requestedSource) {
  const available = safeJson(def.available_sources, [])
  const bindingMap = safeJson(def.source_binding, {})
  const sourceKey = requestedSource || def.default_source

  if (requestedSource && !available.includes(requestedSource)) {
    throw new DataProviderError(
      ERROR_CODES.E_INVALID_ARG,
      `来源 "${requestedSource}" 不属于指标 ${def.metric_key} 的 available_sources [${available.join(', ')}]`,
      { metricKey: def.metric_key, requestedSource, availableSources: available }
    )
  }

  const binding = bindingMap[sourceKey]
  if (!binding) {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, `来源 "${sourceKey}" 无解析绑定`, {
      metricKey: def.metric_key,
      source: sourceKey,
      reason: 'source_not_built',
    })
  }
  if (binding.built === false || !tableExists(binding.table)) {
    throw new DataProviderError(
      ERROR_CODES.E_INVALID_ARG,
      `来源 "${sourceKey}" 的物理表 ${binding.table} 尚未建立（P1/P2 延后）；不静默回落到 default_source`,
      {
        metricKey: def.metric_key,
        source: sourceKey,
        table: binding.table,
        reason: 'source_not_built',
      }
    )
  }
  return { sourceKey, resolvedSource: binding.table, binding }
}

/* ================================================================== *
 * 时间窗口（契约 §5）
 * ================================================================== */

function anchorDateFor(patientId, binding, anchorMode) {
  if (anchorMode === 'today') return todayCST()
  // 'latest'：该患者该来源最新一条记录的日期；无记录 → 回落今天（窗口仍成立，结果为空）
  const dateExpr = `substr(${binding.time_column}, 1, 10)`
  const row = get(
    `SELECT MAX(${dateExpr}) AS latest FROM ${binding.table} WHERE patient_id = ?`,
    patientId
  )
  return row?.latest || todayCST()
}

function resolveWindow(patientId, binding, days, options = {}) {
  const anchorMode = options.anchorMode === 'today' ? 'today' : 'latest'
  const hasFrom = options.from !== undefined && options.from !== null
  const hasTo = options.to !== undefined && options.to !== null

  if (hasFrom && !isValidDateStr(options.from)) {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'options.from 必须为 YYYY-MM-DD', { from: options.from })
  }
  if (hasTo && !isValidDateStr(options.to)) {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'options.to 必须为 YYYY-MM-DD', { to: options.to })
  }

  let to
  let from
  if (hasTo) {
    to = options.to
  } else {
    to = anchorDateFor(patientId, binding, anchorMode)
  }
  if (hasFrom) {
    from = options.from
  } else {
    from = addDays(to, -(days - 1))
  }
  if (daysBetween(from, to) < 0) {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '时间窗口起点晚于终点', { from, to })
  }
  return { days, from, to, anchorMode }
}

/* ================================================================== *
 * 序列查询与统计
 * ================================================================== */

function querySeries(patientId, binding, window, options = {}) {
  const { table, time_column: timeCol, value_column: valueCol } = binding
  const cols = tableColumns(table)
  const dateExpr = `substr(${timeCol}, 1, 10)`

  const params = [patientId, window.from, window.to]
  let where = `patient_id = ? AND ${dateExpr} BETWEEN ? AND ? AND ${valueCol} IS NOT NULL`

  // 来源绑定内置过滤（如血糖 measure_type='空腹'、化验 item_name='HbA1c'）
  const filter = binding.filter || {}
  for (const [col, val] of Object.entries(filter)) {
    where += ` AND ${col} = ?`
    params.push(val)
  }
  // options.measureType 在绑定过滤之上再收窄（不覆盖）
  if (options.measureType && cols.has('measure_type')) {
    where += ' AND measure_type = ?'
    params.push(options.measureType)
  }
  // 记录质控白名单（仅事实型表有 record_status）
  const statusList = Array.isArray(options.includeRecordStatus)
    ? options.includeRecordStatus
    : DEFAULT_RECORD_STATUSES
  if (cols.has('record_status')) {
    where += ` AND record_status IN (${statusList.map(() => '?').join(', ')})`
    params.push(...statusList)
  }

  const statusExpr = cols.has('record_status') ? 'record_status' : 'NULL AS record_status'
  const sql = `SELECT ${timeCol} AS at, ${valueCol} AS value, source, ${statusExpr}
               FROM ${table} WHERE ${where} ORDER BY ${timeCol} ASC`
  return all(sql, ...params)
}

function computeStats(points) {
  if (!points.length) return null
  const values = points.map((p) => p.value)
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const min = Math.min(...values)
  const max = Math.max(...values)
  const first = values[0]
  const latest = values[n - 1]
  const change = latest - first
  const pctChange = first !== 0 ? (change / first) * 100 : 0

  // 最小二乘：x 用「距首点的天数」，得到 单位/天 的斜率
  const firstDate = points[0].date
  const xs = points.map((p) => daysBetween(firstDate, p.date))
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - meanX) * (values[i] - mean)
    den += (xs[i] - meanX) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  const intercept = mean - slope * meanX

  let ssTot = 0
  let ssRes = 0
  for (let i = 0; i < n; i += 1) {
    ssTot += (values[i] - mean) ** 2
    ssRes += (values[i] - (slope * xs[i] + intercept)) ** 2
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot)
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))

  let direction = 'stable'
  const significant = r2 > 0.25 && Math.abs(slope) > sd * 0.15
  if (significant) direction = slope > 0 ? 'rising' : 'falling'
  else if (Math.abs(pctChange) > 8) direction = pctChange > 0 ? 'rising' : 'falling'

  return {
    first: round(first, 1),
    latest: round(latest, 1),
    latestDate: points[n - 1].date,
    min: round(min, 1),
    max: round(max, 1),
    mean: round(mean, 1),
    range: round(max - min, 1),
    change: round(change, 1),
    pctChange: round(pctChange, 1),
    slope: round(slope, 2),
    direction,
  }
}

/* ================================================================== *
 * 1.1 getSeries
 * ================================================================== */

export async function getSeries(patientId, metricKey, days = 7, options = {}) {
  try {
    assertPatientId(patientId, 'getSeries')
    const safeDays = assertDays(days)
    assertPatientExists(patientId, 'getSeries')

    const def = loadMetric(metricKey)
    const { sourceKey, resolvedSource, binding } = resolveSource(def, options.source)
    const window = resolveWindow(patientId, binding, safeDays, options)

    const rows = querySeries(patientId, binding, window, options)
    const points = rows.map((r) => ({
      date: String(r.at).slice(0, 10),
      at: r.at,
      value: toNum(r.value),
      source: r.source,
      recordStatus: r.record_status ?? null,
    }))

    const target = loadMetricTarget(patientId, metricKey)

    return {
      patientId,
      metricKey,
      resolvedSource,
      sourceKey,
      label: def.name_zh,
      unit: def.unit,
      direction: def.direction,
      target,
      window,
      points,
      count: points.length,
      empty: points.length === 0,
      stats: points.length ? computeStats(points) : null,
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'getSeries', patientId, metricKey })
  }
}

function loadMetricTarget(patientId, metricKey) {
  const col = METRIC_TARGET_COLUMN[metricKey]
  if (!col) return null
  // ⚠️ F-1（Step 11 实测）：不得用 `ORDER BY COALESCE(effective_from,'') DESC` ——
  // 库里 effective_from 全为 NULL 时排序键完全相同，医生新增的调整行会**读不到**（且不报错）。
  // 改为按写入顺序倒序，保证「最新一行」稳定可见。
  const row = get(
    `SELECT ${col} AS target FROM patient_targets WHERE patient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    patientId
  )
  return row?.target ?? null
}

/* ================================================================== *
 * 1.2 getDailySnapshot
 * ================================================================== */

export async function getDailySnapshot(patientId, date = todayCST()) {
  try {
    assertPatientId(patientId, 'getDailySnapshot')
    if (!isValidDateStr(date)) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'date 必须为 YYYY-MM-DD', { date })
    }
    assertPatientExists(patientId, 'getDailySnapshot')

    const row = get(
      'SELECT * FROM daily_health_records WHERE patient_id = ? AND record_date = ?',
      patientId,
      date
    )

    const details = { blood_pressure: [], blood_glucose: [], weight: [] }

    if (tableExists('blood_pressure_readings')) {
      details.blood_pressure = all(
        `SELECT reading_id, measured_at, systolic, diastolic, pulse, slot, source, record_status
         FROM blood_pressure_readings
         WHERE patient_id = ? AND substr(measured_at, 1, 10) = ?
         ORDER BY measured_at ASC`,
        patientId,
        date
      ).map((r) => ({
        readingId: r.reading_id,
        at: r.measured_at,
        systolic: toNum(r.systolic),
        diastolic: toNum(r.diastolic),
        pulse: toNum(r.pulse),
        slot: r.slot ?? null,
        source: r.source,
        recordStatus: r.record_status ?? null,
      }))
    }

    if (tableExists('blood_glucose_readings')) {
      details.blood_glucose = all(
        `SELECT reading_id, measured_at, value, measure_type, source, record_status
         FROM blood_glucose_readings
         WHERE patient_id = ? AND substr(measured_at, 1, 10) = ?
         ORDER BY measured_at ASC`,
        patientId,
        date
      ).map((r) => ({
        readingId: r.reading_id,
        at: r.measured_at,
        value: toNum(r.value),
        measureType: r.measure_type,
        source: r.source,
        recordStatus: r.record_status ?? null,
      }))
    }

    // weight_readings 属 P1，Step 1 未建 → 恒为空数组（不臆造）
    if (tableExists('weight_readings')) {
      details.weight = all(
        `SELECT reading_id, measured_at, weight, source, record_status
         FROM weight_readings
         WHERE patient_id = ? AND substr(measured_at, 1, 10) = ?
         ORDER BY measured_at ASC`,
        patientId,
        date
      ).map((r) => ({
        readingId: r.reading_id,
        at: r.measured_at,
        value: toNum(r.weight),
        source: r.source,
        recordStatus: r.record_status ?? null,
      }))
    }

    const lab = all(
      `SELECT item_name, value, unit, reference_range, is_abnormal
       FROM lab_results
       WHERE patient_id = ? AND test_date = ? ORDER BY item_name ASC`,
      patientId,
      date
    ).map((r) => ({
      itemName: r.item_name,
      value: toNum(r.value),
      unit: r.unit ?? null,
      referenceRange: r.reference_range ?? null,
      isAbnormal: toBool(r.is_abnormal),
    }))

    if (!row) {
      return {
        patientId,
        date,
        exists: false,
        values: null,
        details,
        lab,
        meta: null,
      }
    }

    return {
      patientId,
      date,
      exists: true,
      values: {
        systolic_pressure: toNum(row.systolic_pressure),
        diastolic_pressure: toNum(row.diastolic_pressure),
        fasting_glucose: toNum(row.fasting_glucose),
        weight: toNum(row.weight),
        waist: toNum(row.waist),
        heart_rate: toNum(row.heart_rate),
        steps: toNum(row.steps),
        exercise_minutes: toNum(row.exercise_minutes),
        sleep_hours: toNum(row.sleep_hours),
        mood_score: toNum(row.mood_score),
        notes: row.notes ?? '',
      },
      details,
      lab,
      meta: {
        source: row.source,
        recordStatus: row.record_status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'getDailySnapshot', patientId, date })
  }
}

/* ================================================================== *
 * 1.3 getPatientProfile
 * ================================================================== */

export async function getPatientProfile(patientId) {
  try {
    assertPatientId(patientId, 'getPatientProfile')
    const p = assertPatientExists(patientId, 'getPatientProfile')

    // —— identity（全部来自 patients；height 唯一归属本表；不含 waist） ——
    const full = get('SELECT * FROM patients WHERE patient_id = ?', patientId)
    const identity = {
      username: full.username,
      name: full.name,
      gender: full.gender,
      birthDate: full.birth_date ?? null,
      age: calcAge(full.birth_date), // 现算，不落库
      height: toNum(full.height), // ★ height 唯一归属 patients
      phone: full.phone ?? null,
      occupation: full.occupation ?? null,
      elderlyMode: toBool(full.elderly_mode),
      voiceEnabled: toBool(full.voice_enabled),
      isActive: toBool(full.is_active),
    }

    // —— latestMeasurements（读 daily_health_records 最新一行；waist 在此，不在 identity） ——
    const latestDaily = get(
      `SELECT record_date, weight, waist, systolic_pressure, diastolic_pressure, fasting_glucose, heart_rate
       FROM daily_health_records WHERE patient_id = ? ORDER BY record_date DESC LIMIT 1`,
      patientId
    )
    const latestMeasurements = latestDaily
      ? {
          date: latestDaily.record_date,
          weight: toNum(latestDaily.weight),
          waist: toNum(latestDaily.waist),
          systolicPressure: toNum(latestDaily.systolic_pressure),
          diastolicPressure: toNum(latestDaily.diastolic_pressure),
          fastingGlucose: toNum(latestDaily.fasting_glucose),
          heartRate: toNum(latestDaily.heart_rate),
        }
      : null

    // —— contacts ——
    const contacts = all(
      `SELECT contact_id, contact_name, relation, contact_phone, authorized, authorized_at
       FROM patient_contacts WHERE patient_id = ? ORDER BY contact_id ASC`,
      patientId
    ).map((c) => ({
      contactId: c.contact_id,
      name: c.contact_name,
      relation: c.relation ?? null,
      phone: c.contact_phone ?? null,
      authorized: Boolean(c.authorized),
      authorizedAt: c.authorized_at ?? null,
    }))

    // —— conditions ——
    const conditions = all(
      `SELECT condition_id, disease_name, disease_grade, is_primary, diagnosed_at, duration_text,
              risk_stratification, risk_basis, comorbidities, organ_damage
       FROM patient_conditions WHERE patient_id = ?
       ORDER BY is_primary DESC, condition_id ASC`,
      patientId
    ).map((c) => ({
      conditionId: c.condition_id,
      diseaseName: c.disease_name,
      diseaseGrade: c.disease_grade ?? null,
      isPrimary: Boolean(c.is_primary),
      diagnosedAt: c.diagnosed_at ?? null,
      durationText: c.duration_text ?? null,
      riskStratification: c.risk_stratification ?? null,
      riskBasis: c.risk_basis ?? null,
      comorbidities: safeJson(c.comorbidities, []),
      organDamage: c.organ_damage ?? null,
    }))

    // —— lifestyle（1:1） ——
    const lf = get('SELECT * FROM patient_lifestyle WHERE patient_id = ?', patientId)
    const lifestyle = lf
      ? {
          diet: lf.diet ?? null,
          exercise: lf.exercise ?? null,
          sleep: lf.sleep ?? null,
          biggestDifficulty: lf.biggest_difficulty ?? null,
          motivation: lf.motivation ?? null,
          aiStyle: lf.ai_style ?? null,
          tags: safeJson(lf.tags, {}),
          updatedAt: lf.updated_at,
        }
      : null

    // —— targets（basis 为无损 JSON：basis / controlTarget / demoThresholdNote） ——
    // ⚠️ F-1：排序键必须稳定（created_at DESC, rowid DESC），见 loadMetricTarget 注释。
    const tg = get(
      `SELECT * FROM patient_targets WHERE patient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      patientId
    )
    let targets = null
    if (tg) {
      const payload = safeJson(tg.basis, null)
      const isPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
      targets = {
        systolicTarget: toNum(tg.systolic_target),
        diastolicTarget: toNum(tg.diastolic_target),
        fastingGlucoseTarget: toNum(tg.fasting_glucose_target),
        hba1cTarget: toNum(tg.hba1c_target),
        bmiTarget: toNum(tg.bmi_target),
        waistTarget: toNum(tg.waist_target),
        stepsTarget: toNum(tg.steps_target),
        weightChangeTarget: toNum(tg.weight_change_target),
        // 无损承载：拆出三处文本，同时保留原始 JSON
        basis: isPayload ? (payload.basis ?? null) : (tg.basis ?? null),
        controlTarget: isPayload ? (payload.controlTarget ?? null) : null,
        demoThresholdNote: isPayload ? (payload.demoThresholdNote ?? null) : null,
        basisRaw: tg.basis ?? null,
        effectiveFrom: tg.effective_from ?? null,
        setBy: tg.set_by ?? null,
      }
    }

    // —— medications ——
    const medications = all(
      `SELECT medication_id, name, dosage, time, frequency, note, is_active
       FROM medications WHERE patient_id = ? ORDER BY medication_id ASC`,
      patientId
    ).map((m) => ({
      medicationId: m.medication_id,
      name: m.name,
      dosage: m.dosage ?? null,
      time: m.time ?? null,
      frequency: m.frequency ?? null,
      note: m.note ?? null,
      isActive: Boolean(m.is_active),
    }))

    // —— doctors（经 doctor_patient_relations 关联） ——
    const doctors = all(
      `SELECT d.doctor_id, d.name, d.title, d.department, r.relation_id
       FROM doctor_patient_relations r
       JOIN doctors d ON d.doctor_id = r.doctor_id
       WHERE r.patient_id = ? AND r.is_active = 1
       ORDER BY r.relation_id ASC`,
      patientId
    ).map((d) => ({
      doctorId: d.doctor_id,
      name: d.name,
      title: d.title ?? null,
      department: d.department ?? null,
      relationId: d.relation_id,
    }))

    // —— derived（BMI 现算；紧急联系人取第一条） ——
    const weight = latestMeasurements?.weight ?? null
    const height = toNum(full.height)
    const bmi =
      weight !== null && height ? round(weight / (height / 100) ** 2, 1) : null
    const ec = contacts[0] || null

    return {
      patientId,
      identity,
      latestMeasurements,
      contacts,
      conditions,
      lifestyle,
      targets,
      medications,
      doctors,
      derived: {
        bmi,
        emergencyContact: ec
          ? { name: ec.name, relation: ec.relation, phone: ec.phone, authorized: ec.authorized }
          : null,
      },
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'getPatientProfile', patientId })
  }
}

/* ================================================================== *
 * 兼容视图（纯函数）：ProfileResult → demoPatients.toUserProfile() 同形对象
 * ------------------------------------------------------------------
 * 派生视图，**不是数据源**。Step 4 前端迁移期用它把旧字段名喂给既有 UI。
 * 映射（契约 §1.3 兼容说明）：
 *   height ← identity.height；weight ← latestMeasurements.weight；
 *   waist  ← latestMeasurements.waist；bmi ← derived.bmi；age ← identity.age
 * ================================================================== */

export function toUserProfileView(profile) {
  const id = profile.identity
  const lm = profile.latestMeasurements
  const primary = profile.conditions.find((c) => c.isPrimary) || null
  const secondary = profile.conditions.filter((c) => !c.isPrimary).map((c) => c.diseaseName)
  const t = profile.targets || {}
  const diseases = [primary?.diseaseName, ...secondary].filter(Boolean)
  const ec = profile.derived.emergencyContact

  return {
    user_id: profile.patientId,
    username: id.username,
    name: id.name,
    age: id.age,
    gender: id.gender,
    height: id.height,
    weight: lm?.weight ?? null,
    bmi: profile.derived.bmi,
    waist: lm?.waist ?? null,
    disease_types: diseases,
    diseases,
    phone: id.phone,
    emergency_contact: ec ? `${ec.name}（${ec.relation}）${ec.phone}` : null,
    emergencyContact: ec
      ? { name: ec.name, relation: ec.relation, phone: ec.phone, authorized: ec.authorized }
      : null,
    occupation: id.occupation,
    elderly_mode: id.elderlyMode,
    voice_enabled: id.voiceEnabled,
    lifestyle: profile.lifestyle,
    medical: {
      primaryDisease: primary?.diseaseName ?? null,
      diseaseGrade: primary?.diseaseGrade ?? null,
      diseaseDuration: primary?.durationText ?? null,
      secondaryDiseases: secondary,
      riskStratification: primary?.riskStratification ?? null,
      riskStratificationBasis: primary?.riskBasis ?? null,
      comorbidities: primary?.comorbidities ?? [],
      organDamage: primary?.organDamage ?? null,
      controlTarget: t.controlTarget ?? null,
      targetBasis: t.basis ?? null,
      demoThreshold: {
        systolic: t.systolicTarget ?? undefined,
        diastolic: t.diastolicTarget ?? undefined,
        fastingGlucose: t.fastingGlucoseTarget ?? undefined,
        bmi: t.bmiTarget ?? undefined,
        waist: t.waistTarget ?? undefined,
      },
      demoThresholdNote: t.demoThresholdNote ?? null,
    },
    medications: profile.medications.map((m) => ({
      name: m.name,
      dosage: m.dosage,
      time: m.time,
      frequency: m.frequency,
      note: m.note,
    })),
    doctors: profile.doctors,
    // 注意：此处**不再**注入请求时刻的 created_at。
    // 旧 toUserProfile() 曾把创建时刻写进档案视图，但该字段并非数据（同一患者两次请求会得到不同毫秒），
    // 会使「同一份数据任何客户端读到完全一致」无法成立；且全仓库无任何消费方读取它。
    // 派生视图只承载真实数据，故移除。
  }
}

export { DB_PATH }
