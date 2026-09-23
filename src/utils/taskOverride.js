/**
 * 迈康 MyCare · 今日任务覆盖契约（Step 11 · Phase 1）
 * ===========================================================================
 * 定位：**Task Override JSON Contract v1 的唯一实现**，前端与后端共用
 *      （与 clinicalRules.js / dailyTasks.js / healthScore.js 同一模式）。
 *
 * 红线（Step 11 冻结）：
 *   1. 规则仍是今日任务的**唯一生成者**。覆盖层只能改「规则已经生成的任务」的**参数**，
 *      **不得新建规则不存在的任务域**（对未生成的任务提交覆盖 → 整包拒绝）。
 *      ⚠️ Step 12 的唯一松弛点：`addedTasks` 允许**启用 `ADDABLE_MONITOR_TASKS` 白名单内**
 *      的监测域（该域在规则库里**已经存在**，只是未被该患者的诊断派生）。
 *      白名单由代码写死为 `bp_monitor` / `bg_monitor` 两项，时段枚举取自 `DAILY_TASK_RULES`，
 *      且只能经**医生审结**写入 —— 「不得自造任务域」的实质未变。
 *   2. 医学阈值（140/90、7.0、7.8 等）与 clinicalRules 口径**不得被覆盖层触碰**。
 *      `steps.target` / `exercise.target` 是**行为目标**（走多少步 / 动多少分钟），
 *      不是医学阈值，允许覆盖；血压 / 血糖的**控制目标数值**（systolic_target 等）不允许。
 *   3. 第一版**整体不接受 `enabled: false`**（D4）：主诊断监测项 → E_PRIMARY_TASK_DISABLE_FORBIDDEN，
 *      其余 → E_DISABLE_NOT_SUPPORTED_IN_V1。`enabled: true` 视为 no-op。
 *   4. 校验是**原子**的：任一项非法 → 整包拒绝（宁可报错，不要静默忽略）。
 *   5. 前端与 AI 都**不能绕过**后端校验 —— 本文件只是同一把尺子，准入判定在后端。
 *
 * 落点（零 schema 变更）：
 *   · 生效覆盖包 → `prescriptions.target_goals`（JSON，kind='task_override_package'）
 *   · 步数目标   → `patient_targets.steps_target`（既有读取链路，**UPDATE 绝不 INSERT**）
 */

import {
  BP_SLOT_OPTIONS,
  GLUCOSE_MEASURE_TYPES,
  SLOT_LABEL_ZH,
  DAILY_TASK_RULES,
  applyOverridesToTasks,
} from './dailyTasks.js'

/* ------------------------------------------------------------------ *
 * 常量与判别字段
 * ------------------------------------------------------------------ */

export const OVERRIDE_CONTRACT_VERSION = 1

/** JSON 判别字段：区分「生效覆盖包」「待审提案」与「健康处方」（F-3） */
export const PACKAGE_KIND = Object.freeze({
  OVERRIDE: 'task_override_package',
  PROPOSAL: 'task_proposal',
})

/** 验收 / 排障用错误码（后端映射为 400 / 409） */
export const OVERRIDE_ERRORS = Object.freeze({
  E_UNKNOWN_TASK_ID: 'E_UNKNOWN_TASK_ID',
  E_TASK_NOT_OVERRIDABLE: 'E_TASK_NOT_OVERRIDABLE',
  E_TASK_NOT_GENERATED_FOR_PATIENT: 'E_TASK_NOT_GENERATED_FOR_PATIENT',
  E_UNKNOWN_FIELD: 'E_UNKNOWN_FIELD',
  E_THRESHOLD_FIELD_FORBIDDEN: 'E_THRESHOLD_FIELD_FORBIDDEN',
  E_TARGET_OUT_OF_RANGE: 'E_TARGET_OUT_OF_RANGE',
  E_TARGET_NOT_MULTIPLE_OF_500: 'E_TARGET_NOT_MULTIPLE_OF_500',
  E_SLOTS_INVALID: 'E_SLOTS_INVALID',
  E_PRIMARY_TASK_DISABLE_FORBIDDEN: 'E_PRIMARY_TASK_DISABLE_FORBIDDEN',
  E_DISABLE_NOT_SUPPORTED_IN_V1: 'E_DISABLE_NOT_SUPPORTED_IN_V1',
  E_BASIS_REQUIRED: 'E_BASIS_REQUIRED',
  E_CONTRACT_VERSION_UNSUPPORTED: 'E_CONTRACT_VERSION_UNSUPPORTED',
  E_OVERRIDES_EMPTY: 'E_OVERRIDES_EMPTY',
  E_INVALID_ARG: 'E_INVALID_ARG',
  // —— Step 12：医生「同意新增监测项」→ 启用规则库中已有的监测域 ——
  E_ADDED_TASKS_INVALID: 'E_ADDED_TASKS_INVALID',
  E_ADDED_TASK_UNKNOWN: 'E_ADDED_TASK_UNKNOWN',
  E_ADDED_TASK_DUPLICATE: 'E_ADDED_TASK_DUPLICATE',
  E_ADDED_TASK_SLOTS_INVALID: 'E_ADDED_TASK_SLOTS_INVALID',
  E_ADDED_TASK_ALREADY_GENERATED: 'E_ADDED_TASK_ALREADY_GENERATED',
})

