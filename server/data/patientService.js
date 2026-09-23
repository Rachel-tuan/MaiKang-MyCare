/**
 * 迈康 MyCare · 后端患者服务层（第二阶段 Step 4）
 * ===========================================================================
 * 定位：**面向前端页面的聚合取数 / 写入层**，构建在 Step 3 的 dataProvider 之上。
 *   · 三个核心契约（getSeries / getDailySnapshot / getPatientProfile）在 dataProvider.js，
 *     本文件只做「页面需要的组合视图」与「写入落库」，不重复实现取数语义。
 *   · 所有数据来自 SQLite；**不读取 src/data/demoPatients.js / localStorage / 前端内存**。
 *
 * 铁律（继承 Step 0.1 + Step 4 红线）：
 *   1. patient_id 为唯一规范键；患者不存在 → E_PATIENT_NOT_FOUND（404），**禁止默认患者兜底**。
 *   2. 规则判定继续由确定性规则引擎 clinicalRules 计算；AI 不得改写阈值 / 等级 / 达标率。
 *   3. 页面记录视图（record view）是 daily_health_records 的**派生视图**，不是新数据源。
 *   4. 时序追加不覆盖：daily_health_records 按 (patient_id, record_date) 唯一 —— 同日为当日修正，
 *      新日期为新增行，历史曲线因此自然增长。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

import { DataProviderError, ERROR_CODES, asDataProviderError } from './errors.js'
import { openDb, get, all } from './db.js'
import { getPatientProfile, toUserProfileView, todayCST, calcAge } from './dataProvider.js'
import { evaluateClinicalRules } from '../../src/utils/clinicalRules.js'
import {
  buildDailyTasks,
  BP_SLOT_OPTIONS,
  GLUCOSE_MEASURE_TYPES,
  splitMedicationTimes,
} from '../../src/utils/dailyTasks.js'
import { getEffectiveOverrides, readPatientStepsTarget, countPendingProposals } from './taskOverrideService.js'
import { listPatientAlerts } from './alertService.js'

/**
 * 默认随访医生：注册时与患者建立**关联关系**（doctor_patient_relations）。
 *
 * ⚠️ 隐私红线（2026-09-17 修订）：关联 ≠ 授权。
 *   · 注册只写入一行 `is_active = 0` 的**未授权**关联，医生端看不到该患者；
 *     `is_active = 1` 只由**患者本人**在「我的医疗团队」页显式同意后才产生。
 *   · 医生端读取路径（getDoctorPatients / getPatientProfile.doctors）本就以
 *     `is_active = 1` 为唯一过滤条件 —— 授权闭环**零额外查询改动**即生效。
 *   · 撤回授权 = 把该行置回 `is_active = 0`（**不删除**，保留关联留痕）；
 *     撤回后医生端立即不再返回该患者，患者已有的健康数据不因此被改动。
 *   · 示范病例（password_hash 为空）在种子数据中即为 `is_active = 1`，
 *     属「一键进入的虚构病例已默认授权」，不影响演示。
 *
 * 落点仍是既有表 doctor_patient_relations（P0 22 张之内），**不新增任何表**。
 */
const DEFAULT_DOCTOR_ID = 'doc_li'

/** 病名英文枚举 → 库内中文规范病名（与 patients/patient_conditions 的既有取值一致） */
const DISEASE_NAME_ZH = {
  hypertension: '高血压',
  diabetes: '糖尿病',
  obesity: '肥胖症',
  hyperlipidemia: '高血脂',
  coronary_heart_disease: '冠心病',
}

/* ================================================================== *
 * 账号凭据（唯一存放处：patients.password_hash）
 * ------------------------------------------------------------------
 * 存储格式：scrypt$<salt-hex>$<derived-hex>
 *   · 使用 Node 内置 scrypt，不引入任何第三方依赖；
 *   · 示范病例该字段为空 → 属"免密示范账号"，可直接一键进入；
 *   · 自助注册账号该字段非空 → 登录必须校验密码，前端无法绕过。
 * ================================================================== */
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(String(password), salt, 32).toString('hex')
  return `scrypt$${salt}$${derived}`
}

function verifyPassword(password, stored) {
  const [algo, salt, expected] = String(stored || '').split('$')
  if (algo !== 'scrypt' || !salt || !expected) return false
  const calc = scryptSync(String(password), salt, 32)
  const expect = Buffer.from(expected, 'hex')
  if (calc.length !== expect.length) return false
  return timingSafeEqual(calc, expect)
}

/** 是否已设置密码（= 是否为自助注册账号，而非免密示范病例） */
const hasPassword = (passwordHash) => String(passwordHash || '').trim() !== ''

/** 由年龄反推出生日期（age 始终由 birth_date 现算，不落库） */
function birthDateFromAge(age) {
  const n = Number(age)
  if (!Number.isFinite(n) || n < 1 || n > 130) return null
  const today = todayCST()
  const [y, m, d] = today.split('-')
  return `${Number(y) - Math.floor(n)}-${m}-${d}`
}

/** 生成下一个患者编号，延续 patient_N 命名（便于演示与医生端可读） */
function nextPatientId() {
  let max = 0
  for (const { patient_id: pid } of all('SELECT patient_id FROM patients')) {
    const m = /^patient_(\d+)$/.exec(String(pid))
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `patient_${max + 1}`
}

/* ================================================================== *
 * 工具
 * ================================================================== */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const isValidDateStr = (s) =>
  typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())

const addDays = (dateStr, delta) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + delta)
  return t.toISOString().slice(0, 10)
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const safeJson = (text, fallback) => {
  if (text === null || text === undefined || text === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

const assertPatientId = (patientId, fn) => {
  if (typeof patientId !== 'string' || patientId.trim() === '') {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'patientId 必填且不能为空', {
      fn,
      patientId: patientId ?? null,
    })
  }
}

/** 患者必须存在，否则 E_PATIENT_NOT_FOUND（绝不回落到默认患者） */
const requirePatient = (patientId, fn) => {
  const row = get('SELECT patient_id, name, is_active FROM patients WHERE patient_id = ?', patientId)
  if (!row) {
    throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到患者：${patientId}`, { fn, patientId })
  }
  return row
}

const maskPhone = (phone) => {
  const s = String(phone || '')
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s
}

/** 距最近一次 HbA1c 检测的月数（派生值，供 R-BG-4 使用；不落库） */
function monthsSinceLatestHbA1c(patientId) {
  const row = get(
    `SELECT test_date FROM lab_results
      WHERE patient_id = ? AND lower(item_name) LIKE '%hba1c%'
      ORDER BY test_date DESC LIMIT 1`,
    patientId
  )
  if (!row?.test_date || !isValidDateStr(row.test_date)) return null
  const [y1, m1, d1] = row.test_date.split('-').map(Number)
  const [y2, m2, d2] = todayCST().split('-').map(Number)
  let months = (y2 - y1) * 12 + (m2 - m1)
  if (d2 < d1) months -= 1
  return months
}

/* ================================================================== *
 * 记录视图：daily_health_records 行 → 前端页面使用的记录对象
 * ------------------------------------------------------------------
 * 同时提供「数据库命名」与「视图模型命名」两套字段（与旧 normalizeRecord 对齐），
 * 使既有页面零改动即可消费数据库数据。这是派生视图，不是数据源。
 * ================================================================== */
function toRecordView(r) {
  const date = r.record_date
  const systolic = num(r.systolic_pressure)
  const diastolic = num(r.diastolic_pressure)
  const bloodSugar = num(r.fasting_glucose)
  const heartRate = num(r.heart_rate)
  const exerciseMinutes = num(r.exercise_minutes)
  const sleepHours = num(r.sleep_hours)
  const moodScore = num(r.mood_score)
  const weight = num(r.weight)
  const steps = num(r.steps)

  return {
    record_id: r.record_id,
    user_id: r.patient_id,
    // 数据库风格（内部算法与规则引擎使用）
    record_date: date,
    steps,
    systolic_pressure: systolic,
    diastolic_pressure: diastolic,
    blood_sugar: bloodSugar,
    fasting_glucose: bloodSugar,
    weight,
    waist: num(r.waist),
    heart_rate: heartRate,
    exercise_minutes: exerciseMinutes,
    sleep_hours: sleepHours,
    mood_score: moodScore,
    notes: r.notes ?? '',
    source: r.source,
    record_status: r.record_status,
    created_at: r.created_at,
    // 视图模型风格（图表页 / 勋章页 / 医生端使用）
    // ⚠️ Step 11 · D-1 修复：**不得**为缺测字段伪造默认值（此处原为 `?? 0` / `?? 7` / `?? 4`）。
    //   `clinicalRules.pick()` 不区分「键不存在」与「显式 NULL」，只要某个别名给出有限数字就采纳；
    //   伪造的 0 会被当成「测得 0 mmHg / 0 mmol/L」的真实测量进入规则序列，
    //   从而同时造成①假预警 ②掩盖真预警 ③达标率虚高。
    //   缺失一律保留 `null` = 「未记录」；NULL 与真 0 严格区分。
    //   显示层的占位（睡眠 7 小时 / 心情 4 分等）由前端 normalizeRecord 负责，不进任何规则序列。
    date,
    bloodPressure: { systolic, diastolic },
    bloodSugar,
    heartRate,
    exerciseMinutes,
    sleepHours,
    moodScore,
  }
}

/* ================================================================== *
 * 1. 登录页：示范病例入口
 * ================================================================== */
export async function listPatientEntries() {
  try {
    // 只列「免密示范病例」（password_hash 为空）——自助注册账号需凭用户名 + 密码登录，
    // 不进入一键进入列表，避免绕过密码。
    const rows = all(
      `SELECT patient_id, name, gender, birth_date
         FROM patients
        WHERE is_active = 1 AND COALESCE(password_hash, '') = ''
        ORDER BY patient_id ASC`
    )
    return rows.map((p) => {
      const cond = get(
        `SELECT disease_name, disease_grade FROM patient_conditions
          WHERE patient_id = ? AND is_primary = 1 ORDER BY condition_id ASC LIMIT 1`,
        p.patient_id
      )
      const tg = get(
        `SELECT basis FROM patient_targets
          WHERE patient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        p.patient_id
      )
      const payload = safeJson(tg?.basis, null)
      const shortGrade = cond?.disease_grade ? String(cond.disease_grade).split('（')[0].trim() : ''
      return {
        id: p.patient_id,
        name: p.name,
        disease: cond ? (shortGrade ? `${cond.disease_name} ${shortGrade}` : cond.disease_name) : '',
        age: calcAge(p.birth_date),
        gender: p.gender,
        focus: (payload && payload.controlTarget) || null,
      }
    })
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'listPatientEntries' })
  }
}

