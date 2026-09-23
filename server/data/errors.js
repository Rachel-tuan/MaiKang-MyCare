/**
 * 迈康 MyCare · dataProvider 统一错误模型
 * ---------------------------------------------------------------------------
 * 依据：docs/Step0.1_取数契约冻结_v0.1.md §2
 * 所有 dataProvider 抛出的错误都是 DataProviderError 实例。
 *
 * 口径铁律：**「查无数据」不是错误**
 *   · getSeries            → points: [] / count: 0 / empty: true / stats: null
 *   · getDailySnapshot     → exists: false
 *   · getPatientProfile    → latestMeasurements: null / 关联子表为空数组
 * 只有「入参非法 / 患者不存在 / 指标未注册 / 来源未建 / 数据库不可用」才抛错。
 */

export const ERROR_CODES = Object.freeze({
  E_INVALID_ARG: 'E_INVALID_ARG', // 400 入参缺失/非法（含 source ∉ available_sources、source 表未建）
  E_PATIENT_NOT_FOUND: 'E_PATIENT_NOT_FOUND', // 404 patients 无该 patient_id
  E_UNKNOWN_METRIC: 'E_UNKNOWN_METRIC', // 400 metricKey 未在 metric_definitions 注册
  E_DB_UNAVAILABLE: 'E_DB_UNAVAILABLE', // 503 SQLite 打开/查询失败
  E_INTERNAL: 'E_INTERNAL', // 500 其它未预期错误
  // 账号（注册 / 登录）——身份层，仍复用同一错误模型
  E_USERNAME_TAKEN: 'E_USERNAME_TAKEN', // 409 username 已被占用（patients.username 唯一）
  E_PASSWORD_REQUIRED: 'E_PASSWORD_REQUIRED', // 401 该账号已设置密码，必须携带密码登录
  E_PASSWORD_MISMATCH: 'E_PASSWORD_MISMATCH', // 401 密码错误
  E_PHONE_MISMATCH: 'E_PHONE_MISMATCH', // 403 找回密码时手机号与档案不一致
  // 测量录入（Step 9）——事实层写入的生理合理性校验
  E_BP_INVERTED: 'E_BP_INVERTED', // 400 收缩压 ≤ 舒张压（生理不可能，拒收）
  // 今日任务覆盖（Step 11 · Phase 1）——覆盖层校验，整包原子拒绝
  E_UNKNOWN_TASK_ID: 'E_UNKNOWN_TASK_ID', // 400 taskId 不在可覆盖枚举内
  E_TASK_NOT_OVERRIDABLE: 'E_TASK_NOT_OVERRIDABLE', // 400 枚举内但第一版不支持覆盖
  E_TASK_NOT_GENERATED_FOR_PATIENT: 'E_TASK_NOT_GENERATED_FOR_PATIENT', // 400 该患者当日规则未生成此任务
  E_UNKNOWN_FIELD: 'E_UNKNOWN_FIELD', // 400 field 不在白名单
  E_THRESHOLD_FIELD_FORBIDDEN: 'E_THRESHOLD_FIELD_FORBIDDEN', // 400 试图覆盖医学阈值
  E_TARGET_OUT_OF_RANGE: 'E_TARGET_OUT_OF_RANGE', // 400 数值越界
  E_TARGET_NOT_MULTIPLE_OF_500: 'E_TARGET_NOT_MULTIPLE_OF_500', // 400 步数非 500 倍数
  E_SLOTS_INVALID: 'E_SLOTS_INVALID', // 400 slots 空 / 含非法枚举 / 重复
  E_PRIMARY_TASK_DISABLE_FORBIDDEN: 'E_PRIMARY_TASK_DISABLE_FORBIDDEN', // 400 停用主诊断监测项（D4）
  E_DISABLE_NOT_SUPPORTED_IN_V1: 'E_DISABLE_NOT_SUPPORTED_IN_V1', // 400 第一版不支持停用任务
  E_BASIS_REQUIRED: 'E_BASIS_REQUIRED', // 400 basis 缺失或过短
  E_OVERRIDES_EMPTY: 'E_OVERRIDES_EMPTY', // 400 覆盖包未包含任何有效变更
  E_CONTRACT_VERSION_UNSUPPORTED: 'E_CONTRACT_VERSION_UNSUPPORTED', // 409 契约版本未知
  // 任务提案（Step 11 · Phase 2）—— 提案生命周期
  E_PROPOSAL_NOT_FOUND: 'E_PROPOSAL_NOT_FOUND', // 404 提案不存在 / 不是提案行
  E_PROPOSAL_ALREADY_REVIEWED: 'E_PROPOSAL_ALREADY_REVIEWED', // 409 提案已审结（approve/reject 过）
  E_PROPOSAL_EXPIRED: 'E_PROPOSAL_EXPIRED', // 409 提案已过 7 天（懒判定）
})

/** 业务 code → HTTP 状态映射 */
export const HTTP_STATUS_BY_CODE = Object.freeze({
  E_INVALID_ARG: 400,
  E_PATIENT_NOT_FOUND: 404,
  E_UNKNOWN_METRIC: 400,
  E_DB_UNAVAILABLE: 503,
  E_INTERNAL: 500,
  E_USERNAME_TAKEN: 409,
  E_PASSWORD_REQUIRED: 401,
  E_PASSWORD_MISMATCH: 401,
  E_PHONE_MISMATCH: 403,
  E_BP_INVERTED: 400,
  // Step 11 覆盖层
  E_UNKNOWN_TASK_ID: 400,
  E_TASK_NOT_OVERRIDABLE: 400,
  E_TASK_NOT_GENERATED_FOR_PATIENT: 400,
  E_UNKNOWN_FIELD: 400,
  E_THRESHOLD_FIELD_FORBIDDEN: 400,
  E_TARGET_OUT_OF_RANGE: 400,
  E_TARGET_NOT_MULTIPLE_OF_500: 400,
  E_SLOTS_INVALID: 400,
  E_PRIMARY_TASK_DISABLE_FORBIDDEN: 400,
  E_DISABLE_NOT_SUPPORTED_IN_V1: 400,
  E_BASIS_REQUIRED: 400,
  E_OVERRIDES_EMPTY: 400,
  E_CONTRACT_VERSION_UNSUPPORTED: 409,
  // Step 11 提案层
  E_PROPOSAL_NOT_FOUND: 404,
  E_PROPOSAL_ALREADY_REVIEWED: 409,
  E_PROPOSAL_EXPIRED: 409,
})

export class DataProviderError extends Error {
  /**
   * @param {string} code   ERROR_CODES 之一
   * @param {string} message 人读信息
   * @param {object|null} detail 出错时被查询的 patientId / metricKey / source / reason 等
   */
  constructor(code, message, detail = null) {
    super(message)
    this.name = 'DataProviderError'
    this.code = code
    this.detail = detail
  }

  /** 便于 res.status(err.httpStatus).json(err.toJSON()) */
  get httpStatus() {
    return HTTP_STATUS_BY_CODE[this.code] ?? 500
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, detail: this.detail }
  }
}

/** 断言辅助：把任意异常规整为 DataProviderError */
export function asDataProviderError(err, fallbackCode = ERROR_CODES.E_INTERNAL, detail = null) {
  if (err instanceof DataProviderError) return err
  return new DataProviderError(fallbackCode, err?.message || String(err), detail)
}
