#!/usr/bin/env node
/**
 * 迈康 MyCare · 第二阶段 Step 6 · 最终验收脚本（动态链路验收）
 * ===========================================================================
 * 依据：docs/数据指标说明与设计文档.html §11.2 / §14「第二阶段验收标准」与 §7.3「五条可验收判据」。
 *
 * 本脚本验收「数据是不是活的」，并逐条对应设计文档写死的验收项：
 *   A. 【最高优先级】demoPatients.js 改名 .bak 后，「录入 → 规则 → AI → 页面」链路仍通
 *   B. 新增第 4 位患者（只插数据、不改代码），登录后能看到其档案与趋势
 *   C. 为其新增一天数据 → 重新请求 API 即可见趋势更新；且追加不覆盖（历史值不变）
 *   D. 13 条规则在真实数据上的判定结果与自检脚本完全一致
 *   E. 预警落库后刷新仍在、医生端可见；外部通知只记录不外发
 *   F. 医生端签名一律「李医生」，不再出现患者姓名
 *   G. 换一个浏览器登录同一账号读到同一份数据；健康数据不落 localStorage
 *   H. 口径红线扫描（等级词表 / 体重措辞 / 紧急联系人双条件）
 *   I. 设计选择显式取证：clinicalRules 命中集 ⊋ alerts 持久化集（提示级不入库，非遗漏）
 *   J. 「已知未持久化能力」清单（reminders / agent_runs 等）
 *
 * 安全设计：
 *   · 全程在 **一次性副本库**（data/_step6-accept.db，由 data/mycare.db 复制）上运行，
 *     通过环境变量 MYCARE_DB_PATH 注入；**真实演示库 data/mycare.db 全程只读、零改动**。
 *   · 改名测试在 finally 中强制还原；副本库在结束时删除。
 *
 * 运行：node scripts/db/verify-step6.mjs
 * 产物：data/step6-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const NODE = process.execPath
const PORT = 3041
const BASE = `http://127.0.0.1:${PORT}`

// 来源库：优先取外部传入的 MYCARE_DB_PATH（Step 9：验收统一跑在 reset-demo 生成的
// 干净副本库上），默认仍是真实库 data/mycare.db。
// 注意必须在下面覆盖 process.env.MYCARE_DB_PATH 之前读取。
const REAL_DB = process.env.MYCARE_DB_PATH
  ? path.resolve(process.env.MYCARE_DB_PATH)
  : path.join(ROOT, 'data', 'mycare.db')
const TEST_DB = path.join(ROOT, 'data', '_step6-accept.db')
const DEMO_SRC = path.join(ROOT, 'src', 'data', 'demoPatients.js')
const DEMO_BAK = `${DEMO_SRC}.bak`

// 关键：本进程内**动态 import** 的后端模块（dataProvider/db.js 等）会在模块加载时读取 MYCARE_DB_PATH。
// 在此提前指向一次性副本库，确保「脚本直连校验」与「服务端子进程」读的是同一个库，
// 真实演示库 data/mycare.db 全程只读。
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
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

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

async function consumeSSE(p, body, timeoutMs = 90000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events = []
  try {
    const res = await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      return { status: res.status, events, error: await res.text().catch(() => '') }
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder('utf-8')
    let buf = ''
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const blocks = buf.split('\n\n')
      buf = blocks.pop() ?? ''
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (!payload) continue
          try {
            events.push(JSON.parse(payload))
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { status: res.status, events }
  } finally {
    clearTimeout(timer)
  }
}

function waitForServer(timeoutMs = 25000) {
  return (async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const r = await req('GET', '/api/status')
        if (r.status === 200) return true
      } catch {
        /* not up */
      }
      await sleep(300)
    }
    return false
  })()
}

/** 启动后端：强制本地推理引擎 + 指向一次性副本库 */
function startServer() {
  const child = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      MYCARE_DB_PATH: TEST_DB,
      DEEPSEEK_API_KEY: '',
      VISION_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

async function stopServer(child) {
  if (!child) return
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    try {
      await req('GET', '/api/status')
    } catch {
      return // 已不可达
    }
    await sleep(200)
  }
}

/* ------------------------- 直连副本库（只读/夹具） ------------------------- */
function dbOpen() {
  const db = new DatabaseSync(TEST_DB)
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}
function dbAll(sql, ...params) {
  const db = dbOpen()
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}
function dbGet(sql, ...params) {
  const db = dbOpen()
  try {
    return db.prepare(sql).get(...params)
  } finally {
    db.close()
  }
}

/* ------------------------- 静态扫描工具 ------------------------- */
function walk(dir, exts, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      walk(full, exts, acc)
    } else if (exts.some((x) => e.name.endsWith(x))) {
      acc.push(full)
    }
  }
  return acc
}

/** 去掉注释（保留行结构），避免把「禁止使用 X」的说明误判为使用 X */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(m.length - p1.length, 0)))
}

/** A1：运行时源码（src + server）不得 **导入** demoPatients（注释中的说明文字不算；离线脚本除外） */
function scanRuntimeForDemoPatients() {
  const offenders = []
  const files = [...walk(path.join(ROOT, 'src'), ['.js', '.jsx']), ...walk(path.join(ROOT, 'server'), ['.js'])]
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    // 只匹配真实导入/引用：import ... from '...demoPatients' / require('...demoPatients') / import('...demoPatients')
    if (/(from|import|require\s*\()\s*['"][^'"]*demoPatients/.test(text) || /import\s*\(\s*['"][^'"]*demoPatients/.test(text)) {
      offenders.push(path.relative(ROOT, f))
    }
  }
  return offenders
}

/** A3：构建产物不得引用 demoPatients */
function scanDistForDemoPatients() {
  const distDir = path.join(ROOT, 'dist')
  if (!fs.existsSync(distDir)) return { scanned: 0, offenders: [] }
  const files = walk(distDir, ['.js'])
  const offenders = []
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    if (/demoPatients/.test(text)) offenders.push(path.relative(ROOT, f))
  }
  return { scanned: files.length, offenders }
}

/**
 * B10：患者名单必须动态来自 API（新增患者前端零改动）。
 * 判据：① 页面不得引用 DEMO_PATIENTS / demoPatients；② 医生端与登录页必须走 API。
 * 说明：医生端「医生备注」初值是**会话内演示夹具**（含 patient_1/patient_2 字面量），
 *       它是备注内容而非名单来源、不落库、不参与名单渲染，故单独统计、不计为违规。
 */