/* ================================================================== *
 * 2. 登录身份：patientId / username → patient_id（唯一规范键）
 * ================================================================== */
export async function resolvePatientForLogin({ patientId, username, password } = {}) {
  try {
    let row = null
    if (patientId !== undefined && patientId !== null && String(patientId).trim() !== '') {
      row = get(
        'SELECT patient_id, password_hash FROM patients WHERE patient_id = ? AND is_active = 1',
        String(patientId)
      )
      if (!row) {
        throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到患者：${patientId}`, { patientId })
      }
    } else if (username !== undefined && username !== null && String(username).trim() !== '') {
      row = get(
        'SELECT patient_id, password_hash FROM patients WHERE lower(username) = lower(?) AND is_active = 1',
        String(username).trim()
      )
      if (!row) {
        throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `用户名不存在：${username}`, {
          username,
          hint: '该账号尚未注册，请先完成注册',
        })
      }
    } else {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '需提供 patientId 或 username', {})
    }

    // 已设置密码的账号（自助注册）必须校验密码；示范病例 password_hash 为空 → 免密一键进入
    if (hasPassword(row.password_hash)) {
      const pwd = password === undefined || password === null ? '' : String(password)
      if (!pwd) {
        throw new DataProviderError(ERROR_CODES.E_PASSWORD_REQUIRED, '该账号已设置密码，请输入密码后登录', {
          patientId: row.patient_id,
        })
      }
      if (!verifyPassword(pwd, row.password_hash)) {
        throw new DataProviderError(ERROR_CODES.E_PASSWORD_MISMATCH, '密码错误，请重新输入', {
          patientId: row.patient_id,
        })
      }
    }

    const profile = await getPatientProfile(row.patient_id)
    return { patientId: row.patient_id, view: toUserProfileView(profile) }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'resolvePatientForLogin' })
  }
}

/* ================================================================== *
 * 2b. 自助注册 / 找回密码（身份层 + 档案层）
 * ------------------------------------------------------------------
 * 与 Step 4「查不到就 404」并不冲突：
 *   · 注册是**显式写入**，成功后 patients 里留下该账号的真实档案，
 *     其 patient_id 成为后续唯一身份键；
 *   · 新账号初始只有注册时填写的身高 / 体重，没有任何 daily_health_records 历史与 alerts，
 *     所有趋势、判定、预警都必须由用户自己录入数据后才会产生 —— 这正是「动态」的来源；
 *   · 账号凭据只存于 patients.password_hash（scrypt 加盐），不落明文，
 *     示范病例该字段为空 → 免密，注册账号非空 → 登录强制校验，前端无法绕过。
 * ================================================================== */
export async function registerPatient(payload = {}) {
  try {
    const username = String(payload.username || '').trim()
    const name = String(payload.name || '').trim()
    const password = String(payload.password || '')

    if (!username || !name) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '姓名与用户名均为必填', { username, name })
    }
    if (username.length < 3) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '用户名至少 3 位', { username })
    }
    if (password.length < 6) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '密码至少 6 位', {})
    }
    if (get('SELECT patient_id FROM patients WHERE lower(username) = lower(?)', username)) {
      throw new DataProviderError(ERROR_CODES.E_USERNAME_TAKEN, '该用户名已被占用，请更换或直接登录', { username })
    }

    const gender = String(payload.gender) === 'female' || String(payload.gender) === '女' ? '女' : '男'
    const birthDate = payload.birthDate || birthDateFromAge(payload.age)
    const height = num(payload.height)
    const weight = num(payload.weight)
    const phone = payload.phone ? String(payload.phone).trim() : null
    const occupation = payload.occupation ? String(payload.occupation).trim() : null
    const diseases = Array.isArray(payload.diseases) ? payload.diseases : []

    const db = openDb()
    const patientId = nextPatientId()
    const now = new Date().toISOString().slice(0, 19)

    db.prepare(
      `INSERT INTO patients
         (patient_id, username, password_hash, name, gender, birth_date, height, phone, occupation,
          elderly_mode, voice_enabled, created_at, updated_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 1)`
    ).run(patientId, username, hashPassword(password), name, gender, birthDate, height, phone, occupation, now, now)

    // 疾病诊断 → patient_conditions（规则引擎据此选择病种相关规则组）
    diseases.forEach((raw, i) => {
      const diseaseName = DISEASE_NAME_ZH[raw] || String(raw || '').trim()
      if (!diseaseName) return
      db.prepare(
        `INSERT INTO patient_conditions (condition_id, patient_id, disease_name, is_primary, diagnosed_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`
      ).run(`cond_${patientId}_${i + 1}`, patientId, diseaseName, i === 0 ? 1 : 0, now)
    })

    // 生活画像占位行（1:1，结构落库；具体画像由后续交互补充）
    db.prepare('INSERT INTO patient_lifestyle (patient_id, updated_at) VALUES (?, ?)').run(patientId, now)

    // 紧急联系人（外发红线：authorized 默认 0，须本人在应用内显式授权后才可对外通知）
    const ecName = payload.emergencyContact ? String(payload.emergencyContact).trim() : ''
    if (ecName) {
      db.prepare(
        `INSERT INTO patient_contacts
           (contact_id, patient_id, contact_name, relation, contact_phone, authorized, created_at)
         VALUES (?, ?, ?, NULL, NULL, 0, ?)`
      ).run(`contact_${patientId}_1`, patientId, ecName, now)
    }

    // 注册时填写的体重作为该账号「第一条健康记录」落库（来源 manual），
    // 使 BMI/趋势有真实起点，也便于直观看到「注册动作确实写进了数据库」。
    if (weight !== null) {
      const today = todayCST()
      db.prepare(
        `INSERT INTO daily_health_records
           (record_id, patient_id, record_date, weight, source, record_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'manual', 'valid', ?, ?)`
      ).run(`${patientId}_rec_${today}`, patientId, today, weight, now, now)
    }

    // 与默认随访医生建立关联，但**不授权**：is_active = 0。
    //   · 医生端只读 is_active = 1，因此新注册账号在患者本人同意之前**不可见**；
    //   · 患者同意后由 setDoctorConsent() 将本行置为 1，医生端即刻可见；
    //   · 关联行在此先建好，是为了让「我的医疗团队」页能列出可授权的医生，
    //     而不是让医生端看到「某人不声不响地注册了」。
    //   · `INSERT OR IGNORE`：万一已存在一行，宁可保留其现有授权状态，也不覆盖。
    if (get('SELECT doctor_id FROM doctors WHERE doctor_id = ?', DEFAULT_DOCTOR_ID)) {
      db.prepare(
        `INSERT OR IGNORE INTO doctor_patient_relations (relation_id, doctor_id, patient_id, created_at, is_active)
         VALUES (?, ?, ?, ?, 0)`
      ).run(`rel_${DEFAULT_DOCTOR_ID}_${patientId}`, DEFAULT_DOCTOR_ID, patientId, now)
    }

    const profile = await getPatientProfile(patientId)
    return { patientId, view: toUserProfileView(profile), username }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, {
      fn: 'registerPatient',
      username: payload?.username ?? null,
    })
  }
}

/** 找回密码：用户名 + 注册手机号双因子匹配后重置（仅适用于自助注册账号） */
export async function resetPatientPassword({ username, phone, newPassword } = {}) {
  try {
    const u = String(username || '').trim()
    const p = String(phone || '').replace(/\s/g, '')
    const np = String(newPassword || '')
    if (!u || !p) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '用户名与注册手机号均为必填', { username: u })
    }
    if (np.length < 6) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '新密码至少 6 位', {})
    }

    const row = get(
      'SELECT patient_id, phone, password_hash FROM patients WHERE lower(username) = lower(?) AND is_active = 1',
      u
    )
    if (!row) {
      throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, '该账号尚未注册，请先注册', { username: u })
    }
    if (!hasPassword(row.password_hash)) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '示范病例为免密账号，无需找回密码', { username: u })
    }
    if (String(row.phone || '').replace(/\s/g, '') !== p) {
      throw new DataProviderError(ERROR_CODES.E_PHONE_MISMATCH, '手机号与注册信息不一致，请核对后重试', {
        username: u,
      })
    }

    const db = openDb()
    db.prepare('UPDATE patients SET password_hash = ? WHERE patient_id = ?').run(hashPassword(np), row.patient_id)
    return { ok: true, patientId: row.patient_id, username: u }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'resetPatientPassword' })
  }
}

/* ================================================================== *
 * 2c. 完善 / 更新健康档案（「从 0 到 1」建档闭环）
 * ------------------------------------------------------------------
 * 背景：自助注册只写入最小身份信息（姓名 / 性别 / 出生日期 / 身高 / 手机 / 疾病），
 *   `patient_contacts` / `patient_lifestyle` / `patient_targets` / `medications`
 *   四类档案全部为空 —— 医生端「患者详情」与患者端「生活画像」因此无内容可呈现，
 *   今日任务的个性化依据也不完整（与示范病例不是同一种档位）。
 *
 * 本函数是**档案层唯一的补全入口**，把注册后的空档案补齐到与示范病例同构：
 *   · patients           → UPDATE 基础字段（姓名 / 性别 / 出生日期 / 身高 / 手机 / 职业）
 *   · patient_contacts   → 紧急联系人（取该患者第一行 upsert；authorized 只在置 1 时刷新时间）
 *   · patient_conditions → 疾病诊断（按 disease_name upsert；主诊断恒为数组第一项）
 *   · patient_lifestyle  → 生活画像（1:1；注册时已建占位行 → 恒 UPDATE）
 *   · patient_targets    → 个体化控制目标（**有行 UPDATE / 无行 INSERT 一行**）
 *   · medications        → 用药计划（按 name upsert；未列出的旧药保持不变，不删）
 *
 * 红线（与 Step 11 一致）：
 *   1. 不新建任何表（P0 冻结 22 张）；
 *   2. `patient_targets` **优先 UPDATE 既有行**；仅当该患者一行都没有（注册用户从零开始）
 *      才 INSERT 一行 —— 绝不产生第二行（否则 `ORDER BY created_at DESC` 出现排序歧义）；
 *   3. 既有行的 `basis` **一个字符都不改**（登录页按 JSON 消费该列）；
 *      只有新建行时才写入与示范病例同构的 `{basis, controlTarget, demoThresholdNote}` JSON；
 *   4. 控制目标是**患者自述的初始值**，不是医生裁定值；医生后续仍可经今日任务覆盖链路调整。
 *      本函数不参与任何规则判定，也不触碰 clinicalRules。
 *
 * @returns {Promise<{patientId:string, applied:string[], view:object}>} applied = 本次实际写入的表名
 */
export async function updatePatientProfile(patientId, payload = {}) {
  try {
    const pid = String(patientId || '').trim()
    if (!pid) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'patientId 必填', {})
    }
    if (!get('SELECT patient_id FROM patients WHERE patient_id = ? AND is_active = 1', pid)) {
      throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到患者：${pid}`, { patientId: pid })
    }

    const db = openDb()
    const now = nowStamp()
    const applied = []
    const identity = payload.identity && typeof payload.identity === 'object' ? payload.identity : payload

    db.exec('BEGIN IMMEDIATE')
    try {
      /* ---------------- 1) patients：基础信息 ---------------- */
      const sets = []
      const vals = []
      const put = (col, value) => {
        sets.push(`${col} = ?`)
        vals.push(value)
      }

      if (identity.name !== undefined) {
        const name = String(identity.name || '').trim()
        if (!name) {
          throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '姓名不能为空', {})
        }
        put('name', name)
      }
      if (identity.gender !== undefined) {
        const g = String(identity.gender)
        put('gender', g === 'female' || g === '女' ? '女' : '男')
      }
      if (identity.birthDate !== undefined || identity.age !== undefined) {
        const bd = identity.birthDate ? String(identity.birthDate).slice(0, 10) : birthDateFromAge(identity.age)
        if (bd) put('birth_date', bd)
      }
      if (identity.height !== undefined) {
        const h = num(identity.height)
        if (h === null || h <= 0 || h > 250) {
          throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '身高需在 1–250 cm 之间', { height: identity.height })
        }
        put('height', h)
      }
      if (identity.phone !== undefined) put('phone', identity.phone ? String(identity.phone).replace(/\s/g, '') : null)
      if (identity.occupation !== undefined) {
        put('occupation', identity.occupation ? String(identity.occupation).trim() : null)
      }
      if (identity.elderlyMode !== undefined) put('elderly_mode', identity.elderlyMode ? 1 : 0)
      if (identity.voiceEnabled !== undefined) put('voice_enabled', identity.voiceEnabled ? 1 : 0)

      if (sets.length) {
        put('updated_at', now)
        db.prepare(`UPDATE patients SET ${sets.join(', ')} WHERE patient_id = ?`).run(...vals, pid)
        applied.push('patients')
      }

      /* ---------------- 2) patient_contacts：紧急联系人 ---------------- */
      const ec = payload.emergencyContact
      const ecName = ec ? String(ec.name ?? ec.contactName ?? '').trim() : ''
      if (ecName) {
        const rel = ec.relation ? String(ec.relation).trim() : null
        const cphone = ec.phone ? String(ec.phone).replace(/\s/g, '') : null
        const authorized = ec.authorized ? 1 : 0
        const hit = get(
          'SELECT contact_id, authorized, authorized_at FROM patient_contacts WHERE patient_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1',
          pid
        )
        if (hit) {
          db.prepare(
            `UPDATE patient_contacts SET contact_name = ?, relation = ?, contact_phone = ?, authorized = ?,
                    authorized_at = CASE WHEN ? = 1 AND ? = 0 THEN ? ELSE authorized_at END
              WHERE contact_id = ?`
          ).run(ecName, rel, cphone, authorized, authorized, hit.authorized, now, hit.contact_id)
        } else {
          db.prepare(
            `INSERT INTO patient_contacts
               (contact_id, patient_id, contact_name, relation, contact_phone, authorized, authorized_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(`contact_${pid}_1`, pid, ecName, rel, cphone, authorized, authorized ? now : null, now)
        }
        applied.push('patient_contacts')
      }

      /* ---------------- 3) patient_conditions：疾病诊断 ---------------- */
      const conditions = Array.isArray(payload.conditions) ? payload.conditions : null
      if (conditions && conditions.length) {
        // 主诊断唯一性：先全部置 0，再按数组顺序把第一项置 1（避免出现两行 is_primary=1）
        db.prepare('UPDATE patient_conditions SET is_primary = 0 WHERE patient_id = ?').run(pid)
        const existing = all(
          'SELECT condition_id, disease_name FROM patient_conditions WHERE patient_id = ? ORDER BY rowid ASC',
          pid
        )
        const byName = new Map(existing.map((r) => [r.disease_name, r]))
        let seq = existing.length
        conditions.forEach((c, i) => {
          const dname = DISEASE_NAME_ZH[c.diseaseName] || String(c.diseaseName || '').trim()
          if (!dname) return
          const grade = c.diseaseGrade ? String(c.diseaseGrade).trim() : null
          const duration = c.durationText ? String(c.durationText).trim() : null
          const risk = c.riskStratification ? String(c.riskStratification).trim() : null
          const riskBasis = c.riskBasis ? String(c.riskBasis).trim() : null
          const comorbid = Array.isArray(c.comorbidities) && c.comorbidities.filter(Boolean).length
            ? JSON.stringify(c.comorbidities.filter(Boolean))
            : null
          const organ = c.organDamage ? String(c.organDamage).trim() : null
          const isPrimary = i === 0 ? 1 : 0
          const hit = byName.get(dname)
          if (hit) {
            db.prepare(
              `UPDATE patient_conditions
                  SET disease_name = ?, disease_grade = ?, duration_text = ?, risk_stratification = ?,
                      risk_basis = ?, comorbidities = ?, organ_damage = ?, is_primary = ?
                WHERE condition_id = ?`
            ).run(dname, grade, duration, risk, riskBasis, comorbid, organ, isPrimary, hit.condition_id)
          } else {
            seq += 1
            db.prepare(
              `INSERT INTO patient_conditions
                 (condition_id, patient_id, disease_name, disease_grade, is_primary, diagnosed_at, duration_text,
                  risk_stratification, risk_basis, comorbidities, organ_damage, created_at)
               VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
            ).run(
              `cond_${pid}_${seq}`,
              pid,
              dname,
              grade,
              isPrimary,
              duration,
              risk,
              riskBasis,
              comorbid,
              organ,
              now
            )
            byName.set(dname, { condition_id: `cond_${pid}_${seq}`, disease_name: dname })
          }
        })
        applied.push('patient_conditions')
      }

      /* ---------------- 4) patient_lifestyle：生活画像 ---------------- */
      const lf = payload.lifestyle
      if (lf && typeof lf === 'object') {
        const text = (v) => (v !== undefined && v !== null && String(v).trim() ? String(v).trim() : null)
        const cols = {
          diet: text(lf.diet),
          exercise: text(lf.exercise),
          sleep: text(lf.sleep),
          biggest_difficulty: text(lf.biggestDifficulty ?? lf.biggest_difficulty),
          motivation: text(lf.motivation),
          ai_style: text(lf.aiStyle ?? lf.ai_style),
        }
        const tags =
          lf.tags && typeof lf.tags === 'object' && Object.keys(lf.tags).length ? JSON.stringify(lf.tags) : null
        const hit = get('SELECT patient_id FROM patient_lifestyle WHERE patient_id = ?', pid)
        if (hit) {
          db.prepare(
            `UPDATE patient_lifestyle
                SET diet = COALESCE(?, diet), exercise = COALESCE(?, exercise), sleep = COALESCE(?, sleep),
                    biggest_difficulty = COALESCE(?, biggest_difficulty), motivation = COALESCE(?, motivation),
                    ai_style = COALESCE(?, ai_style), tags = COALESCE(?, tags), updated_at = ?
              WHERE patient_id = ?`
          ).run(
            cols.diet,
            cols.exercise,
            cols.sleep,
            cols.biggest_difficulty,
            cols.motivation,
            cols.ai_style,
            tags,
            now,
            pid
          )
        } else {
          db.prepare(
            `INSERT INTO patient_lifestyle
               (patient_id, diet, exercise, sleep, biggest_difficulty, motivation, ai_style, tags, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            pid,
            cols.diet,
            cols.exercise,
            cols.sleep,
            cols.biggest_difficulty,
            cols.motivation,
            cols.ai_style,
            tags,
            now
          )
        }
        applied.push('patient_lifestyle')
      }

      /* ---------------- 5) patient_targets：个体化控制目标 ---------------- */
      const tg = payload.targets
      if (tg && typeof tg === 'object') {
        const intOf = (v) => {
          const n = num(v)
          return n === null || n <= 0 ? null : Math.round(n)
        }
        const realOf = (v) => {
          const n = num(v)
          return n === null || n <= 0 ? null : n
        }
        const next = {
          systolic_target: intOf(tg.systolic ?? tg.systolicTarget),
          diastolic_target: intOf(tg.diastolic ?? tg.diastolicTarget),
          fasting_glucose_target: realOf(tg.fastingGlucose ?? tg.fastingGlucoseTarget),
          bmi_target: realOf(tg.bmi ?? tg.bmiTarget),
          waist_target: intOf(tg.waist ?? tg.waistTarget),
          steps_target: intOf(tg.steps ?? tg.stepsTarget),
        }
        // 只更新本次显式传入的列（未传 → 保持 null 即「不修改」）
        const cols = Object.keys(next).filter((k) => next[k] !== null)
        const hit = get(
          'SELECT target_id, basis FROM patient_targets WHERE patient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
          pid
        )
        if (hit) {
          if (cols.length) {
            db.prepare(
              `UPDATE patient_targets SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE target_id = ?`
            ).run(...cols.map((c) => next[c]), hit.target_id)
          }
          // ⚠️ 既有行的 basis 不动 —— 这是登录页「重点关注」文案的 JSON 来源
        } else {
          const targetDesc = []
          if (next.systolic_target && next.diastolic_target) {
            targetDesc.push(`血压 < ${next.systolic_target}/${next.diastolic_target} mmHg`)
          }
          if (next.fasting_glucose_target) targetDesc.push(`空腹血糖 < ${next.fasting_glucose_target} mmol/L`)
          if (next.bmi_target) targetDesc.push(`BMI < ${next.bmi_target}`)
          if (next.waist_target) targetDesc.push(`腰围 < ${next.waist_target} cm`)
          const basisPayload = JSON.stringify({
            basis: tg.basis
              ? String(tg.basis)
              : '患者本人在「完善健康档案」中填写初始控制目标，可在医生端今日任务中调整',
            controlTarget: targetDesc.join('，') || null,
            demoThresholdNote: '本病例控制目标由患者建档时填写，医生可调整。',
          })
          db.prepare(
            `INSERT INTO patient_targets
               (target_id, patient_id, systolic_target, diastolic_target, fasting_glucose_target,
                hba1c_target, bmi_target, waist_target, steps_target, weight_change_target,
                basis, effective_from, set_by, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, NULL, ?)`
          ).run(
            `target_${pid}_1`,
            pid,
            next.systolic_target,
            next.diastolic_target,
            next.fasting_glucose_target,
            next.bmi_target,
            next.waist_target,
            next.steps_target,
            basisPayload,
            now
          )
        }
        applied.push('patient_targets')
      }

      /* ---------------- 6) medications：用药计划 ---------------- */
      const meds = Array.isArray(payload.medications) ? payload.medications : null
      if (meds && meds.length) {
        for (const m of meds) {
          const name = String(m.name || '').trim()
          if (!name) continue
          const dosage = m.dosage ? String(m.dosage).trim() : null
          const time = m.time ? String(m.time).trim() : null
          const frequency = m.frequency ? String(m.frequency).trim() : null
          const note = m.note ? String(m.note).trim() : null
          const hit = get(
            'SELECT medication_id FROM medications WHERE patient_id = ? AND name = ? ORDER BY rowid ASC LIMIT 1',
            pid,
            name
          )
          if (hit) {
            db.prepare(
              `UPDATE medications SET dosage = ?, time = ?, frequency = ?, note = ?, is_active = 1
                WHERE medication_id = ?`
            ).run(dosage, time, frequency, note, hit.medication_id)
          } else {
            db.prepare(
              `INSERT INTO medications (medication_id, patient_id, name, dosage, time, frequency, note, is_active, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
            ).run(`med_${pid}_${randomBytes(4).toString('hex')}`, pid, name, dosage, time, frequency, note, now)
          }
        }
        applied.push('medications')
      }

      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }

    const profile = await getPatientProfile(pid)
    return { patientId: pid, applied, view: toUserProfileView(profile) }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'updatePatientProfile', patientId })
  }
}