/**
 * 第一版可覆盖的 taskId 白名单与其 field 契约。
 * 枚举来源必须与数据库 CHECK 严格对齐，**不得自造**（见 dailyTasks.js）。
 */
/** `enabled` 在所有可覆盖任务上都保留（结构稳定），第一版取值恒拒 false */
const ENABLED_FIELD = Object.freeze({ type: 'boolean', nullable: false })

export const TASK_OVERRIDE_CONTRACT = Object.freeze({
  steps: {
    fields: {
      target: { type: 'integer', range: [1000, 20000], multipleOf: 500, nullable: false },
      enabled: ENABLED_FIELD,
    },
  },
  exercise: {
    fields: {
      target: { type: 'integer', range: [5, 180], nullable: false },
      enabled: ENABLED_FIELD,
    },
  },
  bp_monitor: {
    fields: {
      slots: { type: 'slots', enum: BP_SLOT_OPTIONS.slice(), nullable: false },
      enabled: ENABLED_FIELD,
    },
    /** 监测类任务：target ≡ slots.length，频次由 slots 数量表达 */
    targetIsSlotCount: true,
  },
  bg_monitor: {
    fields: {
      slots: { type: 'slots', enum: GLUCOSE_MEASURE_TYPES.slice(), nullable: false },
      enabled: ENABLED_FIELD,
    },
    targetIsSlotCount: true,
  },
})

/**
 * Step 12 · 可「启用」的监测域白名单。
 * ------------------------------------------------------------------
 * 背景：患者说「我想每天测一下血糖」时，若该患者的血糖监测域**尚未被规则派生**
 * （规则只在**主诊断含糖尿病**时派生 `bg_monitor`），仅靠 `overrides` 无法表达
 * 「新增一个监测项」—— `E_TASK_NOT_GENERATED_FOR_PATIENT` 会把它拦下。
 *
 * 本白名单把「新增」收敛为**启用规则库中已经存在的监测域**：
 *   · 枚举值与时段只能取自 `DAILY_TASK_RULES`，**不得自造**（与数据库 CHECK 对齐）；
 *   · 只能经**医生审结**写入（唯一写库出口仍是 applyOverridePackage）；
 *   · 因此「不得新建规则不存在的任务域」这条红线**依然成立** ——
 *     能启用的只有下面这两个，`weight_record` / 低频项等仍不在列。
 */
export const ADDABLE_MONITOR_TASKS = Object.freeze({
  bp_monitor: {
    domain: 'blood_pressure',
    title: DAILY_TASK_RULES.bloodPressure.title,
    unit: DAILY_TASK_RULES.bloodPressure.unit,
    ruleId: 'DEMO-TASK-BP',
    slotsEnum: BP_SLOT_OPTIONS.slice(),
    defaultSlots: DAILY_TASK_RULES.bloodPressure.normalSlots.slice(),
  },
  bg_monitor: {
    domain: 'blood_glucose',
    title: DAILY_TASK_RULES.bloodGlucose.title,
    unit: DAILY_TASK_RULES.bloodGlucose.unit,
    ruleId: 'DEMO-TASK-BG',
    slotsEnum: GLUCOSE_MEASURE_TYPES.slice(),
    defaultSlots: DAILY_TASK_RULES.bloodGlucose.normalSlots.slice(),
  },
})

/** 可启用监测域的 taskId 列表（供前端与验收读取，避免各处硬编码） */
export const ADDABLE_TASK_IDS = Object.freeze(Object.keys(ADDABLE_MONITOR_TASKS))

/** 第一版明确不支持覆盖的 taskId（枚举内但语义不适合） */
export const NOT_OVERRIDABLE_TASK_IDS = Object.freeze([
  'weight_record', // target 恒 1，无有意义的覆盖维度
  'DEMO-LF-BP', // 单位「次/周」，与「次/日」语义不同
  'DEMO-LF-BG',
])