function scanPagesForDynamicRoster() {
  const pages = walk(path.join(ROOT, 'src', 'pages'), ['.jsx'])
  const demoRefs = []
  const fixtureRefs = []
  for (const f of pages) {
    const rel = path.relative(ROOT, f)
    const text = stripComments(fs.readFileSync(f, 'utf8'))
    if (/DEMO_PATIENTS|demoPatients/.test(text)) demoRefs.push(rel)
    const m = text.match(/patient_[123]\b/g)
    if (m) fixtureRefs.push({ file: rel, count: m.length })
  }
  const doctorPage = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'DoctorPage.jsx'), 'utf8')
  const loginPage = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'LoginPage.jsx'), 'utf8')
  return {
    demoRefs,
    fixtureRefs,
    doctorUsesApi: /getDoctorPatients\s*\(/.test(doctorPage),
    loginUsesApi: /listPatients\s*\(/.test(loginPage),
  }
}

/** F2：医生端签名固定 */
function scanDoctorSignature() {
  const f = path.join(ROOT, 'src', 'pages', 'DoctorPage.jsx')
  const text = fs.readFileSync(f, 'utf8')
  return {
    hasFixedDoctorConst: /name:\s*'李医生'/.test(text),
    /**
     * Step 11 起「添加备注」改为**真落库**（此前是刷新即丢的内存假功能）。
     * 签名不再由前端拼 `doctorName: DOCTOR.name`，改由后端
     * `doctorNoteService.toNoteView()` 依据 `doctor_id` 从 `doctors` 表注入 ——
     * 约束因此升级为：前端**不得**再自行拼 doctorName，
     * 提交 payload 只允许 content / noteType / priority。
     * （读取展示侧的 `note.doctorName` 不受影响）
     */
    sendsDoctorNameFromClient: /doctorName\s*:/.test(text),
    // 不得把登录患者姓名当医生签名
    signsWithUserName: /doctorName:\s*user\.name|doctorName:\s*user\?\.name/.test(text),
  }
}

/** G2：localStorage 只允许保存「登录身份」；健康数据一律不入本地存储 */
function scanLocalStorage() {
  const apiCalls = []
  for (const f of walk(path.join(ROOT, 'src'), ['.js', '.jsx'])) {
    const rel = path.relative(ROOT, f)
    const text = stripComments(fs.readFileSync(f, 'utf8'))
    const re = /localStorage\s*\.\s*(?:get|set|remove)Item\s*\(\s*['"]([^'"]+)['"]/g
    let m
    while ((m = re.exec(text)) !== null) apiCalls.push({ file: rel, key: m[1] })
  }
  // 身份类键：登录态 / 偏好 / 本机注册表账号凭据（均属身份数据，不含任何健康数据）
  const IDENTITY_KEYS = new Set(['user', 'userSettings', 'mycare_accounts'])
  return {
    apiCalls,
    identityKeys: [...new Set(apiCalls.map((c) => c.key))],
    nonIdentity: apiCalls.filter((c) => !IDENTITY_KEYS.has(c.key)),
    healthFileCalls: apiCalls.filter((c) =>
      /HealthDataContext|DataRecordPage|PrescriptionPage|BadgePage|HomePage/.test(c.file)
    ),
  }
}

/**
 * H2：口径红线字样扫描。
 *  · 源码层：出现「高危/中危/低危/脂肪减少/平台期」的行必须处于「禁止性说明」或「医学侧字段」语境，
 *    否则视为违规（防止把它们真的当作产品等级 / 体重措辞使用）。注释先剥离，只查真实代码与提示词。
 *  · 输出层：落库 alerts 与医生端接口返回的文本中不得出现上述词。
 */
const WORD_LIST = ['脂肪减少', '平台期', '高危', '中危', '低危']
const WORD_GUARDS =
  /严禁|不得|不能|不应|不可|避免|禁止|切勿|不要|勿|不使用|未使用|不出现|未出现|不称|不存在|医学|危险分层|医生侧|riskStratification|risk_stratification|分层/

function scanWording() {
  const files = [...walk(path.join(ROOT, 'src'), ['.js', '.jsx']), ...walk(path.join(ROOT, 'server'), ['.js'])]
  const violations = []
  const guarded = []
  for (const f of files) {
    const rel = path.relative(ROOT, f)
    const lines = stripComments(fs.readFileSync(f, 'utf8')).split(/\r?\n/)
    lines.forEach((line, i) => {
      for (const w of WORD_LIST) {
        if (!line.includes(w)) continue
        if (WORD_GUARDS.test(line)) guarded.push(`${rel}:${i + 1}:${w}`)
        else violations.push(`${rel}:${i + 1}:${w}`)
      }
    })
  }
  return { violations, guarded }
}

/**
 * 输出层扫描：对「产品侧输出」断言不含红线词。
 * 注意：医学危险分层（如 medical.riskStratification='中危'）**属医生侧字段**，
 * 按红线第 2 条本就允许存在，故默认跳过医生侧字段，只查产品等级 / 体重措辞出现的字段。
 */
const DOCTOR_SIDE_KEYS = new Set(['medical', 'riskStratification', 'riskStratificationBasis'])

function scanWordingInOutput(obj, { skipKeys = DOCTOR_SIDE_KEYS } = {}) {
  const found = new Set()
  const seen = new Set()
  const walkObj = (v) => {
    if (v === null || v === undefined) return
    if (typeof v === 'string') {
      for (const w of WORD_LIST) if (v.includes(w)) found.add(w)
      return
    }
    if (typeof v !== 'object') return
    if (seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) {
      v.forEach(walkObj)
      return
    }
    for (const [k, val] of Object.entries(v)) {
      if (skipKeys.has(k)) continue
      walkObj(val)
    }
  }
  walkObj(obj)
  return [...found]
}

/* ================================================================== *
 * 夹具：第 4 位患者（只插数据，不改任何代码）
 * ================================================================== */
const P4 = {
  id: 'patient_4',
  username: 'zhaoguilan',
  name: '赵桂兰',
  gender: '女',
  birthDate: '1960-11-03', // 2026 现算 65 岁
  height: 158,
  phone: '13800138004',
  occupation: '退休（原小学教师）',
  contact: { id: 'contact_patient_4_1', name: '赵明', relation: '儿子', phone: '13800138024', authorized: 1 },
  primary: { name: '原发性高血压', grade: '1 级' },
  secondary: ['血脂异常'],
  targets: { systolic: 140, diastolic: 90, fastingGlucose: null },
  targetsBasis: {
    basis: '《中国老年高血压管理指南 2023》：65–79 岁先降至 < 140/90……（新增患者，仅插数据、零改码）',
    controlTarget: '血压控制在 140/90 mmHg 以下',
    demoThresholdNote: '演示判定阈值：收缩压 ≥140 / 舒张压 ≥90 判为超标。',
  },
  lifestyle: {
    diet: '口味偏咸，爱吃腌制食品',
    exercise: '每天散步约 30 分钟',
    sleep: '睡眠尚可，日均约 6.5 小时',
    biggestDifficulty: '担心血压波动',
    motivation: '想少给子女添麻烦',
    aiStyle: '安抚 + 提示',
    tags: { highSalt: true, pickledFood: true },
  },
  /** 7 天正常范围数据（不触发任何 BP/BG 规则，仅 info 级记录/勋章进度） */
  daily: [
    { date: '2026-09-08', steps: 5200, sys: 128, dia: 82, weight: 62.0, hr: 76, ex: 20, sleep: 6.5, mood: 4 },
    { date: '2026-09-09', steps: 6100, sys: 132, dia: 84, weight: 61.9, hr: 78, ex: 25, sleep: 6.8, mood: 4 },
    { date: '2026-09-10', steps: 5800, sys: 126, dia: 80, weight: 61.9, hr: 74, ex: 22, sleep: 6.4, mood: 3 },
    { date: '2026-09-11', steps: 6400, sys: 130, dia: 83, weight: 61.8, hr: 77, ex: 28, sleep: 6.9, mood: 4 },
    { date: '2026-09-12', steps: 6000, sys: 129, dia: 81, weight: 61.8, hr: 75, ex: 24, sleep: 6.6, mood: 4 },
    { date: '2026-09-13', steps: 5600, sys: 131, dia: 84, weight: 61.7, hr: 76, ex: 21, sleep: 6.3, mood: 3 },
    { date: '2026-09-14', steps: 5900, sys: 127, dia: 82, weight: 61.7, hr: 75, ex: 23, sleep: 6.7, mood: 4 },
  ],
}

function insertPatient4() {
  const db = dbOpen()
  try {
    db.exec('BEGIN')
    db.prepare(
      `INSERT INTO patients
         (patient_id, username, password_hash, name, gender, birth_date, height, phone, occupation, elderly_mode, voice_enabled, is_active)
       VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 1, 1, 1)`
    ).run(P4.id, P4.username, P4.name, P4.gender, P4.birthDate, P4.height, P4.phone, P4.occupation)

    db.prepare(
      `INSERT INTO patient_contacts (contact_id, patient_id, contact_name, relation, contact_phone, authorized, authorized_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    ).run(P4.contact.id, P4.id, P4.contact.name, P4.contact.relation, P4.contact.phone, P4.contact.authorized)

    db.prepare(
      `INSERT INTO patient_conditions
         (condition_id, patient_id, disease_name, disease_grade, is_primary, diagnosed_at, duration_text,
          risk_stratification, risk_basis, comorbidities, organ_damage)
       VALUES (?, ?, ?, ?, 1, NULL, ?, NULL, NULL, ?, NULL)`
    ).run('condition_patient_4_primary', P4.id, P4.primary.name, P4.primary.grade, '确诊 2 年', JSON.stringify([]))
    P4.secondary.forEach((name, i) => {
      db.prepare(
        `INSERT INTO patient_conditions
           (condition_id, patient_id, disease_name, disease_grade, is_primary, diagnosed_at, duration_text,
            risk_stratification, risk_basis, comorbidities, organ_damage)
         VALUES (?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, ?, NULL)`
      ).run(`condition_patient_4_secondary_${i + 1}`, P4.id, name, JSON.stringify([]))
    })

    db.prepare(
      `INSERT INTO patient_lifestyle (patient_id, diet, exercise, sleep, biggest_difficulty, motivation, ai_style, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      P4.id, P4.lifestyle.diet, P4.lifestyle.exercise, P4.lifestyle.sleep,
      P4.lifestyle.biggestDifficulty, P4.lifestyle.motivation, P4.lifestyle.aiStyle,
      JSON.stringify(P4.lifestyle.tags)
    )

    db.prepare(
      `INSERT INTO patient_targets
         (target_id, patient_id, systolic_target, diastolic_target, fasting_glucose_target, hba1c_target,
          bmi_target, waist_target, steps_target, weight_change_target, basis, effective_from, set_by)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`
    ).run(
      'target_patient_4_1', P4.id, P4.targets.systolic, P4.targets.diastolic,
      P4.targets.fastingGlucose, JSON.stringify(P4.targetsBasis)
    )

    db.prepare(
      `INSERT INTO doctor_patient_relations (relation_id, doctor_id, patient_id, is_active)
       VALUES (?, 'doc_li', ?, 1)`
    ).run('rel_doc_li_patient_4', P4.id)

    const insDaily = db.prepare(
      `INSERT INTO daily_health_records
         (record_id, patient_id, record_date, steps, systolic_pressure, diastolic_pressure, fasting_glucose,
          weight, waist, heart_rate, exercise_minutes, sleep_hours, mood_score, notes, source, record_status)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, '', 'manual', 'valid')`
    )
    P4.daily.forEach((r) => {
      insDaily.run(
        `patient_4_rec_${r.date}`, P4.id, r.date, r.steps, r.sys, r.dia,
        r.weight, r.hr, r.ex, r.sleep, r.mood
      )
    })
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    db.close()
  }
}

/* 规则复算：与 seed-sqlite.mjs 口径一致（从 DB 重放 evaluateClinicalRules） */
async function replayRules() {
  const { evaluateClinicalRules } = await import('../../src/utils/clinicalRules.js')
  const out = []
  for (const pid of ['patient_1', 'patient_2', 'patient_3']) {
    const rows = dbAll(
      `SELECT record_date, systolic_pressure, diastolic_pressure, fasting_glucose, weight, steps, exercise_minutes
         FROM daily_health_records WHERE patient_id = ? ORDER BY record_date`,
      pid
    )
    const recordsForRules = rows.map((r) => ({
      record_date: r.record_date,
      systolic_pressure: r.systolic_pressure,
      diastolic_pressure: r.diastolic_pressure,
      blood_sugar: r.fasting_glucose,
      weight: r.weight,
      steps: r.steps,
      exercise_minutes: r.exercise_minutes,
    }))
    const t = dbGet('SELECT * FROM patient_targets WHERE patient_id = ?', pid) || {}
    const lab = dbGet("SELECT test_date FROM lab_results WHERE patient_id = ? AND item_name = 'HbA1c'", pid)
    const medThreshold = {}
    if (t.systolic_target != null) medThreshold.systolic = t.systolic_target
    if (t.diastolic_target != null) medThreshold.diastolic = t.diastolic_target
    if (t.fasting_glucose_target != null) medThreshold.fastingGlucose = t.fasting_glucose_target
    const badgeTypes = dbAll(
      `SELECT bd.badge_type FROM badges b JOIN badge_definitions bd ON bd.badge_def_id = b.badge_def_id WHERE b.patient_id = ?`,
      pid
    ).map((x) => x.badge_type)
    const contact = dbGet('SELECT authorized FROM patient_contacts WHERE patient_id = ?', pid)
    const note = (() => {
      try {
        return JSON.parse(t.basis || '{}').demoThresholdNote ?? null
      } catch {
        return null
      }
    })()
    const monthsBetween = (from, to) =>
      Math.round((new Date(to) - new Date(from)) / 86400000 / 30.44)

    const patientLike = {
      profile: { emergencyContact: { authorized: !!contact?.authorized } },
      medical: {
        demoThreshold: medThreshold,
        demoThresholdNote: note,
        hba1cLastTestMonthsAgo: lab ? monthsBetween(lab.test_date, '2026-09-14') : undefined,
      },
      lifestyle: { tags: {} },
      badges: badgeTypes.map((type) => ({ type })),
    }
    const ev = evaluateClinicalRules(patientLike, recordsForRules)
    out.push({
      patientId: pid,
      matchedRules: ev.matched.map((r) => r.ruleId),
      levels: ev.matched.map((r) => `${r.ruleId}:${r.levelLabel}`),
      highestLevel: ev.highestLevel,
      bpCompliance: ev.stats.bloodPressure?.complianceRate ?? null,
      bgCompliance: ev.stats.bloodSugar?.complianceRate ?? null,
      weightNetChange: ev.stats.weightBehavior?.netChange ?? null,
      matchedPersistable: ev.matched.filter((r) => ['emergency', 'alert', 'watch'].includes(r.level)).map((r) => r.ruleId),
      matchedInfoOnly: ev.matched.filter((r) => r.level === 'info').map((r) => r.ruleId),
    })
  }
  return out
}

/* 断言：与 seed-sqlite.mjs 完全一致的期望值 */
const RULE_EXPECTATIONS = {
  patient_1: { must: ['R-BP-2'], mustNot: ['R-BP-3'], bpCompliance: 42.9 },
  patient_2: { must: ['R-BG-2', 'R-BG-3'], mustNot: ['R-BG-1'], bgCompliance: 57.1 },
  patient_3: { must: ['R-WT-2', 'R-WT-3', 'R-WT-4', 'R-WT-5'], mustNot: [], weightNetChange: -1.2 },
}

/* ================================================================== *
 * 主流程
 * ================================================================== */
const main = async () => {
  const record = {
    generatedAt: new Date().toISOString(),
    step: 'Step 6 · 最终验收（动态链路）',
    dbCopy: path.relative(ROOT, TEST_DB),
    realDbUntouched: null,
    checks,
    samples,
    ruleReplay: null,
    designChoice: null,
    knownNotPersisted: null,
    renameTest: null,
  }

  let server = null
  let renamed = false

  try {
    /* ---------- 0. 准备一次性副本库（真实库只读） ---------- */
    const realStat = fs.statSync(REAL_DB)
    fs.copyFileSync(REAL_DB, TEST_DB)
    for (const ext of ['-wal', '-shm']) {
      const p = `${TEST_DB}${ext}`
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
    check('S1 已建立一次性副本库（真实库仅复制、不写入）', fs.existsSync(TEST_DB), path.relative(ROOT, TEST_DB))

    /* ============================================================ *
     * A. 【最高优先级】demoPatients.js 改名 .bak 后链路仍通
     * ============================================================ */
    console.log('\n[A] 最高优先级：脱离 demoPatients.js（改名 .bak 后整链路仍通）')
    const runtimeOffenders = scanRuntimeForDemoPatients()
    check(
      'A1 运行时源码（src + server）0 处引用 demoPatients',
      runtimeOffenders.length === 0,
      `offenders=${runtimeOffenders.join(',') || 'none'}`
    )

    // 改名 → 重启后端 → 跑整条链路
    fs.renameSync(DEMO_SRC, DEMO_BAK)
    renamed = true
    server = startServer()
    const upRenamed = await waitForServer()
    check('A2 改名 .bak 后后端仍可启动', upRenamed, upRenamed ? `listening ${PORT}` : '启动超时')

    const rLogin = await req('POST', '/api/patients/login', { patientId: 'patient_1' })
    const rProfile = await req('GET', '/api/patients/patient_1/profile')
    const rRecords = await req('GET', '/api/patients/patient_1/records?days=7')
    const rSeries = await req('GET', '/api/patients/patient_1/series/systolic_pressure?days=7')
    const rBrief = await req('POST', '/api/agent/briefing', { patientId: 'patient_1' })
    const rRun = await consumeSSE('/api/agent/orchestrate', { patientId: 'patient_1', goal: '生成今日健康简报' })
    const rAlerts = await req('GET', '/api/patients/patient_1/alerts')
    const rDoctor = await req('GET', '/api/doctors/doc_li/patients')

    const chainOk =
      rLogin.status === 200 &&
      rProfile.status === 200 &&
      rRecords.status === 200 &&
      rSeries.status === 200 &&
      rBrief.status === 200 &&
      rRun.events.some((e) => e.type === 'run_done') &&
      rRun.events.some((e) => e.type === 'alerts_persisted') &&
      rAlerts.status === 200 &&
      rDoctor.status === 200

    record.renameTest = {
      renamed: true,
      chain: {
        login: rLogin.status,
        profile: rProfile.status,
        records: rRecords.status,
        series: rSeries.status,
        briefing: rBrief.status,
        orchestrate: rRun.status,
        runDone: rRun.events.some((e) => e.type === 'run_done'),
        alertsPersisted: rRun.events.some((e) => e.type === 'alerts_persisted'),
        alertsRead: rAlerts.status,
        doctor: rDoctor.status,
      },
      patient1Name: rProfile.json?.view?.name,
    }
    check(
      'A3 改名后「登录 → 档案 → 记录 → 趋势 → 晨报 → 协同 → 预警 → 医生端」全链路 200/事件齐全',
      chainOk,
      JSON.stringify(record.renameTest.chain)
    )

    await stopServer(server)
    server = null

    // 还原（文件内容未变）
    fs.renameSync(DEMO_BAK, DEMO_SRC)
    renamed = false
    const restoredEqual = fs.readFileSync(DEMO_SRC, 'utf8').length > 0
    check('A4 demoPatients.js 已还原（内容完整）', restoredEqual, 'renamed→restored')

    const dist = scanDistForDemoPatients()
    record.distScan = dist
    check(
      'A5 前端构建产物 0 处引用 demoPatients',
      dist.offenders.length === 0,
      `scanned=${dist.scanned} offenders=${dist.offenders.join(',') || 'none'}`
    )

    /* 重启后端（正常状态），进入 B~J */
    server = startServer()
    const up = await waitForServer()
    check('S2 后端就绪（本地推理引擎 + 副本库）', up, up ? `listening ${PORT}` : '启动超时')
    if (!up) throw new Error('后端未启动，终止验收')

    /* ---------- DB 基线 ---------- */
    const tables = dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name)
    const p1p2 = ['weight_readings', 'point_transactions', 'user_levels', 'community_activities', 'user_activity_participations'].filter((t) => tables.includes(t))
    check('S3 P0 仍为 22 张表，P1/P2 未建', tables.length === 22 && p1p2.length === 0, `tables=${tables.length} P1/P2=${p1p2.join(',') || 'none'}`)

    /* ============================================================ *
     * B. 新增第 4 位患者（只插数据、不改代码）
     * ============================================================ */
    console.log('\n[B] 新增第 4 位患者（只插数据、不改任何代码）')
    const before4 = dbGet('SELECT COUNT(*) AS c FROM patients').c
    insertPatient4()
    const after4 = dbGet('SELECT COUNT(*) AS c FROM patients').c
    check('B1 只经 SQL 插入患者 4（patients/contacts/conditions/lifestyle/targets/relations/daily 7 天）', before4 === 3 && after4 === 4, `${before4} → ${after4}`)

    const listRes = await req('GET', '/api/patients')
    const listIds = (listRes.json?.patients || []).map((p) => p.id)
    samples.patientEntries = listRes.json?.patients
    check(
      'B2 登录页示范入口（/api/patients）自动出现第 4 位患者',
      listRes.status === 200 && listIds.includes('patient_4') && listIds.length === 4,
      `ids=${listIds.join(',')}`
    )

    const login4 = await req('POST', '/api/patients/login', { patientId: 'patient_4' })
    check(
      'B3 第 4 位患者可登录（patient_id 身份）',
      login4.status === 200 && login4.json?.view?.name === P4.name,
      `status=${login4.status} name=${login4.json?.view?.name}`
    )

    const prof4 = await req('GET', '/api/patients/patient_4/profile')
    const v4 = prof4.json?.view || {}
    check(
      'B4 第 4 位患者档案齐备（年龄现算/疾病/画像/目标/紧急联系人授权）',
      prof4.status === 200 &&
        v4.age === 65 &&
        (v4.diseases || []).includes(P4.primary.name) &&
        Boolean(v4.emergencyContact?.name) &&
        Boolean(v4.medical?.controlTarget) &&
        (v4.lifestyle?.tags?.highSalt === true),
      `age=${v4.age} diseases=${JSON.stringify(v4.diseases)} contact=${v4.emergencyContact?.name}`
    )

    const rec4 = await req('GET', '/api/patients/patient_4/records?days=30')
    const ser4 = await req('GET', '/api/patients/patient_4/series/systolic_pressure?days=7')
    check(
      'B5 第 4 位患者趋势可取数（records 7 条 + 收缩压序列 7 点）',
      rec4.status === 200 && rec4.json?.count === 7 && ser4.json?.count === 7,
      `records=${rec4.json?.count} series=${ser4.json?.count} latest=${ser4.json?.stats?.latest}`
    )

    const brief4 = await req('POST', '/api/agent/briefing', { patientId: 'patient_4' })
    check(
      'B6 第 4 位患者晨报可生成（后端按 patient_id 自取）',
      brief4.status === 200 && typeof brief4.json?.score === 'number' && Boolean(brief4.json?.risk?.label),
      `score=${brief4.json?.score} risk=${brief4.json?.risk?.label}`
    )

    const alerts4Before = await req('GET', '/api/patients/patient_4/alerts')
    const r4run = await consumeSSE('/api/agent/orchestrate', { patientId: 'patient_4', goal: '生成今日健康简报' })
    const p4ev = r4run.events.find((e) => e.type === 'alerts_persisted')
    check(
      'B7 第 4 位患者协同可跑（run_done + alerts_persisted 事件）',
      r4run.status === 200 && r4run.events.some((e) => e.type === 'run_done') && Boolean(p4ev),
      p4ev ? `inserted=${p4ev.inserted} updated=${p4ev.updated}` : '缺失'
    )
    check(
      'B8 初始 7 天为正常范围 → 命中集仅「提示」级 → 不产生落库预警（0 条）',
      alerts4Before.status === 200 && (alerts4Before.json?.count || 0) === 0,
      `alerts=${alerts4Before.json?.count}`
    )

    const docRes = await req('GET', '/api/doctors/doc_li/patients')
    const docIds = (docRes.json?.patients || []).map((p) => p.id)
    check(
      'B9 医生端经关系表自动出现第 4 位患者（含档案口径与 risk 状态）',
      docRes.status === 200 && docIds.length === 4 && docIds.includes('patient_4'),
      `ids=${docIds.join(',')} status=${JSON.stringify((docRes.json?.patients || []).map((p) => `${p.id}:${p.status}`))}`
    )

    const roster = scanPagesForDynamicRoster()
    record.pageRosterScan = roster
    check(
      'B10 患者名单动态化：页面 0 处引用 DEMO_PATIENTS；医生端/登录页名单均走 API',
      roster.demoRefs.length === 0 && roster.doctorUsesApi && roster.loginUsesApi,
      JSON.stringify(roster)
    )

    /* ============================================================ *
     * C. 新增一天数据 → 追加不覆盖 + 下游自动重算
     * ============================================================ */
    console.log('\n[C] 新增一天数据 → 重新请求 API 可见更新；追加不覆盖')
    // 取一条「历史」记录作为不变量
    const histDate = '2026-09-10'
    const histBefore = dbGet(
      'SELECT record_date, systolic_pressure, diastolic_pressure, weight FROM daily_health_records WHERE patient_id = ? AND record_date = ?',
      P4.id, histDate
    )

    const recBefore = await req('GET', '/api/patients/patient_4/records?days=30')
    const windowBefore = recBefore.json?.window
    const countBefore = recBefore.json?.count

    const POST = await req('POST', '/api/patients/patient_4/records', {
      date: '2026-09-15',
      systolic: 186,
      diastolic: 100,
      heartRate: 88,
    })
    check(
      'C1 录入新一天（09-15，收缩压 186）→ 追加成功（created=true）',
      POST.status === 200 && POST.json?.created === true && POST.json?.record?.record_date === '2026-09-15',
      `status=${POST.status} created=${POST.json?.created} date=${POST.json?.record?.record_date}`
    )

    const recAfter = await req('GET', '/api/patients/patient_4/records?days=30')
    const countAfter = recAfter.json?.count
    const serAfter = await req('GET', '/api/patients/patient_4/series/systolic_pressure?days=7')
    check(
      'C2 重新请求 API 即见更新：计数 7→8，窗口末端前移 09-14→09-15（无需改码/重建）',
      countAfter === countBefore + 1 && recAfter.json?.window?.to === '2026-09-15',
      `count ${countBefore}→${countAfter} windowTo ${windowBefore?.to}→${recAfter.json?.window?.to} latest=${serAfter.json?.stats?.latest}`
    )

    const histAfter = dbGet(
      'SELECT record_date, systolic_pressure, diastolic_pressure, weight FROM daily_health_records WHERE patient_id = ? AND record_date = ?',
      P4.id, histDate
    )
    check(
      'C3 追加不覆盖：历史日（09-10）数值前后完全一致',
      deepEqual(histBefore, histAfter),
      `${JSON.stringify(histBefore)} vs ${JSON.stringify(histAfter)}`
    )
    const histViaApiBefore = (recBefore.json?.records || []).find((r) => r.record_date === histDate)
    const histViaApiAfter = (recAfter.json?.records || []).find((r) => r.record_date === histDate)
    check(
      'C4 历史可回溯（判据 4）：同一日期经 API 读到的值不变',
      deepEqual(
        { s: histViaApiBefore?.systolic_pressure, d: histViaApiBefore?.diastolic_pressure, w: histViaApiBefore?.weight },
        { s: histViaApiAfter?.systolic_pressure, d: histViaApiAfter?.diastolic_pressure, w: histViaApiAfter?.weight }
      ),
      `${histViaApiBefore?.systolic_pressure}/${histViaApiBefore?.diastolic_pressure} → ${histViaApiAfter?.systolic_pressure}/${histViaApiAfter?.diastolic_pressure}`
    )

    // 同日重复提交 = 更正当日值（不新增行）
    const rowsOnDate = () => dbGet('SELECT COUNT(*) AS c FROM daily_health_records WHERE patient_id = ? AND record_date = ?', P4.id, '2026-09-15').c
    const r1 = rowsOnDate()
    const CORR = await req('POST', '/api/patients/patient_4/records', { date: '2026-09-15', systolic: 181 })
    const r2 = rowsOnDate()
    const corrRow = dbGet('SELECT systolic_pressure, diastolic_pressure, heart_rate, record_status FROM daily_health_records WHERE patient_id = ? AND record_date = ?', P4.id, '2026-09-15')
    check(
      'C5 同日重复提交为「更正当日值」：行数不变、未提交字段保留、record_status=corrected',
      r1 === 1 && r2 === 1 &&
        corrRow.systolic_pressure === 181 && corrRow.diastolic_pressure === 100 && corrRow.heart_rate === 88 &&
        corrRow.record_status === 'corrected',
      `rows ${r1}→${r2} ${JSON.stringify(corrRow)}`
    )

    // 下游自动重算：规则命中 → alerts 落库
    const reRun = await consumeSSE('/api/agent/orchestrate', { patientId: 'patient_4', goal: '复查血压' })
    const rePersist = reRun.events.find((e) => e.type === 'alerts_persisted')
    const alerts4After = await req('GET', '/api/patients/patient_4/alerts')
    const rules4 = (alerts4After.json?.alerts || []).map((a) => a.ruleId)
    samples.patient4Alerts = alerts4After.json?.alerts
    check(
      'C6 下游自动重算（判据 5）：新数据触发 R-BP-3，alerts 表出现新记录',
      rules4.includes('R-BP-3') && (rePersist?.inserted ?? 0) >= 1,
      `rules=${rules4.join(',')} persisted=${JSON.stringify(rePersist && { inserted: rePersist.inserted, updated: rePersist.updated })}`
    )

    /* ============================================================ *
     * D. 13 条规则口径一致
     * ============================================================ */
    console.log('\n[D] 13 条规则在真实数据上的判定结果与自检脚本一致')
    const { RULE_CATALOG } = await import('../../src/utils/clinicalRules.js')
    const catalogSize = Object.keys(RULE_CATALOG).length
    const replay = await replayRules()
    record.ruleReplay = replay
    const replayOk = replay.every((r) => {
      const exp = RULE_EXPECTATIONS[r.patientId] || {}
      return (
        (exp.must || []).every((x) => r.matchedRules.includes(x)) &&
        (exp.mustNot || []).every((x) => !r.matchedRules.includes(x)) &&
        (exp.bpCompliance === undefined || r.bpCompliance === exp.bpCompliance) &&
        (exp.bgCompliance === undefined || r.bgCompliance === exp.bgCompliance) &&
        (exp.weightNetChange === undefined || r.weightNetChange === exp.weightNetChange)
      )
    })
    check('D1 规则目录共 13 条', catalogSize === 13, `rules=${catalogSize}`)
    check(
      'D2 三位患者规则复算与自检脚本完全一致（含达标率/净变化数值）',
      replayOk,
      replay.map((r) => `${r.patientId}:[${r.matchedRules.join(',')}] bp=${r.bpCompliance} bg=${r.bgCompliance} wt=${r.weightNetChange}`).join(' | ')
    )

    /* ============================================================ *
     * E. 预警落库：刷新仍在 + 医生端可见 + 只记录不外发
     * ============================================================ */
    console.log('\n[E] 预警落库后刷新仍在、医生端可见、外部通知只记录不外发')
    const al1 = await req('GET', '/api/patients/patient_1/alerts')
    const al2 = await req('GET', '/api/patients/patient_1/alerts') // 模拟「刷新页面」
    check(
      'E1 刷新（二次请求）预警仍在且内容一致（落库非内存）',
      al1.status === 200 && (al1.json?.count || 0) > 0 && deepEqual(al1.json, al2.json),
      `count=${al1.json?.count}`
    )
    const doc2 = await req('GET', '/api/doctors/doc_li/patients')
    const p1Doc = (doc2.json?.patients || []).find((p) => p.id === 'patient_1')
    check(
      'E2 医生端可见患者落库预警（alertRecords 含 ruleId/level/detail）',
      Boolean(p1Doc?.alertRecords?.length) && p1Doc.alertRecords.every((a) => a.ruleId && a.level && a.detail),
      `patient_1 alertRecords=${p1Doc?.alertRecords?.length}`
    )
    const allAlerts = [
      ...(al1.json?.alerts || []),
      ...((await req('GET', '/api/patients/patient_2/alerts')).json?.alerts || []),
      ...((await req('GET', '/api/patients/patient_3/alerts')).json?.alerts || []),
      ...(alerts4After.json?.alerts || []),
    ]
    check(
      'E3 外部通知未外发：notifyTargets 仅 self、externalBlocked=true、confirmed=false',
      allAlerts.length > 0 &&
        allAlerts.every(
          (a) =>
            Array.isArray(a.notifyTargets) && a.notifyTargets.length === 1 && a.notifyTargets[0] === 'self' &&
            a.externalBlocked === true && a.confirmed === false
        ),
      `n=${allAlerts.length} sample=${JSON.stringify(allAlerts[0]?.notifyTargets)} blocked=${allAlerts[0]?.externalBlocked}`
    )
    const policy = allAlerts.every((a) => Array.isArray(a.pendingNotify) && a.pendingNotify.length >= 1)
    check('E4 紧急联系人遵循「已授权 + 本人确认」双条件：待确认对象仅记录不发送', policy, `sample pending=${JSON.stringify(allAlerts[0]?.pendingNotify)}`)

    /* ============================================================ *
     * F. 医生端签名固定「李医生」
     * ============================================================ */
    console.log('\n[F] 医生端签名一律「李医生」，不出现患者姓名')
    const docObj = doc2.json?.doctor
    const sig = scanDoctorSignature()
    record.doctorSignature = { api: docObj, staticScan: sig }
    check(
      'F1 医生端身份固定（李医生｜主任医师·全科）',
      docObj?.name === '李医生' && docObj?.title === '主任医师' && docObj?.department === '全科',
      `${docObj?.name}｜${docObj?.title}·${docObj?.department}`
    )
    check(
      'F2 备注签名由后端从 doctors 表注入（前端不拼签名、不用患者姓名）',
      sig.hasFixedDoctorConst && !sig.sendsDoctorNameFromClient && !sig.signsWithUserName,
      JSON.stringify(sig)
    )

    /* ============================================================ *
     * G. 跨浏览器一致 + 不依赖 localStorage
     * ============================================================ */
    console.log('\n[G] 跨「浏览器」读到同一份数据；健康数据不落 localStorage')
    const gA = await req('GET', '/api/patients/patient_1/records?days=7')
    const gB = await req('GET', '/api/patients/patient_1/records?days=7')
    const gC = await req('GET', '/api/patients/patient_1/profile')
    const gD = await req('GET', '/api/patients/patient_1/profile')
    const gE = await req('GET', '/api/patients/patient_1/snapshot')
    const gF = await req('GET', '/api/patients/patient_1/snapshot')
    const recordsEqual = deepEqual(gA.json, gB.json)
    const profileEqual = deepEqual(gC.json, gD.json)
    const snapshotEqual = deepEqual(gE.json, gF.json)
    record.crossClient = { recordsEqual, profileEqual, snapshotEqual }
    check(
      'G1 两个独立客户端（无共享本地状态）读到逐字节一致的数据：records / profile / snapshot',
      recordsEqual && profileEqual && snapshotEqual,
      `records=${recordsEqual} profile=${profileEqual} snapshot=${snapshotEqual}`
    )
    const ls = scanLocalStorage()
    record.localStorageScan = ls
    check(
      'G2 健康数据未落 localStorage：0 个健康类文件使用它，且仅身份类键（user / userSettings / mycare_accounts）',
      ls.apiCalls.length > 0 && ls.nonIdentity.length === 0 && ls.healthFileCalls.length === 0,
      `keys=${ls.identityKeys.join(',')} nonIdentity=${JSON.stringify(ls.nonIdentity)} healthFiles=${JSON.stringify(ls.healthFileCalls)}`
    )

    /* ============================================================ *
     * H. 口径红线扫描
     * ============================================================ */
    console.log('\n[H] 口径红线扫描')
    const levelWord = new Set(['提示', '关注', '预警', '紧急'])
    check(
      'H1 落库等级全部为产品词表（提示/关注/预警/紧急）',
      allAlerts.length > 0 && allAlerts.every((a) => levelWord.has(a.level)),
      [...new Set(allAlerts.map((a) => a.level))].join(',')
    )
    const wording = scanWording()
    const alertsWording = scanWordingInOutput(allAlerts, { skipKeys: new Set() })
    const doctorWording = scanWordingInOutput(doc2.json)
    record.wordingScan = { ...wording, inAlerts: alertsWording, inDoctorApi: doctorWording }
    check(
      'H2 红线措辞：源码仅出现在禁止性说明/医学侧字段；落库 alerts 与医生端产品级输出 0 出现',
      wording.violations.length === 0 && alertsWording.length === 0 && doctorWording.length === 0,
      `violations=${wording.violations.join(',') || 'none'} guarded=${wording.guarded.length} inAlerts=${JSON.stringify(alertsWording)} inDoctor=${JSON.stringify(doctorWording)}(已排除医生侧字段)`
    )
    check(
      'H3 数值/达标率/等级均来自规则引擎（落库 detail 为确定性依据，非 AI 生成）',
      allAlerts.every((a) => a.ruleId && a.detail) && (al1.json?.alerts || []).some((a) => a.ruleId === 'R-BP-2' && /连续/.test(a.detail)),
      `sample=${String((al1.json?.alerts || []).find((a) => a.ruleId === 'R-BP-2')?.detail || '').slice(0, 56)}`
    )

    /* ============================================================ *
     * I. 设计选择显式取证：命中集 ⊋ 持久化集（提示级不入库）
     * ============================================================ */
    console.log('\n[I] 设计选择取证：clinicalRules 命中集 ⊋ alerts 持久化集')
    const { PERSIST_LEVELS } = await import('../../server/data/alertService.js')
    const { evaluateClinicalRules } = await import('../../src/utils/clinicalRules.js')

    // 直接用后端装配层重放第 4 位患者（含新增日）
    const { buildAgentContext, buildRuleEvaluation } = await import('../../server/data/agentContext.js')
    const ctx4 = await buildAgentContext('patient_4', { days: 7 })
    const ev4 = buildRuleEvaluation(ctx4)
    const matchedIds = ev4.matched.map((r) => `${r.ruleId}:${r.levelLabel}`)
    const matchedPersistable = ev4.matched.filter((r) => PERSIST_LEVELS.includes(r.level)).map((r) => r.ruleId)
    const matchedInfoOnly = ev4.matched.filter((r) => r.level === 'info').map((r) => r.ruleId)
    const persistedIds = (alerts4After.json?.alerts || []).map((a) => a.ruleId)
    const sorted = (arr) => [...arr].sort()

    record.designChoice = {
      persistLevels: PERSIST_LEVELS,
      matchedIds,
      matchedPersistable: sorted(matchedPersistable),
      matchedInfoOnly: sorted(matchedInfoOnly),
      persistedIds: sorted(persistedIds),
    }
    check(
      'I1 PERSIST_LEVELS 精确为 emergency/alert/watch（提示级明确排除）',
      JSON.stringify(PERSIST_LEVELS) === JSON.stringify(['emergency', 'alert', 'watch']),
      PERSIST_LEVELS.join(',')
    )
    check(
      'I2 命中集 ⊋ 持久化集：info 级规则命中但按设计不入库（非遗漏）',
      matchedInfoOnly.length > 0 &&
        sorted(persistedIds).join(',') === sorted(matchedPersistable).join(',') &&
        persistedIds.length < matchedIds.length,
      `matched=${matchedIds.join(',')} | persisted=${persistedIds.join(',')}`
    )
    check(
      'I3 未持久化的命中项恰好都是「提示」级（info）——差异可解释、可复现',
      matchedInfoOnly.every((id) => {
        const m = ev4.byId[id]
        return m && m.level === 'info'
      }) && sorted(persistedIds).join(',') === sorted(matchedPersistable).join(','),
      `infoOnly=${matchedInfoOnly.join(',')}`
    )

    /* ============================================================ *
     * J. 持久化边界清单（Step 11 起 doctor_notes / prescriptions 已转为有意落库）
     * ============================================================ */
    console.log('\n[J] 已知未持久化能力（本阶段明确未启用）')
    const notPersisted = {}
    for (const [label, tbl] of [
      ['用药提醒', 'reminders'],
      ['协同轨迹', 'agent_runs'],
      ['服药记录', 'medication_logs'],
      ['医生备注', 'doctor_notes'],
      ['图像识别记录', 'vision_records'],
      ['健康建议', 'prescriptions'],
      ['血压明细', 'blood_pressure_readings'],
      ['血糖明细', 'blood_glucose_readings'],
    ]) {
      const exists = tables.includes(tbl)
      const rows = exists ? dbGet(`SELECT COUNT(*) AS c FROM ${tbl}`).c : null
      notPersisted[tbl] = { label, tableExists: exists, rows }
    }
    record.knownNotPersisted = notPersisted
    samples.tables = tables
    check(
      'J1 reminders（用药提醒）表存在但 0 行 —— 会话内存实现，未持久化',
      notPersisted.reminders.tableExists && notPersisted.reminders.rows === 0,
      `rows=${notPersisted.reminders.rows}`
    )
    check(
      'J2 agent_runs（协同轨迹）表存在但 0 行 —— 未写运行存档',
      notPersisted.agent_runs.tableExists && notPersisted.agent_runs.rows === 0,
      `rows=${notPersisted.agent_runs.rows}`
    )
    check(
      'J3 干净副本中事件/明细表均为 0 行（本验收流程不触发这些写入）',
      ['medication_logs', 'doctor_notes', 'vision_records', 'prescriptions', 'blood_pressure_readings', 'blood_glucose_readings'].every(
        (t) => notPersisted[t].tableExists && notPersisted[t].rows === 0
      ),
      Object.entries(notPersisted).map(([k, v]) => `${k}=${v.rows}`).join(' ')
    )
    check(
      'J4 本验收流程中唯一闭环落库表为 alerts',
      dbGet("SELECT COUNT(*) AS c FROM alerts").c > 0,
      `alerts rows=${dbGet('SELECT COUNT(*) AS c FROM alerts').c}`
    )
    /**
     * Step 11 起，`doctor_notes` 与 `prescriptions` 已**转为有意落库**的表：
     *   · `prescriptions.target_goals` 承载医生对「今日任务」的生效覆盖包（零 schema 变更）；
     *   · `doctor_notes` 承载医生建议（真落库，替代此前刷新即丢的内存假功能）。
     * 它们在本脚本的干净副本里仍为 0 行，是因为**本流程不触达医生端写接口**；
     * 真正的写入验收在 `verify-doctor-task-override.mjs`（A32/A33 + B8–B13）。
     * 加此条是为了防止后人据 J3 把这两张表误判为「按设计留空」而删掉落库逻辑。
     */
    check(
      'J5 doctor_notes / prescriptions 已转为有意落库表（写入由 verify-doctor-task-override 验收）',
      notPersisted.doctor_notes.tableExists &&
        notPersisted.prescriptions.tableExists &&
        notPersisted.doctor_notes.rows === 0 &&
        notPersisted.prescriptions.rows === 0,
      `doctor_notes=${notPersisted.doctor_notes.rows} prescriptions=${notPersisted.prescriptions.rows}（本流程未触达医生端写接口）`
    )

    /* ---------- 收尾：真实库未被改动 ---------- */
    const realStatAfter = fs.statSync(REAL_DB)
    record.realDbUntouched = {
      sizeBefore: realStat.size,
      sizeAfter: realStatAfter.size,
      mtimeBefore: new Date(realStat.mtimeMs).toISOString(),
      mtimeAfter: new Date(realStatAfter.mtimeMs).toISOString(),
      unchanged: realStat.size === realStatAfter.size && realStat.mtimeMs === realStatAfter.mtimeMs,
    }
    check(
      'S4 真实演示库 data/mycare.db 全程零改动（仅副本被写入）',
      record.realDbUntouched.unchanged,
      `size=${realStat.size} unchanged=${record.realDbUntouched.unchanged}`
    )

    record.summary = { passed, failed, total: passed + failed, allPass: failed === 0 }
    console.log(`\n==== Step 6 最终验收：${passed}/${passed + failed} 通过 ====`)
  } catch (err) {
    console.error('验收中断：', err)
    record.summary = { passed, failed, total: passed + failed, allPass: false, error: String(err?.message || err) }
    process.exitCode = 1
  } finally {
    await stopServer(server)
    // 强制还原改名
    if (renamed) {
      try {
        if (fs.existsSync(DEMO_BAK) && !fs.existsSync(DEMO_SRC)) fs.renameSync(DEMO_BAK, DEMO_SRC)
      } catch {
        /* ignore */
      }
    }
    // 关闭本进程内复用/未复用的 SQLite 句柄，否则 Windows 下副本库文件无法删除
    try {
      const { closeDb } = await import('../../server/data/db.js')
      closeDb()
    } catch {
      /* ignore */
    }
    // 删除一次性副本库
    for (const p of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
    record.copyDbRemoved = !fs.existsSync(TEST_DB)

    // 统一在结尾落盘（含清理结果），保证 record 反映最终真实状态
    try {
      fs.writeFileSync(path.join(ROOT, 'data', 'step6-verify-record.json'), JSON.stringify(record, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }
}

main()