/* ================================================================== *
 * 3. 记录列表（页面用）：窗口锚定最新记录日，避免演示数据随日历"过期"
 * ================================================================== */
export async function getPatientRecords(patientId, days = 30) {
  try {
    assertPatientId(patientId, 'getPatientRecords')
    const n = Number(days)
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'days 必须为 1–365 的整数', { days })
    }
    requirePatient(patientId, 'getPatientRecords')

    // 时间窗口只认「有效 / 已更正」的行：record_status='void'（作废）的行
    // 既不参与 7 天窗口锚定，也不得进入规则判定（Step 9 数据修复配套）。
    const latest = get(
      `SELECT MAX(record_date) AS d FROM daily_health_records
        WHERE patient_id = ? AND record_status <> 'void'`,
      patientId
    )?.d
    const to = latest || todayCST()
    const from = addDays(to, -(n - 1))
    const rows = all(
      `SELECT * FROM daily_health_records
        WHERE patient_id = ? AND record_date BETWEEN ? AND ? AND record_status <> 'void'
        ORDER BY record_date ASC`,
      patientId,
      from,
      to
    )
    return {
      patientId,
      window: { from, to, days: n, anchorMode: 'latest' },
      count: rows.length,
      records: rows.map(toRecordView),
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'getPatientRecords', patientId })
  }
}

