/**
 * 迈康 MyCare · 确定性「今日任务」生成器（Step 9）
 * ===========================================================================
 * 定位：**唯一**的今日任务生成实现，前端与后端共用（与 clinicalRules.js 同一模式）。
 *
 * 红线（Step 9 冻结）：
 *   1. 任务与频次由**确定性规则**决定 —— 大模型只负责解释与措辞，**不得修改次数、不得创造阈值**。
 *   2. 任务进度**不落库**：由当日有效 readings / medication_logs 实时派生。
 *   3. 一次测量 = 一条 readings 事实记录；任务与测量严格分离，通过 (patient_id, 日期) 关联。
 *   4. 本文件内的频次表是**本项目 Demo 规则**，不是医学处方，不可对外表述为临床指南。
 *
 * 输入口径：
 *   · 疾病判定用「关键字包含匹配」（复用 disease.js 的思路，病名可能带分级前缀）
 *   · "异常升频"只**消费** clinicalRules 的既有 level，不重算任何阈值
 */

/* ------------------------------------------------------------------ *
 * 词表与映射
 * ------------------------------------------------------------------ */

/** 血压测量时段（严格对齐 blood_pressure_readings.slot 的 CHECK 枚举） */
export const BP_SLOT_OPTIONS = ['晨起', '上午', '下午', '睡前']

/**
 * 时段展示映射：**UI 显示「午后」，数据库落库「下午」**。
 * 落库值必须是 '下午'（CHECK 枚举），展示才用 '午后'。只在此处定义，禁止各处自行拼字。
 */
export const SLOT_LABEL_ZH = Object.freeze({
  晨起: '晨起',
  上午: '上午',
  下午: '午后',
  睡前: '睡前',
})

/** 血糖测量类型（严格对齐 blood_glucose_readings.measure_type 的 CHECK 枚举） */
export const GLUCOSE_MEASURE_TYPES = ['空腹', '餐后2h', '随机', '睡前']

/** 时段 → 小时区间（用于没填 slot 时按 measured_at 反推时段，仅用于展示归属） */
const SLOT_HOUR_RANGE = {
  晨起: [0, 9],
  上午: [9, 12],
  下午: [12, 18],
  睡前: [18, 24],
}

/** 产品预警等级顺序（与 clinicalRules.ALERT_LEVEL 一致，此处只读不改） */
const LEVEL_ORDER = { info: 1, watch: 2, alert: 3, emergency: 4 }
const LEVEL_LABEL = { info: '提示', watch: '关注', alert: '预警', emergency: '紧急' }

/** 任务域 → clinicalRules 的规则分组（用于读取该域的既有等级） */
const DOMAIN_GROUP = {
  blood_pressure: 'bloodPressure',
  blood_glucose: 'bloodSugar',
  weight: 'weightBehavior',
}

/* ------------------------------------------------------------------ *
 * 频次表（本项目 Demo 规则 · 非医学处方）
 * ------------------------------------------------------------------ */
export const DAILY_TASK_RULES = Object.freeze({
  disclaimer: '本项目 Demo 规则，非医学处方；AI 不得修改。',

  bloodPressure: {
    taskId: 'bp_monitor',
    domain: 'blood_pressure',
    title: '血压监测',
    unit: '次',
    normalSlots: ['晨起', '睡前'],
    elevatedSlots: ['晨起', '下午', '睡前'],
  },
  bloodGlucose: {
    taskId: 'bg_monitor',
    domain: 'blood_glucose',
    title: '血糖监测',
    unit: '次',
    normalSlots: ['空腹', '餐后2h'],
    elevatedSlots: ['空腹', '餐后2h', '睡前'],
  },
  weight: { taskId: 'weight_record', domain: 'weight', title: '体重记录', unit: '次', count: 1 },

  /**
   * 合并症低频关注项：**只在对应主任务未以全频次生成时**附加。
   * 例：王建军主诊断为肥胖症 → 主任务走体重管理；其合并症「代谢综合征 / 空腹血糖受损」
   *     生成每周 1–2 次的低频关注，而不是糖尿病级的每日 2–3 次。
   */
  lowFrequency: {
    空腹血糖受损: {
      ruleId: 'DEMO-LF-BG',
      domain: 'blood_glucose',
      title: '血糖关注（低频）',
      perWeek: 1,
      unit: '次/周',
    },
    代谢综合征: {
      ruleId: 'DEMO-LF-BP',
      domain: 'blood_pressure',
      title: '血压关注（低频）',
      perWeek: 2,
      unit: '次/周',
    },
  },

  exercise: { taskId: 'exercise', domain: 'exercise', title: '运动打卡', unit: '分钟', target: 30 },
  steps: { taskId: 'steps', domain: 'steps', title: '步数目标', unit: '步', fallbackTarget: 8000 },
})