/** 所有 field 都会被拒绝的阈值类字段黑名单（白名单之外一律拒绝） */
export const THRESHOLD_FIELDS = Object.freeze([
  'systolic_target',
  'diastolic_target',
  'fasting_glucose_target',
  'hba1c_target',
  'bmi_target',
  'waist_target',
  'weight_change_target',
  'controlTarget',
  'demoThreshold',
  'threshold',
])

const BASIS_MIN = 4
const BASIS_MAX = 200
const SLOTS_MAX = 4

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

const includesAny = (list, keywords) =>
  (Array.isArray(list) ? list : []).some((d) => keywords.some((kw) => String(d).includes(kw)))

/** 某患者的主诊断监测项判定（由后端依据疾病谱推导，不由前端或 AI 声明） */
export function isPrimaryMonitorTask(taskId, ctx = {}) {
  const primary = String(ctx.primaryDisease || '')
  const diseases = Array.isArray(ctx.diseases) ? ctx.diseases : []
  const hit = (kw) => primary.includes(kw) || includesAny(diseases, [kw])
  if (taskId === 'bp_monitor') return hit('高血压')
  if (taskId === 'bg_monitor') return hit('糖尿病')
  if (taskId === 'weight_record') return hit('肥胖')
  return false
}

/**
 * 归一化 + 校验 `addedTasks`（医生审结「同意新增监测项」时写入的监测域）。
 *
 * 原子口径与 overrides 一致：任一项非法 → 收集错误，由调用方整包拒绝。
 * 允许省略 `slots`（取规则库的默认时段），但不允许写医学阈值。
 *
 * @param {any} raw                  payload.addedTasks
 * @param {{generated?: string[]|null}} ctx 当日已由规则派生的 taskId（用于拦截「无需新增」）
 * @returns {{ added: Array, errors: Array }}
 */
function normalizeAddedTasks(raw, { generated = null } = {}) {
  const errors = []
  if (raw === undefined || raw === null || raw === false) return { added: [], errors }
  if (!Array.isArray(raw)) {
    errors.push({
      taskId: null,
      field: 'addedTasks',
      code: OVERRIDE_ERRORS.E_ADDED_TASKS_INVALID,
      message: 'addedTasks 必须是数组',
    })
    return { added: [], errors }
  }

  const out = []
  const seen = new Set()

  for (const item of raw) {
    const it = isPlainObject(item) ? item : {}
    const taskId = typeof it.taskId === 'string' ? it.taskId.trim() : ''
    const spec = ADDABLE_MONITOR_TASKS[taskId]

    if (!spec) {
      errors.push({
        taskId: taskId || null,
        field: 'taskId',
        code: OVERRIDE_ERRORS.E_ADDED_TASK_UNKNOWN,
        message: `不可新增的监测项：${taskId || '(空)'}（可选：${ADDABLE_TASK_IDS.join(' / ')}）`,
      })
      continue
    }
    if (seen.has(taskId)) {
      errors.push({
        taskId,
        field: 'taskId',
        code: OVERRIDE_ERRORS.E_ADDED_TASK_DUPLICATE,
        message: `监测项重复出现：${taskId}`,
      })
      continue
    }
    seen.add(taskId)

    // 已由规则派生 → 不是「新增」，应改用 overrides 调 slots
    if (generated && generated.includes(taskId)) {
      errors.push({
        taskId,
        field: 'taskId',
        code: OVERRIDE_ERRORS.E_ADDED_TASK_ALREADY_GENERATED,
        message: `${taskId} 已由规则派生，无需新增（如需改频次请用 slots 覆盖）`,
      })
      continue
    }

    const slots = it.slots === undefined || it.slots === null ? spec.defaultSlots.slice() : it.slots
    if (
      !Array.isArray(slots) ||
      slots.length === 0 ||
      slots.length > SLOTS_MAX ||
      slots.some((s) => typeof s !== 'string' || !spec.slotsEnum.includes(s)) ||
      new Set(slots).size !== slots.length
    ) {
      errors.push({
        taskId,
        field: 'slots',
        code: OVERRIDE_ERRORS.E_ADDED_TASK_SLOTS_INVALID,
        message: `${taskId}.slots 非法（合法：${spec.slotsEnum.join('/')}，≤ ${SLOTS_MAX} 项且不重复）`,
      })
      continue
    }

    out.push({
      taskId,
      domain: spec.domain,
      title: spec.title,
      unit: spec.unit,
      ruleId: spec.ruleId,
      slots: slots.slice(),
    })
  }

  return { added: out, errors }
}