/* ================================================================== *
 * 4. 勋章（页面用）：badges ⋈ badge_definitions
 * ================================================================== */
export async function getPatientBadges(patientId) {
  try {
    assertPatientId(patientId, 'getPatientBadges')
    requirePatient(patientId, 'getPatientBadges')
    const rows = all(
      `SELECT b.badge_id, b.earned_date, b.level, b.points,
              d.badge_key, d.badge_type, d.badge_name, d.description, d.icon
         FROM badges b
         JOIN badge_definitions d ON d.badge_def_id = b.badge_def_id
        WHERE b.patient_id = ?
        ORDER BY b.earned_date ASC, b.badge_id ASC`,
      patientId
    )
    return rows.map((r) => ({
      badge_id: r.badge_id,
      user_id: patientId,
      // 目录 id 优先使用 badge_key（前端目录按 first_record / week_streak 匹配）
      id: r.badge_key,
      badgeId: r.badge_key,
      badgeKey: r.badge_key,
      badge_type: r.badge_type,
      badgeType: r.badge_type,
      badge_name: r.badge_name,
      name: r.badge_name,
      badge_description: r.description,
      description: r.description,
      badge_icon: r.icon,
      icon: r.icon,
      earned_date: r.earned_date,
      earnedDate: r.earned_date,
      level: r.level ?? 1,
      points: r.points ?? 0,
    }))
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'getPatientBadges', patientId })
  }
}