/** 任务来源恒定标记：确定性规则产出（AI 无权改写） */
export const TASK_SOURCE = 'rule'

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
const listOf = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : [])

const includesKeyword = (diseases = [], keyword) =>
  listOf(diseases).some((d) => String(d).includes(keyword))

/** 从 measured_at 反推时段（仅用于展示归属；落库仍以用户选择的 slot 为准） */
export function inferSlotFromTime(measuredAt) {
  const m = /T?(\d{2}):/.exec(String(measuredAt || ''))
  if (!m) return null
  const hour = Number(m[1])
  for (const [slot, [from, to]] of Object.entries(SLOT_HOUR_RANGE)) {
    if (hour >= from && hour < to) return slot
  }
  return null
}

/** 某条血压读数的时段：显式 slot 优先，缺失则按时间反推 */
export const resolveBpSlot = (reading = {}) => {
  const s = reading.slot
  if (s && BP_SLOT_OPTIONS.includes(s)) return s
  return inferSlotFromTime(reading.measuredAt)
}

/** 读取某任务域在 clinicalRules 既有结论中的最高等级（只读，不重算阈值） */
export function highestLevelOfDomain(evaluation = {}, domain) {
  const group = DOMAIN_GROUP[domain]
  if (!group) return 'info'
  const matched = Array.isArray(evaluation?.matched) ? evaluation.matched : []
  return matched
    .filter((r) => r.group === group)
    .reduce((top, r) => ((LEVEL_ORDER[r.level] || 0) > (LEVEL_ORDER[top] || 0) ? r.level : top), 'info')
}

/** 是否属于"近期状态异常"（按 Step 9 口径：该域达到 预警 / 紧急） */
export const isElevatedLevel = (level) => level === 'alert' || level === 'emergency'

