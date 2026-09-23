/**
 * 迈康 MyCare · 患者数据 API 客户端（第二阶段 Step 4）
 * ===========================================================================
 * 页面不再读取 localStorage / demoPatients.js：
 *   前端 → /api/patients/* → dataProvider → SQLite → 返回页面
 *
 * 约定：
 *   · 患者身份以 patient_id 为唯一规范键；登录接口入站可兼容 user_id 别名。
 *   · 后端患者不存在时返回 404（E_PATIENT_NOT_FOUND）——前端**不得回落到默认患者**，
 *     调用方应据 code 决定展示（例如自定义注册用户显示"暂无数据库档案"）。
 *   · 本模块只做 HTTP 封装，不含任何业务阈值 / 等级 / 达标率计算。
 */

const BASE = '/api'

/** 统一 fetch 包装：非 2xx 抛 Error（带 code / detail / status） */
async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    let code = null
    let detail = null
    try {
      const data = await res.json()
      if (data?.error) message = data.error
      code = data?.code ?? null
      detail = data?.detail ?? null
    } catch {
      /* ignore */
    }
    const err = new Error(message)
    err.code = code
    err.detail = detail
    err.status = res.status
    throw err
  }
  return res.json()
}

const pid = (patientId) => encodeURIComponent(patientId)

/** 示范病例入口列表（登录页） */
export const listPatients = () => request('/patients').then((r) => r.patients || [])

/**
 * 登录身份解析 → { patientId, view }
 * @param {{ patientId?: string, username?: string, password?: string }} payload
 *   · patientId 路径用于免密示范病例一键进入；
 *   · username 路径：示范病例免密，自助注册账号必须带 password（后端 scrypt 校验）。
 */
export const loginPatient = (payload) => request('/patients/login', { method: 'POST', body: payload })

/**
 * 自助注册：在服务端 patients 建立属于该账号的真实档案，返回 { patientId, view }。
 * 注册后示范入口列表不变，新账号从「零记录」开始，数据由用户自己录入产生。
 */
export const registerPatient = (payload) => request('/patients/register', { method: 'POST', body: payload })

/** 找回密码：用户名 + 注册手机号双因子匹配后重置 */
export const resetPassword = (payload) => request('/patients/reset-password', { method: 'POST', body: payload })

/** 患者档案（原始 ProfileResult + 兼容视图 view） */
export const getProfile = (patientId) => request(`/patients/${pid(patientId)}/profile`)

/**
 * 完善 / 更新健康档案（「从 0 到 1」建档闭环）。
 * ------------------------------------------------------------------
 * 一次提交六类档案，后端按「有行则 UPDATE、无行才 INSERT」落库：
 *   · identity         基础信息（姓名 / 性别 / 年龄 / 身高 / 手机 / 职业）
 *   · emergencyContact 紧急联系人（姓名 / 关系 / 电话 / 是否授权外发）
 *   · conditions[]     疾病诊断（病名 / 分级 / 病程 / 心血管危险分层 / 合并症）
 *   · lifestyle        生活画像（饮食 / 运动 / 睡眠 / 最大困难 / 动力 / 沟通风格）
 *   · targets          个体化控制目标（血压 / 空腹血糖 / BMI / 腰围 / 步数）
 *   · medications[]    用药计划（药名 / 剂量 / 频次 / 时间）
 * 只传 patientId 与档案字段，**不回传任何体征记录**（后端不从本请求推断规则结论）。
 */
export const updateProfile = (patientId, payload) =>
  request(`/patients/${pid(patientId)}/profile`, { method: 'PUT', body: payload })

/** 当日快照 */
export const getSnapshot = (patientId, date) =>
  request(`/patients/${pid(patientId)}/snapshot${date ? `?date=${encodeURIComponent(date)}` : ''}`)

/** 单指标时间序列 */
export const getSeries = (patientId, metricKey, { days = 7, ...opts } = {}) => {
  const q = new URLSearchParams({ days: String(days) })
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  }
  return request(`/patients/${pid(patientId)}/series/${encodeURIComponent(metricKey)}?${q.toString()}`)
}

/** 记录列表（页面用，默认近 30 天） */
export const getRecords = (patientId, days = 30) =>
  request(`/patients/${pid(patientId)}/records?days=${Number(days) || 30}`)

/** 勋章列表 */
export const getBadges = (patientId) =>
  request(`/patients/${pid(patientId)}/badges`).then((r) => r.badges || [])

/**
 * 落库预警（alerts 表）。
 * 数据来源：Agent 运行结束后由确定性规则（clinicalRules）命中结果落库，
 * 前端只读取展示，不参与等级 / 阈值判定。
 */
export const getAlerts = (patientId, { limit = 20 } = {}) =>
  request(`/patients/${pid(patientId)}/alerts?limit=${Number(limit) || 20}`).then((r) => r.alerts || [])