/* ================================================================== *
 * 5. 写入：录入一条当日健康数据（落库）
 * ------------------------------------------------------------------
 * 幂等 upsert：同 (patient_id, record_date) 存在则更新该日记录（标 corrected），
 * 不存在则新增行 → 历史曲线继续增长；不产生重复行、不覆盖他日。
 * ================================================================== */
export async function upsertDailyRecord(patientId, payload = {}) {
  try {
    assertPatientId(patientId, 'upsertDailyRecord')
    requirePatient(patientId, 'upsertDailyRecord')

    const date = payload.date ? String(payload.date) : todayCST()
    if (!isValidDateStr(date)) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'date 必须为 YYYY-MM-DD', { date })
    }

    const bp = payload.bloodPressure || {}
    const values = {
      steps: num(payload.steps),
      systolic_pressure: num(payload.systolic ?? payload.systolic_pressure ?? bp.systolic),
      diastolic_pressure: num(payload.diastolic ?? payload.diastolic_pressure ?? bp.diastolic),
      fasting_glucose: num(payload.bloodSugar ?? payload.blood_sugar ?? payload.fasting_glucose),
      weight: num(payload.weight),
      waist: num(payload.waist),
      heart_rate: num(payload.heartRate ?? payload.heart_rate),
      exercise_minutes: num(payload.exerciseMinutes ?? payload.exercise_minutes),
      sleep_hours: num(payload.sleepHours ?? payload.sleep_hours),
      mood_score: num(payload.moodScore ?? payload.mood_score),
      notes: payload.notes === undefined || payload.notes === null ? null : String(payload.notes),
    }

    const existed = get(
      'SELECT 1 AS ok FROM daily_health_records WHERE patient_id = ? AND record_date = ?',
      patientId,
      date
    )
    const recordId = `${patientId}_rec_${date}`

    const db = openDb()
    db.prepare(
      `INSERT INTO daily_health_records
         (record_id, patient_id, record_date, steps, systolic_pressure, diastolic_pressure,
          fasting_glucose, weight, waist, heart_rate, exercise_minutes, sleep_hours, mood_score,
          notes, source, record_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'valid')
       ON CONFLICT(patient_id, record_date) DO UPDATE SET
         steps              = COALESCE(excluded.steps, daily_health_records.steps),
         systolic_pressure  = COALESCE(excluded.systolic_pressure, daily_health_records.systolic_pressure),
         diastolic_pressure = COALESCE(excluded.diastolic_pressure, daily_health_records.diastolic_pressure),
         fasting_glucose    = COALESCE(excluded.fasting_glucose, daily_health_records.fasting_glucose),
         weight             = COALESCE(excluded.weight, daily_health_records.weight),
         waist              = COALESCE(excluded.waist, daily_health_records.waist),
         heart_rate         = COALESCE(excluded.heart_rate, daily_health_records.heart_rate),
         exercise_minutes   = COALESCE(excluded.exercise_minutes, daily_health_records.exercise_minutes),
         sleep_hours        = COALESCE(excluded.sleep_hours, daily_health_records.sleep_hours),
         mood_score         = COALESCE(excluded.mood_score, daily_health_records.mood_score),
         notes              = COALESCE(excluded.notes, daily_health_records.notes),
         source             = 'manual',
         record_status      = 'corrected'`
    ).run(
      recordId,
      patientId,
      date,
      values.steps,
      values.systolic_pressure,
      values.diastolic_pressure,
      values.fasting_glucose,
      values.weight,
      values.waist,
      values.heart_rate,
      values.exercise_minutes,
      values.sleep_hours,
      values.mood_score,
      values.notes
    )

    const row = get(
      'SELECT * FROM daily_health_records WHERE patient_id = ? AND record_date = ?',
      patientId,
      date
    )
    return {
      patientId,
      date,
      created: !existed,
      updated: Boolean(existed),
      record: toRecordView(row),
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'upsertDailyRecord', patientId })
  }
}

/* ================================================================== *
 * 6. 医生端：经 doctor_patient_relations 查询其管理患者
 * ------------------------------------------------------------------
 * 规则判定复用确定性规则引擎（与前端同一实现），AI 不参与阈值 / 等级。
 * ================================================================== */
const STATUS_BY_LEVEL = {
  emergency: 'danger',
  alert: 'attention',
  watch: 'good',
  info: 'good',
}

export async function getDoctorPatients(doctorId = 'doc_li') {
  try {
    const doctor = get(
      'SELECT doctor_id, name, title, department FROM doctors WHERE doctor_id = ?',
      String(doctorId)
    )
    if (!doctor) {
      throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到医生：${doctorId}`, { doctorId })
    }

    const rels = all(
      `SELECT patient_id FROM doctor_patient_relations
        WHERE doctor_id = ? AND is_active = 1 ORDER BY patient_id ASC`,
      doctor.doctor_id
    )

    const patients = []
    for (const { patient_id: pid } of rels) {
      const profile = await getPatientProfile(pid)
      const view = toUserProfileView(profile)
      const { records } = await getPatientRecords(pid, 7)
      const badges = await getPatientBadges(pid)
      // 落库预警（alerts 表）：确定性规则命中后由 Agent 运行落库，医生端读取
      const alertRecords = (await listPatientAlerts(pid, { limit: 5 })).alerts

      const patientLike = {
        id: pid,
        profile: { emergencyContact: profile.derived.emergencyContact },
        medical: { ...view.medical, hba1cLastTestMonthsAgo: monthsSinceLatestHbA1c(pid) },
        lifestyle: view.lifestyle,
        badges: badges.map((b) => ({ type: b.badge_type })),
      }
      const evaluation = evaluateClinicalRules(patientLike, records)
      const latest = records[records.length - 1] || {}
      const ec = profile.derived.emergencyContact

      patients.push({
        id: pid,
        name: view.name,
        age: view.age,
        gender: view.gender === '男' ? 'male' : 'female',
        diseases: view.diseases,
        lastRecord: latest.record_date || null,
        status: STATUS_BY_LEVEL[evaluation.highestLevel] || 'good',
        phone: maskPhone(view.phone),
        emergencyContact: ec ? `${ec.name}（${ec.relation}）${maskPhone(ec.phone)}` : '',
        recentData: {
          bloodPressure: { systolic: latest.systolic_pressure, diastolic: latest.diastolic_pressure },
          bloodSugar: latest.blood_sugar,
          weight: latest.weight,
          steps: latest.steps,
        },
        alerts: evaluation.matched
          .filter((r) => ['emergency', 'alert', 'watch'].includes(r.level))
          .slice(0, 3)
          .map((r) => ({
            type: r.level === 'emergency' ? 'danger' : r.level === 'alert' ? 'warning' : 'info',
            message: `${r.title}｜${r.basis}`,
          })),
        // 落库预警明细（Step 5）：来自 alerts 表，供医生端「健康预警」页读取
        alertRecords,
        alertCount: alertRecords.length,
        // 待审核任务提案数（Step 11 · Phase 2）—— Phase 1 阶段恒为 0，供医生端角标占位
        pendingProposalCount: countPendingProposals(pid),
        evaluation: {
          highestLevel: evaluation.highestLevel,
          matched: evaluation.matched.map((r) => ({
            ruleId: r.ruleId,
            name: r.name,
            level: r.level,
            levelLabel: r.levelLabel,
            basis: r.basis,
            action: r.action,
          })),
          stats: evaluation.stats,
        },
        medical: view.medical,
        lifestyle: view.lifestyle,
        medications: view.medications,
      })
    }

    return { doctor, patients }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'getDoctorPatients', doctorId })
  }
}

/* ================================================================== *
 * 6b. 隐私授权闭环（2026-09-17 新增）
 * ------------------------------------------------------------------
 * 问题：注册即被医生端可见 —— 患者从未同意过任何医生查阅其健康档案。
 * 解法（**零建表**，复用 doctor_patient_relations.is_active）：
 *   · is_active = 1 → 患者已授权，医生端可见；
 *   · is_active = 0 → 已建立关联但未获授权 / 已被患者撤回，医生端不可见。
 * 边界：
 *   · 本模块只读写「授权状态」，**不触碰**任何健康数据；
 *   · 授权是患者**单方面**可给可撤的开关：医生无法自行授予，也无法阻止撤回；
 *   · 撤回不删除关联行（保留留痕），也不影响患者已录入的数据；
 *   · 本层不做任何阈值 / 等级 / 达标率判定（那是 clinicalRules 的职责）。
 *
 * 已知边界（如实声明，勿在对外材料中夸大）：
 *   · doctor_patient_relations 无 updated_at，故**不记录授权变更时间**，
 *     仅能给出关联建立时间；完整的「谁在何时查阅了谁」审计日志需新增表，属下一阶段。
 *   · 医生端目前**无登录鉴权**（演示环境固定 doc_li）。生产环境必须补上，
 *     否则授权只防君子：任何人打开 /doctor 都能看到「已授权」患者列表。
 *   · 演示数据全为虚构病例，不含任何真实患者信息。
 * ================================================================== */

/** 患者是否存在且在册（不存在 → 404，**绝不回落示范患者**） */
function assertPatientExists(patientId) {
  const row = get(
    'SELECT patient_id, name FROM patients WHERE patient_id = ? AND is_active = 1',
    String(patientId)
  )
  if (!row) {
    throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到患者：${patientId}`, { patientId })
  }
  return row
}