/**
 * 校验 + 归一化一个覆盖包请求（原子）。
 *
 * Step 12 起 `overrides` 允许为空 —— 只要 `addedTasks` 非空（医生只新增监测项、
 * 不改任何既有参数）。两者都空 → 仍是空包拒绝。
 *
 * @param {object} payload         { overrides, addedTasks?, basis, contractVersion? }
 * @param {object} ctx             { generatedTaskIds?: string[], primaryDisease?, diseases? }
 * @returns {{ ok:boolean, code:string|null, errors:Array, normalized:{overrides:object, basis:string}|null }}
 */
export function validateOverridePackage(payload = {}, ctx = {}) {
  const errors = []
  const push = (taskId, field, code, message) => errors.push({ taskId, field, code, message })

  if (payload.contractVersion !== undefined && payload.contractVersion !== OVERRIDE_CONTRACT_VERSION) {
    push(null, null, OVERRIDE_ERRORS.E_CONTRACT_VERSION_UNSUPPORTED, `不支持的契约版本：${payload.contractVersion}`)
    return { ok: false, code: OVERRIDE_ERRORS.E_CONTRACT_VERSION_UNSUPPORTED, errors, normalized: null }
  }

  const basis = String(payload.basis ?? '').trim()
  if (basis.length < BASIS_MIN) {
    push(null, 'basis', OVERRIDE_ERRORS.E_BASIS_REQUIRED, `调整依据必填（${BASIS_MIN}–${BASIS_MAX} 字）`)
  } else if (basis.length > BASIS_MAX) {
    push(null, 'basis', OVERRIDE_ERRORS.E_BASIS_REQUIRED, `调整依据过长（≤ ${BASIS_MAX} 字）`)
  }

  const generated = Array.isArray(ctx.generatedTaskIds) ? ctx.generatedTaskIds : null
  const normalized = {}

  /* —— 新增监测域（Step 12）：可与 overrides 并存，也可单独成包 —— */
  const addedRes = normalizeAddedTasks(payload.addedTasks, { generated })
  errors.push(...addedRes.errors)
  const addedTasks = addedRes.added

  const raw = payload.overrides
  const hasOverrides = isPlainObject(raw) && Object.keys(raw).length > 0
  if (!hasOverrides && addedTasks.length === 0) {
    push(
      null,
      'overrides',
      OVERRIDE_ERRORS.E_OVERRIDES_EMPTY,
      'overrides 必须是非空对象（或提供 addedTasks 新增监测域）'
    )
    return { ok: false, code: errors[0].code, errors, normalized: null }
  }

  for (const [taskId, fields] of Object.entries(hasOverrides ? raw : {})) {
    const contract = TASK_OVERRIDE_CONTRACT[taskId]

    // —— taskId 判定 ——
    if (!contract) {
      const code = NOT_OVERRIDABLE_TASK_IDS.includes(taskId)
        ? OVERRIDE_ERRORS.E_TASK_NOT_OVERRIDABLE
        : OVERRIDE_ERRORS.E_UNKNOWN_TASK_ID
      push(taskId, null, code, `不支持覆盖的任务：${taskId}`)
      continue
    }
    // —— 必须是该患者当日规则实际生成的任务 ——
    if (generated && !generated.includes(taskId)) {
      push(taskId, null, OVERRIDE_ERRORS.E_TASK_NOT_GENERATED_FOR_PATIENT, `该患者当日未生成任务：${taskId}`)
      continue
    }

    if (!isPlainObject(fields)) {
      push(taskId, null, OVERRIDE_ERRORS.E_INVALID_ARG, `${taskId} 的值必须是对象`)
      continue
    }

    const out = {}
    for (const [field, value] of Object.entries(fields)) {
      // —— 阈值类字段（含一切白名单之外的字段名）——
      if (!Object.prototype.hasOwnProperty.call(contract.fields, field)) {
        const code = THRESHOLD_FIELDS.includes(field)
          ? OVERRIDE_ERRORS.E_THRESHOLD_FIELD_FORBIDDEN
          : OVERRIDE_ERRORS.E_UNKNOWN_FIELD
        push(taskId, field, code, `不允许覆盖的字段：${taskId}.${field}`)
        continue
      }

      const spec = contract.fields[field]

      // —— enabled 的第一版口径（结构保留，取值恒拒 false）——
      if (field === 'enabled') {
        if (value === true) continue // no-op
        const code = isPrimaryMonitorTask(taskId, ctx)
          ? OVERRIDE_ERRORS.E_PRIMARY_TASK_DISABLE_FORBIDDEN
          : OVERRIDE_ERRORS.E_DISABLE_NOT_SUPPORTED_IN_V1
        push(taskId, field, code, `当前版本不允许停用任务：${taskId}`)
        continue
      }

      if (spec.type === 'integer') {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          push(taskId, field, OVERRIDE_ERRORS.E_TARGET_OUT_OF_RANGE, `${taskId}.${field} 必须是整数`)
          continue
        }
        const [lo, hi] = spec.range
        if (value < lo || value > hi) {
          push(taskId, field, OVERRIDE_ERRORS.E_TARGET_OUT_OF_RANGE, `${taskId}.${field} 需在 ${lo}–${hi} 之间`)
          continue
        }
        if (spec.multipleOf && value % spec.multipleOf !== 0) {
          push(
            taskId,
            field,
            OVERRIDE_ERRORS.E_TARGET_NOT_MULTIPLE_OF_500,
            `${taskId}.${field} 必须是 ${spec.multipleOf} 的整数倍`
          )
          continue
        }
        out[field] = value
        continue
      }

      if (spec.type === 'slots') {
        if (!Array.isArray(value) || value.length === 0 || value.length > SLOTS_MAX) {
          push(taskId, field, OVERRIDE_ERRORS.E_SLOTS_INVALID, `${taskId}.slots 必须是非空数组（≤ ${SLOTS_MAX} 项）`)
          continue
        }
        if (
          value.some((s) => typeof s !== 'string' || !spec.enum.includes(s)) ||
          new Set(value).size !== value.length
        ) {
          push(taskId, field, OVERRIDE_ERRORS.E_SLOTS_INVALID, `${taskId}.slots 含非法或重复项（合法：${spec.enum.join('/')}）`)
          continue
        }
        out[field] = value.slice()
        continue
      }

      push(taskId, field, OVERRIDE_ERRORS.E_UNKNOWN_FIELD, `未支持的字段类型：${field}`)
    }

    if (Object.keys(out).length) normalized[taskId] = out
  }

  if (errors.length) {
    return { ok: false, code: errors[0].code, errors, normalized: null }
  }
  if (Object.keys(normalized).length === 0 && addedTasks.length === 0) {
    // 全部字段都是 no-op（如只传 enabled:true）—— 视为空包，拒绝，避免产生空版本
    push(null, null, OVERRIDE_ERRORS.E_OVERRIDES_EMPTY, '覆盖包未包含任何有效变更')
    return { ok: false, code: OVERRIDE_ERRORS.E_OVERRIDES_EMPTY, errors, normalized: null }
  }
  return { ok: true, code: null, errors: [], normalized: { overrides: normalized, addedTasks, basis } }
}

