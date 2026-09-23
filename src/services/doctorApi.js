/**
 * 迈康 MyCare · 医生端 API 客户端（Step 11 · Phase 1）
 * ===========================================================================
 * 与 patientApi.js / agentApi.js 同构：只做 HTTP 封装，不含任何业务阈值计算。
 *
 * 关键约定（与后端契约严格对齐）：
 *   · 覆盖包校验的**唯一尺子**在 `src/utils/taskOverride.js`（前后端共用）。
 *     本模块只负责把请求发出去；前端预校验仅用于即时提示，**准入判定一律以后端为准**。
 *   · 后端非法入参返回 400 + 具体 code（E_TARGET_OUT_OF_RANGE 等），调用方应把它
 *     原样展示给医生 —— 不允许前端改写或忽略错误码。
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
  if (res.status === 204) return null
  return res.json()
}

/** 某患者当日任务实况 + 生效覆盖包 + 可覆盖字段字典 */
export const getPatientTasks = (doctorId, patientId, date) =>
  request(
    `/doctors/${encodeURIComponent(doctorId)}/patients/${encodeURIComponent(patientId)}/tasks${
      date ? `?date=${encodeURIComponent(date)}` : ''
    }`
  )

/** 写入 / 替换当前生效覆盖包（PUT 表达「替换」语义） */
export const putTaskOverrides = (doctorId, patientId, payload) =>
  request(`/doctors/${encodeURIComponent(doctorId)}/patients/${encodeURIComponent(patientId)}/task-overrides`, {
    method: 'PUT',
    body: payload,
  })

/** 撤销某任务域的覆盖（回落规则值） */
export const deleteTaskOverride = (doctorId, patientId, taskId) =>
  request(
    `/doctors/${encodeURIComponent(doctorId)}/patients/${encodeURIComponent(patientId)}/task-overrides/${encodeURIComponent(taskId)}`,
    { method: 'DELETE' }
  )

/** 新增医生建议（真落库） */
export const addDoctorNote = (doctorId, patientId, payload) =>
  request(`/doctors/${encodeURIComponent(doctorId)}/patients/${encodeURIComponent(patientId)}/notes`, {
    method: 'POST',
    body: payload,
  })

/** 患者端：读取医生建议 */
export const getPatientDoctorNotes = (patientId, { unreadOnly = false, limit = 20 } = {}) =>
  request(
    `/patients/${encodeURIComponent(patientId)}/doctor-notes?unread=${unreadOnly ? 1 : 0}&limit=${limit}`
  )

/** 患者端：标记建议已读 */
export const markDoctorNoteRead = (patientId, noteId) =>
  request(`/patients/${encodeURIComponent(patientId)}/doctor-notes/${encodeURIComponent(noteId)}/read`, {
    method: 'POST',
  })

/* ------------------------------------------------------------------ *
 * Step 11 · Phase 2 —— 任务调整申请（提案）审核
 * ------------------------------------------------------------------ */

/** 医生端：任务调整申请列表（pending | reviewed | all） */
export const getTaskProposals = (doctorId, { status = 'pending', patientId = null } = {}) =>
  request(
    `/doctors/${encodeURIComponent(doctorId)}/task-proposals?status=${encodeURIComponent(status)}${
      patientId ? `&patientId=${encodeURIComponent(patientId)}` : ''
    }`
  )

/**
 * 医生端：审结一条提案。
 * @param {{decision:'approve'|'modify'|'reject', overrides?:object, reason?:string}} payload
 *   · approve —— 用提案自身建议值生效
 *   · modify  —— 用 overrides 替换（仍走后端同一把尺子校验）
 *   · reject  —— 只驳回，患者端任务零变化（reason 必填）
 */
export const reviewTaskProposal = (doctorId, proposalId, payload) =>
  request(
    `/doctors/${encodeURIComponent(doctorId)}/task-proposals/${encodeURIComponent(proposalId)}/review`,
    { method: 'POST', body: payload }
  )

/** 覆盖链路错误码 → 医生可读的兜底文案（后端已给 message，此处仅作补充） */
export const OVERRIDE_ERROR_HINT = {
  E_TARGET_OUT_OF_RANGE: '目标值超出允许范围',
  E_TARGET_NOT_MULTIPLE_OF_500: '步数目标必须是 500 的整数倍',
  E_SLOTS_INVALID: '监测时段不合法（为空 / 含非法项 / 重复）',
  E_UNKNOWN_TASK_ID: '该任务不在可调整范围内',
  E_TASK_NOT_OVERRIDABLE: '该任务当前版本不支持调整',
  E_TASK_NOT_GENERATED_FOR_PATIENT: '该任务今日未为此患者生成',
  E_UNKNOWN_FIELD: '不允许调整该字段',
  E_THRESHOLD_FIELD_FORBIDDEN: '医学阈值不可被覆盖（仅规则引擎判定）',
  E_PRIMARY_TASK_DISABLE_FORBIDDEN: '当前版本不允许停用主诊断监测项',
  E_DISABLE_NOT_SUPPORTED_IN_V1: '当前版本不支持停用任务',
  E_BASIS_REQUIRED: '请填写调整依据（4–200 字）',
  E_OVERRIDES_EMPTY: '没有任何有效变更',
}