/** 把 medications.time 的自由文本拆成多个时段：'08:00/18:00' → ['08:00','18:00'] */
export function splitMedicationTimes(time) {
  return String(time || '')
    .split(/[\/、,，;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{1,2}:\d{2}$/.test(s))
    .map((s) => s.padStart(5, '0'))
}

const cap = (n, target) => Math.max(0, Math.min(Number(n) || 0, Number(target) || 0))

/* ------------------------------------------------------------------ *
 * 覆盖层应用（Step 11 · Phase 1）
 * ------------------------------------------------------------------ */
/**
 * 把**已校验**的覆盖包套用到规则产出的任务数组上（纯函数）。
 *
 * 边界（Step 11 冻结）：
 *   · 只改 `target` / `slots` 两个字段；**绝不新增 / 删除任务域**，`source` 恒为 'rule'。
 *   · 覆盖的 taskId 必须在传入的 tasks 中已存在（规则已生成），否则静默跳过
 *     —— 合法性判定在 `taskOverride.validateOverridePackage()`，此处只做机械应用。
 *   · 进度：slots 型任务按「新 slots 中已完成数」重算 `done`；target 型任务按
 *     `cap(actualCount, target)` 重算。`actualCount`（真实值）永不改写。
 *   · 每个被覆盖的任务挂 `override` 回显子对象，供界面标注「医生已调整」与依据。
 *
 * @param {Array}  tasks     规则产出的任务数组
 * @param {object} overrides 已校验的覆盖映射 { [taskId]: { target?|slots? } }
 * @param {object} meta      审计信息 { by, at, basis }
 */
export function applyOverridesToTasks(tasks = [], overrides = {}, meta = {}) {
  if (!overrides || !Object.keys(overrides).length) return tasks
  const base = {
    applied: true,
    by: meta.by ?? null,
    at: meta.at ?? null,
    basis: meta.basis ?? null,
  }

  return tasks.map((task) => {
    const ov = overrides[task.taskId]
    if (!ov) return task

    const next = { ...task }
    const fields = []

    if (Array.isArray(ov.slots)) {
      const prev = new Map((task.slots || []).map((s) => [s.slot, s]))
      next.slots = ov.slots.map((slot) => {
        const hit = prev.get(slot)
        return hit
          ? { ...hit, label: SLOT_LABEL_ZH[slot] || hit.label || slot }
          : { slot, label: SLOT_LABEL_ZH[slot] || slot, done: false, latest: null, readingId: null }
      })
      next.target = next.slots.length
      fields.push('slots', 'target')
      next.done = Math.min(next.slots.filter((s) => s.done).length, next.target)
    }

    if (Number.isInteger(ov.target)) {
      next.target = ov.target
      fields.push('target')
    }

    if (!Array.isArray(ov.slots)) {
      next.done = cap(next.actualCount, next.target)
    }

    next.override = { ...base, fields: Array.from(new Set(fields)) }
    return next
  })
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */
/**
 * 生成某患者某日的「今日任务」（派生视图，不落库）。
 *
 * @param {object}   p
 * @param {string}   p.date            生成日期 YYYY-MM-DD
 * @param {string[]} p.diseases        疾病谱（主诊断在前）
 * @param {string}   p.primaryDisease  主诊断病名（决定"主任务"）
 * @param {object}   p.evaluation      clinicalRules 的既有输出（只读）
 * @param {Array}    p.bpReadings      当日**有效**血压明细 [{ readingId, systolic, diastolic, slot, measuredAt }]
 * @param {Array}    p.bgReadings      当日**有效**血糖明细 [{ readingId, value, measureType, measuredAt }]
 * @param {Array}    p.medications     有效用药计划 [{ medicationId, name, dosage, time, times? }]
 * @param {Array}    p.medicationLogs  当日**有效**服药打卡 [{ medicationId, plannedTime }]
 * @param {object}   p.weeklyCounts    近 7 天各域有效测量次数 { blood_pressure, blood_glucose }（低频关注项进度用）
 * @param {object}   p.targets         个体化目标 { steps }
 * @param {object}   p.activity        当日行为 { steps, exerciseMinutes, weight }
 * @param {object}   p.taskOverrides   **已校验**的医生覆盖包（Step 11；只改参数，不增删任务域）
 * @param {object}   p.overrideMeta    覆盖包审计信息 { by, at, basis }
 * @param {Array}    p.addedTasks      **已校验**的「医生审结新增监测域」清单（Step 12；可为空）。
 *                                     白名单与时段枚举由 taskOverride.js 裁定，此处只做机械生成。
 * @returns {{ generatedFor: string, source: string, disclaimer: string, tasks: Array }}
 */
export function buildDailyTasks({
  date,
  diseases = [],
  primaryDisease = null,
  evaluation = {},
  bpReadings = [],
  bgReadings = [],
  medications = [],
  medicationLogs = [],
  weeklyCounts = {},
  targets = {},
  activity = {},
  taskOverrides = {},
  overrideMeta = {},
  addedTasks = [],
} = {}) {
  const tasks = []
  const list = listOf(diseases)
  const primary = String(primaryDisease || '')

  const hasAnyChronic = ['高血压', '糖尿病', '肥胖'].some((kw) => includesKeyword(list, kw))

  /* ---------------- 1. 主任务：血压监测（主诊断 = 高血压） ---------------- */
  const bpRule = DAILY_TASK_RULES.bloodPressure
  if (primary.includes('高血压')) {
    const level = highestLevelOfDomain(evaluation, bpRule.domain)
    const elevated = isElevatedLevel(level)
    const slots = elevated ? bpRule.elevatedSlots : bpRule.normalSlots
    const valid = Array.isArray(bpReadings) ? bpReadings : []

    tasks.push({
      taskId: bpRule.taskId,
      domain: bpRule.domain,
      title: bpRule.title,
      target: slots.length,
      unit: bpRule.unit,
      done: cap(valid.length, slots.length),
      actualCount: valid.length,
      level,
      ruleId: 'DEMO-TASK-BP',
      source: TASK_SOURCE,
      reason: elevated
        ? `主诊断高血压；近期血压域达「${LEVEL_LABEL[level]}」→ 每日 ${slots.length} 次`
        : `主诊断高血压 → 每日 ${slots.length} 次`,
      slots: slots.map((slot) => {
        const hit = valid.find((r) => resolveBpSlot(r) === slot)
        return {
          slot,
          label: SLOT_LABEL_ZH[slot] || slot,
          done: Boolean(hit),
          latest: hit ? `${hit.systolic ?? '-'}/${hit.diastolic ?? '-'} mmHg` : null,
          readingId: hit?.readingId ?? null,
        }
      }),
    })
  }

  /* ---------------- 2. 主任务：血糖监测（主诊断 = 糖尿病） ---------------- */
  const bgRule = DAILY_TASK_RULES.bloodGlucose
  if (primary.includes('糖尿病')) {
    const level = highestLevelOfDomain(evaluation, bgRule.domain)
    const elevated = isElevatedLevel(level)
    const types = elevated ? bgRule.elevatedSlots : bgRule.normalSlots
    const valid = Array.isArray(bgReadings) ? bgReadings : []

    tasks.push({
      taskId: bgRule.taskId,
      domain: bgRule.domain,
      title: bgRule.title,
      target: types.length,
      unit: bgRule.unit,
      done: cap(valid.length, types.length),
      actualCount: valid.length,
      level,
      ruleId: 'DEMO-TASK-BG',
      source: TASK_SOURCE,
      reason: elevated
        ? `主诊断糖尿病；近期血糖域达「${LEVEL_LABEL[level]}」→ 每日 ${types.length} 次`
        : `主诊断糖尿病 → 每日 ${types.length} 次`,
      slots: types.map((type) => {
        const hit = valid.find((r) => r.measureType === type)
        return {
          slot: type,
          label: type,
          done: Boolean(hit),
          latest: hit ? `${hit.value} mmol/L` : null,
          readingId: hit?.readingId ?? null,
        }
      }),
    })
  }

  /* ---------------- 3. 主任务：体重记录（主诊断 = 肥胖症） ---------------- */
  const wtRule = DAILY_TASK_RULES.weight
  if (primary.includes('肥胖')) {
    const level = highestLevelOfDomain(evaluation, wtRule.domain)
    const hasWeight = activity?.weight !== null && activity?.weight !== undefined
    tasks.push({
      taskId: wtRule.taskId,
      domain: wtRule.domain,
      title: wtRule.title,
      target: wtRule.count,
      unit: wtRule.unit,
      done: hasWeight ? 1 : 0,
      actualCount: hasWeight ? 1 : 0,
      level,
      ruleId: 'DEMO-TASK-WT',
      source: TASK_SOURCE,
      reason: '主诊断肥胖症 → 每日 1 次体重记录',
      slots: [{ slot: null, label: '今日体重', done: hasWeight, latest: hasWeight ? `${activity.weight} kg` : null }],
    })
  }

  /* ---------------- 4. 合并症低频关注项 ---------------- */
  for (const [condition, cfg] of Object.entries(DAILY_TASK_RULES.lowFrequency)) {
    if (!includesKeyword(list, condition)) continue
    // 对应域已由主任务全频次覆盖时，不再叠加低频项
    if (cfg.domain === bpRule.domain && primary.includes('高血压')) continue
    if (cfg.domain === bgRule.domain && primary.includes('糖尿病')) continue

    const weeklyDone = Number(weeklyCounts?.[cfg.domain]) || 0
    tasks.push({
      taskId: cfg.ruleId,
      domain: cfg.domain,
      title: cfg.title,
      target: cfg.perWeek,
      unit: cfg.unit,
      done: cap(weeklyDone, cfg.perWeek),
      actualCount: weeklyDone,
      level: 'info',
      ruleId: cfg.ruleId,
      source: TASK_SOURCE,
      weekly: true,
      lowFrequency: true,
      reason: `合并症「${condition}」→ 本项目 Demo 规则：每周 ${cfg.perWeek} 次低频关注（非固定医学处方）`,
      slots: [],
    })
  }

  /* ---------------- 5. 服药任务：一药多时段 → 拆成多个计划实例 ---------------- */
  for (const med of listOf(medications)) {
    const times =
      Array.isArray(med.times) && med.times.length ? med.times : splitMedicationTimes(med.time)
    for (const t of times) {
      const hit = (medicationLogs || []).find(
        (l) => l.medicationId === med.medicationId && String(l.plannedTime || '').slice(11, 16) === t
      )
      tasks.push({
        taskId: `med_${med.medicationId}_${t.replace(':', '')}`,
        domain: 'medication',
        title: `服药：${med.name}${med.dosage ? ` ${med.dosage}` : ''}`,
        target: 1,
        unit: '次',
        done: hit ? 1 : 0,
        actualCount: hit ? 1 : 0,
        level: 'info',
        ruleId: 'DEMO-TASK-MED',
        source: TASK_SOURCE,
        medicationId: med.medicationId,
        plannedTime: t,
        reason: `用药计划时段 ${t}`,
        slots: [{ slot: t, label: t, done: Boolean(hit), latest: hit ? '已服' : null }],
      })
    }
  }

  /* ---------------- 6. 通用任务：运动打卡 / 步数目标 ---------------- */
  if (hasAnyChronic) {
    const exRule = DAILY_TASK_RULES.exercise
    const mins = Number(activity?.exerciseMinutes) || 0
    tasks.push({
      taskId: exRule.taskId,
      domain: exRule.domain,
      title: exRule.title,
      target: exRule.target,
      unit: exRule.unit,
      done: cap(mins, exRule.target),
      actualCount: mins,
      level: 'info',
      ruleId: 'DEMO-TASK-EX',
      source: TASK_SOURCE,
      reason: `慢病管理 → 每日运动 ${exRule.target} 分钟`,
      slots: [],
    })
  }

  const stRule = DAILY_TASK_RULES.steps
  const stepsTarget = Number(targets?.steps ?? targets?.steps_target) || stRule.fallbackTarget
  const steps = Number(activity?.steps) || 0
  tasks.push({
    taskId: stRule.taskId,
    domain: stRule.domain,
    title: stRule.title,
    target: stepsTarget,
    unit: stRule.unit,
    done: cap(steps, stepsTarget),
    actualCount: steps,
    level: 'info',
    ruleId: 'DEMO-TASK-STEPS',
    source: TASK_SOURCE,
    reason: `个体化目标 ${(Number(stepsTarget) || 0).toLocaleString('zh-CN')} 步`,
    slots: [],
  })

  /* ---------------- 7. 医生审结「同意新增监测项」→ 启用既有监测域（Step 12） ---------------- */
  // 背景：规则只在**主诊断**为高血压 / 糖尿病时派生对应监测任务。患者说「我想每天测血糖」
  // 时若该域尚未派生，仅靠参数覆盖无法表达「新增」—— 该提案经**医生审结同意**后，
  // 由这里启用规则库中**已经存在**的监测域（白名单在 taskOverride.js，字段在此只做机械展开）。
  // 幂等：该 taskId 已由规则派生或已补过 → 跳过，绝不产生重复任务。
  for (const item of listOf(addedTasks)) {
    const taskId = item?.taskId
    if (!taskId || tasks.some((t) => t.taskId === taskId)) continue

    const slots = Array.isArray(item.slots) ? item.slots.filter(Boolean) : []
    if (!slots.length) continue

    const isBg = item.domain === bgRule.domain
    const valid = isBg ? listOf(bgReadings) : listOf(bpReadings)
    const hitOf = isBg
      ? (slot) => valid.find((r) => r.measureType === slot)
      : (slot) => valid.find((r) => resolveBpSlot(r) === slot)

    tasks.push({
      taskId,
      domain: item.domain,
      title: item.title || taskId,
      target: slots.length,
      unit: item.unit || '次',
      done: cap(slots.filter((s) => hitOf(s)).length, slots.length),
      actualCount: valid.length,
      level: highestLevelOfDomain(evaluation, item.domain),
      ruleId: item.ruleId || 'DEMO-TASK-ADDED',
      source: TASK_SOURCE,
      // 来源标记：**医生审结新增**，与「诊断派生」区分，供界面标注与验收断言
      addedByDoctor: true,
      reason: `医生审结同意新增「${item.title || taskId}」日常监测 → 每日 ${slots.length} 次`,
      slots: slots.map((slot) => {
        const hit = hitOf(slot)
        return {
          slot,
          label: isBg ? slot : SLOT_LABEL_ZH[slot] || slot,
          done: Boolean(hit),
          latest: hit
            ? isBg
              ? `${hit.value} mmol/L`
              : `${hit.systolic ?? '-'}/${hit.diastolic ?? '-'} mmHg`
            : null,
          readingId: hit?.readingId ?? null,
        }
      }),
    })
  }

  // —— 覆盖层：只改参数（含上述被启用域的频次/时段），仍不新建规则库之外的任务域；source 恒为 'rule' ——
  const finalTasks = applyOverridesToTasks(tasks, taskOverrides, overrideMeta)

  return {
    generatedFor: date || null,
    source: TASK_SOURCE,
    disclaimer: DAILY_TASK_RULES.disclaimer,
    overridden: finalTasks.some((t) => Boolean(t.override)),
    tasks: finalTasks,
  }
}