/**
 * 我的医疗团队 —— 患者视角的医生授权清单。
 * 列出**全部在册医生**及其授权状态，使患者能自行决定授权 / 撤回。
 */
export async function getPatientCareTeam(patientId) {
  try {
    const pid = String(patientId || '').trim()
    if (!pid) throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '缺少 patientId', {})
    assertPatientExists(pid)

    const rows = all(
      `SELECT d.doctor_id, d.name, d.title, d.department,
              r.relation_id, r.is_active AS relation_active, r.created_at
         FROM doctors d
         LEFT JOIN doctor_patient_relations r
                ON r.doctor_id = d.doctor_id AND r.patient_id = ?
        WHERE d.is_active = 1
        ORDER BY d.doctor_id ASC`,
      pid
    )

    return {
      patientId: pid,
      doctors: rows.map((r) => ({
        doctorId: r.doctor_id,
        name: r.name,
        title: r.title ?? null,
        department: r.department ?? null,
        /** true = 已授权（医生端可见）；false = 未授权 / 已撤回 */
        granted: Number(r.relation_active) === 1,
        /** 关联建立时间（**非**授权变更时间，见上方已知边界） */
        relationCreatedAt: r.created_at ?? null,
      })),
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'getPatientCareTeam', patientId })
  }
}

/**
 * 授权 / 撤回「某医生查阅本人健康档案」。
 * @param {string} patientId
 * @param {string} doctorId
 * @param {boolean} granted true = 同意授权；false = 撤回授权
 * 幂等：重复授权 / 重复撤回结果一致，不报错。
 */
export async function setDoctorConsent(patientId, doctorId, granted) {
  try {
    const pid = String(patientId || '').trim()
    const did = String(doctorId || '').trim()
    if (!pid || !did) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '缺少 patientId 或 doctorId', {
        patientId: pid,
        doctorId: did,
      })
    }
    assertPatientExists(pid)
    if (!get('SELECT doctor_id FROM doctors WHERE doctor_id = ? AND is_active = 1', did)) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, `未找到医生：${did}`, { doctorId: did })
    }

    const flag = granted ? 1 : 0
    const db = openDb()
    const existing = get(
      'SELECT relation_id FROM doctor_patient_relations WHERE doctor_id = ? AND patient_id = ?',
      did,
      pid
    )
    if (existing) {
      // 既有关联：只翻 is_active 开关（**不删行**，保留关联留痕）
      db.prepare('UPDATE doctor_patient_relations SET is_active = ? WHERE relation_id = ?').run(
        flag,
        existing.relation_id
      )
    } else {
      const now = new Date().toISOString().slice(0, 19)
      db.prepare(
        `INSERT INTO doctor_patient_relations (relation_id, doctor_id, patient_id, created_at, is_active)
         VALUES (?, ?, ?, ?, ?)`
      ).run(`rel_${did}_${pid}`, did, pid, now, flag)
    }

    const team = await getPatientCareTeam(pid)
    return {
      patientId: pid,
      doctorId: did,
      granted: Boolean(flag),
      doctor: team.doctors.find((d) => d.doctorId === did) || null,
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'setDoctorConsent', patientId, doctorId })
  }
}

/* ================================================================== *
 * 7. Step 9 · 事实层写入：一天多次测量（纯追加，永不覆盖）
 * ------------------------------------------------------------------
 * 铁律（Step 9 冻结）：
 *   · 一次测量 = 一条 readings 记录；同一天可以 N 条；**绝不 UPSERT、绝不 UPDATE**。
 *   · `*_readings` 是原始事实层，作废只打 `record_status='void'` 标记，不删行。
 *   · `daily_health_records` 只是「日粒度兼容层」，为让既有 clinicalRules 继续运行
 *     而取一个**保守兼容代表值**；该值不是当日真实测量值，也不替代 readings。
 *   · 今日任务由 `src/utils/dailyTasks.js` 确定性生成；进度**不落库**，
 *     由当日有效 readings / medication_logs 实时派生。
 * ================================================================== */

/** 生理合理性范围（拒收明显录错的值，如收缩压 < 舒张压） */
const SYS_RANGE = [60, 300]
const DIA_RANGE = [30, 200]
const GLUCOSE_RANGE = [1, 40]

const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi

const nowStamp = () => new Date().toISOString().slice(0, 19)

/** 归一化测量时刻：优先 measuredAt，其次 date + time，最后取当日 00:00 */
function normalizeDateTime(date, measuredAt, time) {
  if (measuredAt !== undefined && measuredAt !== null && String(measuredAt).trim() !== '') {
    const raw = String(measuredAt).trim().replace(' ', 'T')
    if (Number.isNaN(new Date(raw).getTime())) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'measuredAt 不是合法时间', { measuredAt })
    }
    const s = raw.length >= 19 ? raw.slice(0, 19) : raw
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/.exec(s)
    if (m) return `${m[1]}T${m[2]}:${m[3] ? m[3].slice(1) : '00'}`
    return `${date}T00:00:00`
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim())
  const hhmm = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '00:00'
  return `${date}T${hhmm}:00`
}

/**
 * 当日有效读数明细（供今日任务派生 / 展示）。
 * 只取 valid / corrected —— void 与 draft 均不得参与。
 */
export function listReadings(patientId, date) {
  const day = date
  const bp = all(
    `SELECT reading_id, measured_at, systolic, diastolic, pulse, slot, source, record_status
       FROM blood_pressure_readings
      WHERE patient_id = ? AND date(measured_at) = ? AND record_status IN ('valid','corrected')
      ORDER BY measured_at ASC`,
    patientId,
    day
  ).map((r) => ({
    readingId: r.reading_id,
    measuredAt: r.measured_at,
    systolic: num(r.systolic),
    diastolic: num(r.diastolic),
    pulse: num(r.pulse),
    slot: r.slot ?? null,
  }))

  const bg = all(
    `SELECT reading_id, measured_at, value, measure_type, source, record_status
       FROM blood_glucose_readings
      WHERE patient_id = ? AND date(measured_at) = ? AND record_status IN ('valid','corrected')
      ORDER BY measured_at ASC`,
    patientId,
    day
  ).map((r) => ({
    readingId: r.reading_id,
    measuredAt: r.measured_at,
    value: num(r.value),
    measureType: r.measure_type,
  }))

  return { bloodPressure: bp, bloodGlucose: bg }
}

/** 某患者最新一条（有效）血压 / 血糖读数 —— 用于页面「最新测量」展示。
 *  注意：展示一律读 readings，**不得**用 daily 的兼容代表值冒充最新值。 */
export function getLatestReadings(patientId) {
  const bp = get(
    `SELECT reading_id, measured_at, systolic, diastolic, pulse, slot
       FROM blood_pressure_readings
      WHERE patient_id = ? AND record_status IN ('valid','corrected')
      ORDER BY measured_at DESC, created_at DESC LIMIT 1`,
    patientId
  )
  const bg = get(
    `SELECT reading_id, measured_at, value, measure_type
       FROM blood_glucose_readings
      WHERE patient_id = ? AND record_status IN ('valid','corrected')
      ORDER BY measured_at DESC, created_at DESC LIMIT 1`,
    patientId
  )
  return {
    bloodPressure: bp
      ? { readingId: bp.reading_id, measuredAt: bp.measured_at, systolic: num(bp.systolic), diastolic: num(bp.diastolic), pulse: num(bp.pulse), slot: bp.slot ?? null }
      : null,
    bloodGlucose: bg
      ? { readingId: bg.reading_id, measuredAt: bg.measured_at, value: num(bg.value), measureType: bg.measure_type }
      : null,
  }
}