/** 录入 / 修正一条当日健康数据（写库） */
export const addRecord = (patientId, record) =>
  request(`/patients/${pid(patientId)}/records`, { method: 'POST', body: record })

/* ------------------------------------------------------------------ *
 * Step 9 · 一天多次测量（事实层追加） + 今日任务（派生视图）
 * ------------------------------------------------------------------ */

/**
 * 今日任务（确定性规则生成，进度由当天有效 readings 实时派生）。
 * 该接口只读不写：任务进度**不落库**。
 */
export const getDailyTasks = (patientId, date) =>
  request(`/patients/${pid(patientId)}/daily-tasks${date ? `?date=${encodeURIComponent(date)}` : ''}`)

/**
 * 追加一次血压测量 —— **新增一条**，同一天多次互不覆盖。
 * @param {{ date?:string, systolic:number, diastolic:number, pulse?:number,
 *           slot?:'晨起'|'上午'|'下午'|'睡前', time?:string }} payload
 *   注意：UI 显示「午后」，落库值必须是「下午」。
 */
export const addBloodPressureReading = (patientId, payload) =>
  request(`/patients/${pid(patientId)}/readings`, {
    method: 'POST',
    body: { kind: 'blood_pressure', ...payload },
  })

/**
 * 追加一次血糖测量 —— **新增一条**；measureType 必填
 * （空腹 / 餐后2h / 随机 / 睡前），否则空腹与餐后语义会取错。
 */
export const addBloodGlucoseReading = (patientId, payload) =>
  request(`/patients/${pid(patientId)}/readings`, {
    method: 'POST',
    body: { kind: 'blood_glucose', ...payload },
  })

/** 服药打卡（一个药物多个服药时间 = 多个计划实例） */
export const addMedicationLog = (patientId, payload) =>
  request(`/patients/${pid(patientId)}/medication-logs`, { method: 'POST', body: payload })

/** 医生端：经 doctor_patient_relations 查询管理患者（**仅患者已授权者**） */
export const getDoctorPatients = (doctorId = 'doc_li') =>
  request(`/doctors/${encodeURIComponent(doctorId)}/patients`)

/* ------------------------------------------------------------------ *
 * 隐私授权闭环（2026-09-17）—— 患者本人可给可撤的「医生查阅授权」
 * --------------------------------------------------------------------
 * · 医生端可见性 = doctor_patient_relations.is_active，由**患者**单方面控制：
 *   注册只建立关联（is_active = 0，医生端不可见），患者同意后医生端才可见；
 * · 本模块只传 patientId / doctorId / 布尔 granted，**绝不回传**任何健康数据；
 * · 撤回后医生端立即不再返回该患者，患者已录入的数据不受影响。
 * ------------------------------------------------------------------ */

/** 我的医疗团队：列出全部在册医生及其授权状态 */
export const getCareTeam = (patientId) => request(`/patients/${pid(patientId)}/care-team`)

/** 授权 / 撤回某医生查阅本人档案（granted: true = 同意，false = 撤回） */
export const setDoctorConsent = (patientId, doctorId, granted) =>
  request(`/patients/${pid(patientId)}/care-team/${encodeURIComponent(doctorId)}`, {
    method: 'POST',
    body: { granted },
  })

/* ------------------------------------------------------------------ *
 * Step 11 · Phase 3 · AI 评分三分层
 * --------------------------------------------------------------------
 * 红线（与 src/utils/aiScore.js 一致）：
 *   · 界面**主数字永远是 Rule Score**（唯一正式分），AI 辅助分是次级显示项；
 *   · AI **永远不直接输出分数**，它只给结构化 adjustments，合成由后端确定性纯函数完成；
 *   · AI 辅助分**不参与**预警等级 / 达标率 / 规则命中。
 * 这两个接口都只传 patientId，后端自取当日体征与疾病谱现算 Rule Score。
 * ------------------------------------------------------------------ */

/**
 * 读取当日「Rule Score + 已缓存的 AI 辅助分」—— **只读缓存，不触发模型调用**。
 * 未生成时返回 `{ aiStatus: null, cached: false }`，界面应显示「未生成」而不是「不可用」。
 */
export const readAiScore = (patientId, date) =>
  request(`/patients/${pid(patientId)}/score${date ? `?date=${encodeURIComponent(date)}` : ''}`)

/**
 * 生成（或读缓存）当日 AI 评分。
 * @param {string} patientId
 * @param {{ force?: boolean, date?: string }} [opts] force=true 跳过当日缓存重新生成
 */
export const generateAiScore = (patientId, { force = false, date } = {}) =>
  request('/agent/score', { method: 'POST', body: { patientId, force, ...(date ? { date } : {}) } })