/* ------------------------------------------------------------------ *
 * 读取 / 归一化（供服务层与前端共用）
 * ------------------------------------------------------------------ */

/** 从 prescriptions.target_goals 解析出的覆盖包 → 归一化结构（非法则返回 null） */
export function readEffectiveOverrides(pkgJson) {
  const pkg = typeof pkgJson === 'string' ? safeParse(pkgJson) : pkgJson
  if (!isPlainObject(pkg)) return null
  if (pkg.kind !== PACKAGE_KIND.OVERRIDE) return null
  if (pkg.contractVersion !== OVERRIDE_CONTRACT_VERSION) return null
  if (!isPlainObject(pkg.overrides) && !Array.isArray(pkg.addedTasks)) return null
  return {
    prescriptionId: pkg.prescriptionId ?? null,
    overrides: isPlainObject(pkg.overrides) ? pkg.overrides : {},
    /** Step 12：医生审结新增的监测域（空数组 = 无新增） */
    addedTasks: Array.isArray(pkg.addedTasks) ? pkg.addedTasks : [],
    basis: pkg.basis ?? null,
    origin: pkg.origin ?? null,
    reviewedBy: pkg.reviewedBy ?? null,
    reviewedAt: pkg.reviewedAt ?? null,
    createdAt: pkg.createdAt ?? null,
    supersedes: pkg.supersedes ?? null,
    previousStepsTarget: pkg.previousStepsTarget ?? null,
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 覆盖包的调试展示文案（仅供 UI 说明用） */
export function describeOverride(overrides = {}) {
  const parts = []
  for (const [taskId, fields] of Object.entries(overrides)) {
    if (fields.target !== undefined) parts.push(`${taskId} → ${fields.target}`)
    if (fields.slots !== undefined) parts.push(`${taskId} → ${fields.slots.map((s) => SLOT_LABEL_ZH[s] || s).join('/')}`)
  }
  return parts.join('，')
}

export { SLOT_LABEL_ZH, applyOverridesToTasks as applyTaskOverrides }