/** 近 7 天各域有效测量次数（低频关注项进度用） */
function countWeeklyReadings(patientId, day) {
  const from = addDays(day, -6)
  const countOf = (table) =>
    get(
      `SELECT COUNT(*) AS c FROM ${table}
        WHERE patient_id = ? AND date(measured_at) BETWEEN ? AND ? AND record_status IN ('valid','corrected')`,
      patientId,
      from,
      day
    )?.c ?? 0
  return {
    blood_pressure: countOf('blood_pressure_readings'),
    blood_glucose: countOf('blood_glucose_readings'),
  }
}

/**
 * daily 兼容层回写（**仅供既有日粒度规则使用**）。
 * ------------------------------------------------------------------
 * daily_health_records 的血压/血糖值为「保守兼容代表值」：
 *   · 血压：当日有效读数中**收缩压最大**的那一条，成对写入（绝不跨条混搭）；
 *   · 血糖：当日有有效「空腹」读数时取空腹读数；无空腹读数时取当日有效血糖最高值。
 *
 * 该值不是当日真实唯一测量值，不替代 blood_pressure_readings / blood_glucose_readings
 * 中的原始测量；页面「最新测量」必须读 readings，不得读这里。
 *
 * 若该日记录此前被标为 void（作废），当日产生新的有效测量后由新测量重建并恢复 valid。
 */
export function recomputeDailyCompat(patientId, date) {
  const db = openDb()
  const bpRows = db
    .prepare(
      `SELECT reading_id, systolic, diastolic, pulse FROM blood_pressure_readings
        WHERE patient_id = ? AND date(measured_at) = ? AND record_status IN ('valid','corrected')`
    )
    .all(patientId, date)
  const bgRows = db
    .prepare(
      `SELECT reading_id, value, measure_type FROM blood_glucose_readings
        WHERE patient_id = ? AND date(measured_at) = ? AND record_status IN ('valid','corrected')`
    )
    .all(patientId, date)

  let bp = null
  for (const r of bpRows) {
    if (r.systolic === null || r.systolic === undefined) continue
    if (!bp || r.systolic > bp.systolic) bp = r
  }

  let bg = null
  if (bgRows.length) {
    // 字段语义优先：daily.fasting_glucose 先认「空腹」；无空腹才退回当日最高（并在文档/注释中声明为兼容值）
    const fasting = bgRows.filter((r) => r.measure_type === '空腹')
    const pool = fasting.length ? fasting : bgRows
    for (const r of pool) {
      if (r.value === null || r.value === undefined) continue
      if (!bg || r.value > bg.value) bg = r
    }
  }

  if (!bp && !bg) return { changed: false, compat: { bloodPressure: null, bloodGlucose: null } }

  const now = nowStamp()
  db.prepare(
    `INSERT INTO daily_health_records
       (record_id, patient_id, record_date, systolic_pressure, diastolic_pressure, heart_rate,
        fasting_glucose, source, record_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'valid', ?, ?)
     ON CONFLICT(patient_id, record_date) DO UPDATE SET
       systolic_pressure  = COALESCE(excluded.systolic_pressure, daily_health_records.systolic_pressure),
       diastolic_pressure = COALESCE(excluded.diastolic_pressure, daily_health_records.diastolic_pressure),
       heart_rate         = COALESCE(excluded.heart_rate, daily_health_records.heart_rate),
       fasting_glucose    = COALESCE(excluded.fasting_glucose, daily_health_records.fasting_glucose),
       record_status      = CASE
                              WHEN daily_health_records.record_status = 'void' THEN 'valid'
                              ELSE daily_health_records.record_status
                            END,
       updated_at         = excluded.updated_at`
  ).run(
    `${patientId}_rec_${date}`,
    patientId,
    date,
    bp ? bp.systolic : null,
    bp ? bp.diastolic : null,
    bp ? bp.pulse : null,
    bg ? bg.value : null,
    now,
    now
  )

  return {
    changed: true,
    compat: {
      bloodPressure: bp
        ? { readingId: bp.reading_id, systolic: bp.systolic, diastolic: bp.diastolic, pulse: bp.pulse ?? null }
        : null,
      bloodGlucose: bg
        ? { readingId: bg.reading_id, value: bg.value, measureType: bg.measure_type }
        : null,
    },
  }
}

/** 追加一次血压测量（纯 INSERT，一天可 N 次，历史永不覆盖） */
export async function appendBloodPressureReading(patientId, payload = {}) {
  try {
    assertPatientId(patientId, 'appendBloodPressureReading')
    requirePatient(patientId, 'appendBloodPressureReading')

    const date = payload.date ? String(payload.date) : todayCST()
    if (!isValidDateStr(date)) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'date 必须为 YYYY-MM-DD', { date })
    }

    const systolic = num(payload.systolic ?? payload.systolic_pressure)
    const diastolic = num(payload.diastolic ?? payload.diastolic_pressure)
    const pulse = num(payload.pulse ?? payload.heartRate ?? payload.heart_rate)

    if (systolic === null || diastolic === null) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '收缩压与舒张压均为必填', { systolic, diastolic })
    }
    if (!inRange(systolic, SYS_RANGE) || !inRange(diastolic, DIA_RANGE)) {
      throw new DataProviderError(
        ERROR_CODES.E_INVALID_ARG,
        `血压超出可录入范围（收缩压 ${SYS_RANGE[0]}–${SYS_RANGE[1]}，舒张压 ${DIA_RANGE[0]}–${DIA_RANGE[1]} mmHg）`,
        { systolic, diastolic }
      )
    }
    if (systolic <= diastolic) {
      throw new DataProviderError(
        ERROR_CODES.E_BP_INVERTED,
        `收缩压（${systolic}）必须大于舒张压（${diastolic}），请核对后重新录入`,
        { systolic, diastolic }
      )
    }

    const rawSlot = payload.slot === undefined || payload.slot === null || payload.slot === '' ? null : String(payload.slot)
    if (rawSlot !== null && !BP_SLOT_OPTIONS.includes(rawSlot)) {
      throw new DataProviderError(
        ERROR_CODES.E_INVALID_ARG,
        `测量时段只能为 ${BP_SLOT_OPTIONS.join(' / ')}（UI 显示「午后」时，落库值仍为「下午」）`,
        { slot: rawSlot }
      )
    }

    const measuredAt = normalizeDateTime(date, payload.measuredAt, payload.time)
    const readingId = `bp_${patientId}_${Date.now()}_${randomBytes(4).toString('hex')}`

    const db = openDb()
    db.exec('BEGIN')
    let compat
    try {
      db.prepare(
        `INSERT INTO blood_pressure_readings
           (reading_id, patient_id, measured_at, systolic, diastolic, pulse, slot, source, record_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'valid')`
      ).run(readingId, patientId, measuredAt, systolic, diastolic, pulse, rawSlot)
      compat = recomputeDailyCompat(patientId, date)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }

    const reading = get('SELECT * FROM blood_pressure_readings WHERE reading_id = ?', readingId)
    return {
      patientId,
      date,
      created: true,
      overwritten: false,
      reading: {
        readingId,
        measuredAt,
        systolic,
        diastolic,
        pulse,
        slot: rawSlot,
        recordStatus: 'valid',
      },
      dailyCompat: compat,
      daily: get('SELECT * FROM daily_health_records WHERE patient_id = ? AND record_date = ?', patientId, date),
      tasks: await getDailyTasks(patientId, date),
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'appendBloodPressureReading', patientId })
  }
}

/** 追加一次血糖测量（纯 INSERT；measure_type 必填，否则空腹/餐后语义会取错） */
export async function appendBloodGlucoseReading(patientId, payload = {}) {
  try {
    assertPatientId(patientId, 'appendBloodGlucoseReading')
    requirePatient(patientId, 'appendBloodGlucoseReading')

    const date = payload.date ? String(payload.date) : todayCST()
    if (!isValidDateStr(date)) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'date 必须为 YYYY-MM-DD', { date })
    }

    const value = num(payload.value ?? payload.bloodSugar ?? payload.blood_sugar)
    const measureType = String(payload.measureType || payload.measure_type || '').trim()
    if (value === null) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '血糖值为必填', { value })
    }
    if (!inRange(value, GLUCOSE_RANGE)) {
      throw new DataProviderError(
        ERROR_CODES.E_INVALID_ARG,
        `血糖值超出可录入范围（${GLUCOSE_RANGE[0]}–${GLUCOSE_RANGE[1]} mmol/L）`,
        { value }
      )
    }
    if (!GLUCOSE_MEASURE_TYPES.includes(measureType)) {
      throw new DataProviderError(
        ERROR_CODES.E_INVALID_ARG,
        `measureType 必填，且只能为 ${GLUCOSE_MEASURE_TYPES.join(' / ')}`,
        { measureType }
      )
    }

    const measuredAt = normalizeDateTime(date, payload.measuredAt, payload.time)
    const readingId = `bg_${patientId}_${Date.now()}_${randomBytes(4).toString('hex')}`

    const db = openDb()
    db.exec('BEGIN')
    let compat
    try {
      db.prepare(
        `INSERT INTO blood_glucose_readings
           (reading_id, patient_id, measured_at, value, measure_type, source, record_status)
         VALUES (?, ?, ?, ?, ?, 'manual', 'valid')`
      ).run(readingId, patientId, measuredAt, value, measureType)
      compat = recomputeDailyCompat(patientId, date)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }

    return {
      patientId,
      date,
      created: true,
      overwritten: false,
      reading: { readingId, measuredAt, value, measureType, recordStatus: 'valid' },
      dailyCompat: compat,
      daily: get('SELECT * FROM daily_health_records WHERE patient_id = ? AND record_date = ?', patientId, date),
      tasks: await getDailyTasks(patientId, date),
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'appendBloodGlucoseReading', patientId })
  }
}

/**
 * 服药打卡（一次服药 = 一条 medication_logs）。
 * 一个药物有多个服药时间时，计划侧已在 dailyTasks 拆成多个实例；
 * 这里按 (medication_id, plannedTime) 定位具体实例。
 */
export async function appendMedicationLog(patientId, payload = {}) {
  try {
    assertPatientId(patientId, 'appendMedicationLog')
    requirePatient(patientId, 'appendMedicationLog')

    const medicationId = String(payload.medicationId || payload.medication_id || '').trim()
    if (!medicationId) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'medicationId 必填', {})
    }
    const med = get(
      'SELECT medication_id, name FROM medications WHERE medication_id = ? AND patient_id = ?',
      medicationId,
      patientId
    )
    if (!med) {
      throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到该患者的用药计划：${medicationId}`, {
        patientId,
        medicationId,
      })
    }

    const date = payload.date ? String(payload.date) : todayCST()
    if (!isValidDateStr(date)) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'date 必须为 YYYY-MM-DD', { date })
    }
    /*
     * 计划时刻口径：计划侧（dailyTasks）给的是 `HH:mm`，前端也可能直接回传完整时间串。
     * normalizeDateTime(date, measuredAt, time) 的第二个入参是「完整日期时间」，第三个是「当日 HH:mm」，
     * 两者语义不同 —— 不能把 `HH:mm` 当成第一个入参传，否则会被判为非法时间而 400。
     */
    const rawPlanned = payload.plannedTime || payload.planned_time || payload.time
    const rawPlannedStr = rawPlanned === undefined || rawPlanned === null ? '' : String(rawPlanned).trim()
    const plannedTime = rawPlannedStr.includes('T')
      ? normalizeDateTime(date, rawPlannedStr, null)
      : normalizeDateTime(date, null, rawPlannedStr || null)
    const status = payload.status ? String(payload.status) : '已服'
    if (!['已服', '漏服', '延迟'].includes(status)) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, "status 只能为 已服 / 漏服 / 延迟", { status })
    }
    const takenAt = status === '已服' ? normalizeDateTime(date, payload.takenAt, plannedTime.slice(11, 16)) : null

    const logId = `ml_${patientId}_${Date.now()}_${randomBytes(4).toString('hex')}`
    openDb()
      .prepare(
        `INSERT INTO medication_logs
           (log_id, patient_id, medication_id, planned_time, taken_at, status, source, record_status)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', 'valid')`
      )
      .run(logId, patientId, medicationId, plannedTime, takenAt, status)

    return {
      patientId,
      date,
      created: true,
      log: { logId, medicationId, medicationName: med.name, plannedTime, takenAt, status },
      tasks: await getDailyTasks(patientId, date),
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'appendMedicationLog', patientId })
  }
}

/* ================================================================== *
 * 8. 今日任务（派生视图，不落库）
 * ------------------------------------------------------------------
 * 频次与时段由 src/utils/dailyTasks.js 的确定性规则决定；
 * clinicalRules 的既有等级只被**读取**用于"异常升频"，不重算任何阈值。
 * 进度由当日有效 readings / medication_logs 实时计数，没有任务进度表。
 * ================================================================== */
export async function getDailyTasks(patientId, date) {
  try {
    assertPatientId(patientId, 'getDailyTasks')
    requirePatient(patientId, 'getDailyTasks')
    const day = date ? String(date) : todayCST()
    if (!isValidDateStr(day)) {
      throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'date 必须为 YYYY-MM-DD', { date })
    }

    const profile = await getPatientProfile(patientId)
    const view = toUserProfileView(profile)
    const badges = await getPatientBadges(patientId)
    const { records } = await getPatientRecords(patientId, 7)

    const patientLike = {
      id: patientId,
      profile: { emergencyContact: profile.derived?.emergencyContact },
      medical: { ...view.medical, hba1cLastTestMonthsAgo: monthsSinceLatestHbA1c(patientId) },
      lifestyle: view.lifestyle,
      badges: badges.map((b) => ({ type: b.badge_type })),
    }
    const evaluation = evaluateClinicalRules(patientLike, records)

    const readings = listReadings(patientId, day)
    const weeklyCounts = countWeeklyReadings(patientId, day)

    const medications = all(
      `SELECT medication_id, name, dosage, time FROM medications
        WHERE patient_id = ? AND is_active = 1 ORDER BY medication_id ASC`,
      patientId
    )
      .map((m) => ({
        medicationId: m.medication_id,
        name: m.name,
        dosage: m.dosage,
        time: m.time,
        times: splitMedicationTimes(m.time),
      }))
      .filter((m) => m.times.length > 0)

    const medicationLogs = all(
      `SELECT medication_id, planned_time FROM medication_logs
        WHERE patient_id = ? AND date(planned_time) = ? AND status = '已服'
          AND record_status IN ('valid','corrected')`,
      patientId,
      day
    ).map((r) => ({ medicationId: r.medication_id, plannedTime: r.planned_time }))

    // ⚠️ F-1：排序加固（created_at DESC, rowid DESC），避免医生调整行读不到
    const targetRow = readPatientStepsTarget(patientId)
    const rec = get(
      `SELECT steps, exercise_minutes, weight FROM daily_health_records
        WHERE patient_id = ? AND record_date = ? AND record_status <> 'void'`,
      patientId,
      day
    )

    // —— Step 11 · 覆盖层：读取当前生效覆盖包（无则行为与 Step 9 完全一致）——
    // —— Step 12：同一份包同时承载「参数覆盖」与「医生审结新增的监测域」——
    const {
      overrides: taskOverrides,
      addedTasks: addedMonitorTasks,
      meta: overrideMeta,
      package: overridePkg,
    } = getEffectiveOverrides(patientId)
    const stepsTarget = Number.isInteger(taskOverrides?.steps?.target)
      ? taskOverrides.steps.target
      : (targetRow?.steps_target ?? null)

    const tasks = buildDailyTasks({
      date: day,
      diseases: view.diseases,
      primaryDisease: view.medical.primaryDisease,
      evaluation,
      bpReadings: readings.bloodPressure,
      bgReadings: readings.bloodGlucose,
      medications,
      medicationLogs,
      weeklyCounts,
      targets: { steps: stepsTarget },
      activity: {
        steps: rec?.steps ?? 0,
        exerciseMinutes: rec?.exercise_minutes ?? 0,
        weight: rec?.weight ?? null,
      },
      taskOverrides,
      overrideMeta,
      // Step 12：医生审结新增的监测域 → 补出对应监测任务（幂等）
      addedTasks: addedMonitorTasks,
    })

    return {
      patientId,
      date: day,
      ...tasks,
      // 当前生效覆盖包（供界面标注「医生已调整」与依据）——无覆盖时为 null
      taskOverrides: overridePkg ? overridePkg.overrides : null,
      overridePackage: overridePkg,
      // 「规则原始值 vs 生效值」双值，供医生端抽屉显示 diff
      stepsTargetOriginal: targetRow?.steps_target ?? null,
      readings,
      latest: getLatestReadings(patientId),
      medicationPlans: medications.map((m) => ({
        medicationId: m.medicationId,
        name: m.name,
        dosage: m.dosage,
        times: m.times,
      })),
    }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'getDailyTasks', patientId })
  }
}

/**
 * 患者「今日任务」的生效状态（Step 11 · Phase 2 的 `currentValue` 来源）。
 * ------------------------------------------------------------------
 * 红线：`currentValue` 必须由**后端**注入，模型返回的一律忽略。
 * 本函数就是那个唯一可信来源 —— 它读的是规则产出 + **已生效**覆盖包，
 * 而不是任何客户端或模型传来的值。
 *
 * @returns {{ patientId:string, date:string, taskIds:string[], tasks:Array, overrides:object, overridePackage:object|null }}
 */
export async function getEffectiveTaskState(patientId, date) {
  const state = await getDailyTasks(patientId, date)
  return {
    patientId,
    date: state.date,
    taskIds: state.tasks.map((t) => t.taskId),
    tasks: state.tasks,
    overrides: state.taskOverrides || {},
    overridePackage: state.overridePackage || null,
  }
}

export { maskPhone, toRecordView, monthsSinceLatestHbA1c, BP_SLOT_OPTIONS }
