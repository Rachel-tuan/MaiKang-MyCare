/**
 * 迈康 MyCare · 确定性临床触发规则引擎
 * ---------------------------------------------------------------------------
 * 这里是**唯一**的规则判定实现，前端与后端共用。
 *
 * 设计原则（对应 docs/演示人设设定书_v2.md 表 4）：
 *   1. 规则判定是确定性算法，**不依赖大模型**；大模型只负责把判定结果转成自然语言，
 *      不得自行修改医学阈值或预警等级。
 *   2. 产品预警等级使用系统词表（提示 / 关注 / 预警 / 紧急），
 *      **严禁**借用「高危 / 重度 / 危象」等医学危险分层术语。
 *   3. 单次测量不作为分级诊断依据，只作为趋势信号。
 *   4. 紧急联系人通知必须满足：已授权 + 用户点击确认。
 */

/* ------------------------------------------------------------------ *
 * 产品预警等级（系统词表）
 * ------------------------------------------------------------------ */
export const ALERT_LEVEL = {
  info: { key: 'info', label: '提示', order: 1, color: '#3b82f6', description: '单次轻微异常，继续观察' },
  watch: { key: 'watch', label: '关注', order: 2, color: '#f59e0b', description: '出现波动或反复，需留意' },
  alert: { key: 'alert', label: '预警', order: 3, color: '#f97316', description: '连续异常趋势，建议就医或调整方案' },
  emergency: { key: 'emergency', label: '紧急', order: 4, color: '#ef4444', description: '严重超标或急性症状，需立即处理' },
}

const levelOrder = (key) => ALERT_LEVEL[key]?.order ?? 0

/** 取多个等级中最高者 */
export const highestAlertLevel = (levels = []) =>
  levels.reduce((top, lv) => (levelOrder(lv) > levelOrder(top) ? lv : top), 'info')

/* ------------------------------------------------------------------ *
 * 规则目录（可被 UI / PPT / 报告直接引用）
 * ------------------------------------------------------------------ */
export const RULE_CATALOG = {
  'R-BP-1': {
    id: 'R-BP-1',
    group: 'bloodPressure',
    name: '单次超标提示',
    condition: '单日收缩压 ≥140 或舒张压 ≥90，且前一日未超标',
    level: 'info',
    action: '记录本次测量，继续监测',
  },
  'R-BP-2': {
    id: 'R-BP-2',
    group: 'bloodPressure',
    name: '连续异常趋势预警',
    condition: '连续 ≥3 天收缩压 ≥140 mmHg，且 7 天收缩压涨幅 ≥10 mmHg',
    level: 'alert',
    action: '生成风险工单 + 建议复诊 + 低盐饮食建议',
  },
  'R-BP-3': {
    id: 'R-BP-3',
    group: 'bloodPressure',
    name: '严重超标强预警',
    condition: '单日收缩压 ≥180 或舒张压 ≥110 mmHg，或伴随胸痛/头晕/视物模糊',
    level: 'emergency',
    action: '强提醒 + 建议立即就医',
  },
  'R-BP-4': {
    id: 'R-BP-4',
    group: 'bloodPressure',
    name: '授权后通知紧急联系人',
    condition: '命中 R-BP-2 / R-BP-3，且联系人已授权，且用户本人点击确认',
    level: 'alert',
    action: '通知紧急联系人（默认不自动发送）',
  },

  'R-BG-1': {
    id: 'R-BG-1',
    group: 'bloodSugar',
    name: '单次超标提示',
    condition: '单日空腹血糖 > 演示判定阈值，且前一日达标',
    level: 'info',
    action: '记录本次监测',
  },
  'R-BG-2': {
    id: 'R-BG-2',
    group: 'bloodSugar',
    name: '血糖波动提醒',
    condition: '7 天极差 ≥1.4 mmol/L',
    level: 'watch',
    action: '生成波动分析',
  },
  'R-BG-3': {
    id: 'R-BG-3',
    group: 'bloodSugar',
    name: '控制不佳趋势',
    condition: '7 天达标率 <60%，且 7 天趋势向上',
    level: 'alert',
    action: '生成个性化饮食建议 + 分餐建议',
  },
  'R-BG-4': {
    id: 'R-BG-4',
    group: 'bloodSugar',
    name: '复查提醒',
    condition: '距上次 HbA1c 检测 >3 个月',
    level: 'info',
    action: '提醒复查 HbA1c',
  },

  'R-WT-1': {
    id: 'R-WT-1',
    group: 'weightBehavior',
    name: '记录达成',
    condition: '当日有体重或运动记录',
    level: 'info',
    action: '积分 +10',
  },
  'R-WT-2': {
    id: 'R-WT-2',
    group: 'weightBehavior',
    name: '减重进展反馈',
    condition: '7 天净减 ≥0.5 kg',
    level: 'info',
    action: '生成阶段小结（含水分与测量波动说明）',
  },
  'R-WT-3': {
    id: 'R-WT-3',
    group: 'weightBehavior',
    name: '短期反弹提醒',
    condition: '单日体重回升 ≥0.5 kg',
    level: 'watch',
    action: '解读为日常波动，柔性提示，不报警',
  },
  'R-WT-4': {
    id: 'R-WT-4',
    group: 'weightBehavior',
    name: '运动达标激励',
    condition: '单日步数 ≥8000，或 7 天累计运动 ≥150 分钟',
    level: 'info',
    action: '正向反馈 + 显示进度',
  },
  'R-WT-5': {
    id: 'R-WT-5',
    group: 'weightBehavior',
    name: '勋章进度跟进',
    condition: '存在未解锁的进阶勋章',
    level: 'info',
    action: '展示勋章进度与下一步目标',
  },
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */
const round = (n, d = 1) => {
  const p = 10 ** d
  return Math.round((Number(n) + Number.EPSILON) * p) / p
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 兼容两套字段命名的取值（数据库列名在前、视图模型别名在后）。
 *
 * ⚠️ 不变量（Step 11 · D-1 修复后固定）：
 *   本函数只接受**显式写入的有限数值**；`null` / `undefined` / `''` / NaN 一律视为「未记录」。
 *   它**不能**区分「这个 0 是真测得的」与「这个 0 是视图层为缺测伪造的」——
 *   因此**上游一律不得为缺测字段伪造 0**（`server/data/patientService.js` 的 `toRecordView()`
 *   曾用 `?? 0` 补默认值，导致 NULL 被读成有效测量：假预警 + 掩盖真预警 + 达标率虚高）。
 *   违反该不变量不会报错，只会静默改变医学判定结果。
 */
const pick = (record, keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), record)
    const n = num(v)
    if (n !== null) return n
  }
  return null
}

const FIELD_KEYS = {
  systolic: ['systolic_pressure', 'systolic', 'bloodPressure.systolic'],
  diastolic: ['diastolic_pressure', 'diastolic', 'bloodPressure.diastolic'],
  bloodSugar: ['blood_sugar', 'bloodSugar'],
  weight: ['weight'],
  steps: ['steps'],
  exerciseMinutes: ['exercise_minutes', 'exerciseMinutes'],
  date: ['record_date', 'date'],
}

/** 按日期升序（旧 → 新）排列记录 */
export function sortRecords(records = []) {
  return [...(records || [])]
    .filter((r) => r && (r.record_date || r.date))
    .sort((a, b) => new Date(a.record_date || a.date) - new Date(b.record_date || b.date))
}

/**
 * 抽取某个指标的时间序列（**只保留有记录的日子**）。
 *
 * 「未记录」的语义（Step 11 · D-1 修复后固定）：
 *   · 某天该指标为 NULL / 非数值 → **该日不进序列**：既不进分子也不进分母，
 *     因此达标率分母 = **窗口内的记录日数**（`stats.totalDays`），不是窗口天数。
 *   · 与 `healthScore.js` 的口径差异是**刻意的**：那边算「当日综合得分」（分母固定为适用维度，
 *     缺测 = 该维度 0 分），这边算「记录日达标率」（只统计真的测过的日子）。
 *     两者**都不把缺测当作达标** —— 这是同一类「缺测语义」在规则层内的统一结论。
 */
export function seriesOf(records, key) {
  return sortRecords(records)
    .map((r) => ({ date: r.record_date || r.date, value: pick(r, FIELD_KEYS[key] || [key]) }))
    .filter((x) => x.value !== null)
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)

/** 从末尾往前数连续满足条件的天数 */
function trailingStreak(flags) {
  let n = 0
  for (let i = flags.length - 1; i >= 0 && flags[i]; i -= 1) n += 1
  return n
}

/** 最长连续满足条件的段长 */
function longestRun(flags) {
  let best = 0
  let cur = 0
  for (const f of flags) {
    if (f) {
      cur += 1
      if (cur > best) best = cur
    } else cur = 0
  }
  return best
}

/** 最小二乘斜率，用于判定趋势方向 */
function slopeOf(values) {
  const n = values.length
  if (n < 2) return 0
  const xs = values.map((_, i) => i)
  const mx = mean(xs)
  const my = mean(values)
  let numr = 0
  let den = 0
  for (let i = 0; i < n; i += 1) {
    numr += (xs[i] - mx) * (values[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? 0 : numr / den
}

/* ------------------------------------------------------------------ *
 * 规则装配
 * ------------------------------------------------------------------ */
function makeRule(id, fields) {
  const meta = RULE_CATALOG[id]
  return {
    ruleId: id,
    group: meta.group,
    name: meta.name,
    level: meta.level,
    levelLabel: ALERT_LEVEL[meta.level].label,
    condition: meta.condition,
    defaultAction: meta.action,
    ...fields,
  }
}

/* ---------------- 血压规则：R-BP-1 ~ R-BP-4 ---------------- */
function evaluateBloodPressure(records, medical = {}) {
  const out = []
  const sys = seriesOf(records, 'systolic')
  if (sys.length < 1) return { rules: [], stats: null }
  const dia = seriesOf(records, 'diastolic')

  const targetSys = medical.demoThreshold?.systolic ?? 140
  const targetDia = medical.demoThreshold?.diastolic ?? 90
  const sysValues = sys.map((s) => s.value)
  const diaValues = dia.map((s) => s.value)

  const flags = sysValues.map((v, i) => v >= targetSys || (diaValues[i] ?? 0) >= targetDia)
  const compliantDays = flags.filter((f) => !f).length
  const complianceRate = round((compliantDays / flags.length) * 100, 1)

  const streak = trailingStreak(flags)
  const run = longestRun(sysValues.map((v) => v >= targetSys))
  const rise = sysValues[sysValues.length - 1] - sysValues[0]
  const riseDia = diaValues.length ? diaValues[diaValues.length - 1] - diaValues[0] : 0
  const latestSys = sysValues[sysValues.length - 1]
  const latestDia = diaValues[diaValues.length - 1] ?? null
  const maxSys = Math.max(...sysValues)
  const maxDia = diaValues.length ? Math.max(...diaValues) : 0

  const stats = {
    targetSys,
    targetDia,
    complianceRate,
    compliantDays,
    totalDays: flags.length, // = 窗口内**有血压记录**的天数（未记录日不计入分母，见 seriesOf）
    consecutiveAbnormalDays: streak,
    longestHighRun: run,
    rise: round(rise, 0),
    riseDiastolic: round(riseDia, 0),
    latestSystolic: latestSys,
    latestDiastolic: latestDia,
    first: sysValues[0],
    maxSystolic: maxSys,
    maxDiastolic: maxDia,
  }

  // R-BP-3 严重超标强预警（≥180 / ≥110）
  if (maxSys >= 180 || maxDia >= 110) {
    out.push(
      makeRule('R-BP-3', {
        title: '血压显著升高',
        basis: `最高收缩压 ${maxSys} mmHg、最高舒张压 ${maxDia} mmHg`,
        message: `血压显著升高（${latestSys}/${latestDia} mmHg），建议立即静坐复测，若仍异常请尽快就医。`,
        action: '立即复测，必要时就医',
        priority: 1,
      })
    )
  }

  // R-BP-2 连续异常趋势预警
  if (run >= 3 && rise >= 10) {
    out.push(
      makeRule('R-BP-2', {
        title: '血压连续升高',
        basis: `连续 ${run} 天收缩压 ≥${targetSys} mmHg，7 天涨幅 +${round(rise, 0)} mmHg`,
        message:
          `近 ${flags.length} 天您的收缩压从 ${sysValues[0]} 升高到 ${latestSys} mmHg（+${round(rise, 0)}），` +
          `其中已连续 ${run} 天超过 ${targetSys}/${targetDia} 的目标值。这个持续上升的趋势值得重视，建议近期复诊评估用药。`,
        action: '生成风险工单、建议近期复诊、低盐饮食建议',
        priority: 2,
      })
    )
  }

  // R-BP-1 单次超标提示（仅当没有更严重的连续异常时才有意义）
  const lastFlag = flags[flags.length - 1]
  const prevFlag = flags.length > 1 ? flags[flags.length - 2] : false
  if (lastFlag && !prevFlag) {
    out.push(
      makeRule('R-BP-1', {
        title: '今日血压略高',
        basis: `今日 ${latestSys}/${latestDia} mmHg，高于目标 ${targetSys}/${targetDia}`,
        message: `今日血压略高于目标值（${latestSys}/${latestDia} mmHg），请继续监测。`,
        action: '继续监测，记录今日数值',
        priority: 3,
      })
    )
  }

  return { rules: out.map((r) => ({ ...r, stats })), stats }
}

/* ---------------- 血糖规则：R-BG-1 ~ R-BG-4 ---------------- */
function evaluateBloodSugar(records, medical = {}) {
  const out = []
  const bs = seriesOf(records, 'bloodSugar')
  if (!bs.length) return { rules: [], stats: null }

  const threshold = medical.demoThreshold?.fastingGlucose ?? 7.8
  const values = bs.map((s) => s.value)
  const flags = values.map((v) => v <= threshold)
  const compliantDays = flags.filter(Boolean).length
  const complianceRate = round((compliantDays / flags.length) * 100, 1)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const rangeValue = round(max - min, 1)
  const first = values[0]
  const latest = values[values.length - 1]
  const slope = slopeOf(values)
  const rising = slope > 0 && latest >= first

  const stats = {
    threshold,
    complianceRate,
    compliantDays,
    totalDays: flags.length, // = 窗口内**有血糖记录**的天数（未记录日不计入分母，见 seriesOf）
    min,
    max,
    range: rangeValue,
    first,
    latest,
    slope: round(slope, 3),
    rising,
    thresholdNote: medical.demoThresholdNote,
  }

  // R-BG-3 控制不佳趋势
  if (complianceRate < 60 && rising) {
    const missDays = flags.length - compliantDays
    out.push(
      makeRule('R-BG-3', {
        title: '血糖控制不佳',
        basis: `7 天达标率 ${complianceRate}%（低于 60%），且呈上升趋势`,
        message:
          `近 ${flags.length} 天有 ${missDays} 天未达到您的控制目标（空腹 ${threshold} mmol/L 以内），` +
          `并且整体呈上升趋势，最高 ${max} mmol/L。`,
        action: '生成个性化饮食建议与分餐建议',
        priority: 2,
      })
    )
  }

  // R-BG-2 血糖波动提醒
  if (rangeValue >= 1.4) {
    out.push(
      makeRule('R-BG-2', {
        title: '血糖波动较大',
        basis: `7 天极差 ${rangeValue} mmol/L（最高 ${max}、最低 ${min}）`,
        message: `近 ${flags.length} 天血糖波动较大（最高 ${max}、最低 ${min}，相差 ${rangeValue} mmol/L）。`,
        action: '关注餐后血糖与进食结构',
        priority: 3,
      })
    )
  }

  // R-BG-1 单次超标提示
  const lastFlag = flags[flags.length - 1]
  const prevOk = flags.length > 1 ? flags[flags.length - 2] : true
  if (!lastFlag && prevOk) {
    out.push(
      makeRule('R-BG-1', {
        title: '今日空腹血糖略高',
        basis: `今日 ${latest} mmol/L，高于控制目标 ${threshold}`,
        message: `今日空腹血糖 ${latest} mmol/L，略高于您的控制目标，继续监测即可。`,
        action: '记录本次监测',
        priority: 4,
      })
    )
  }

  // R-BG-4 复查提醒
  const months = Number(medical.hba1cLastTestMonthsAgo)
  if (Number.isFinite(months) && months > 3) {
    out.push(
      makeRule('R-BG-4', {
        title: '建议复查 HbA1c',
        basis: `距上次 HbA1c 检测已 ${months} 个月（超过 3 个月）`,
        message: '建议复查 HbA1c，了解近 3 个月的整体血糖控制情况。',
        action: '预约复查 HbA1c',
        priority: 4,
      })
    )
  }

  return { rules: out.map((r) => ({ ...r, stats })), stats }
}

/* ---------------- 体重与行为规则：R-WT-1 ~ R-WT-5 ---------------- */
function evaluateWeightBehavior(records, patient = {}) {
  const out = []
  const sorted = sortRecords(records)
  if (!sorted.length) return { rules: [], stats: null }

  const wt = seriesOf(records, 'weight').map((s) => s.value)
  const steps = seriesOf(records, 'steps').map((s) => s.value)
  const exercise = seriesOf(records, 'exerciseMinutes').map((s) => s.value)

  const dailyDiffs = wt.slice(1).map((v, i) => round(v - wt[i], 1))
  const maxRebound = dailyDiffs.length ? Math.max(...dailyDiffs) : 0
  const netChange = wt.length ? round(wt[wt.length - 1] - wt[0], 1) : 0
  const weekExercise = exercise.reduce((a, b) => a + b, 0)
  const maxSteps = steps.length ? Math.max(...steps) : 0
  const avgSteps = Math.round(mean(steps))

  const stats = {
    netChange,
    maxRebound,
    weekExercise,
    maxSteps,
    avgSteps,
    firstWeight: wt[0] ?? null,
    latestWeight: wt[wt.length - 1] ?? null,
    recordedDays: sorted.length,
  }

  // R-WT-1 记录达成
  out.push(
    makeRule('R-WT-1', {
      title: '今日已完成记录',
      basis: `已连续记录 ${sorted.length} 天`,
      message: '今日记录已完成，坚持记录本身就是最有效的干预。',
      action: '积分 +10',
      priority: 5,
    })
  )

  // R-WT-2 减重进展反馈
  if (netChange <= -0.5) {
    out.push(
      makeRule('R-WT-2', {
        title: '体重稳步下降',
        basis: `7 天体重 ${wt[0]} → ${wt[wt.length - 1]} kg，净变化 ${netChange} kg`,
        message:
          `这 ${wt.length} 天体重从 ${wt[0]} kg 变化到 ${wt[wt.length - 1]} kg（净变化 ${netChange} kg，含水分与测量波动），` +
          '整体趋势是向下的，保持住。',
        action: '保持当前节奏',
        priority: 2,
      })
    )
  }

  // R-WT-3 短期反弹提醒（柔性）
  if (maxRebound >= 0.5) {
    const idx = dailyDiffs.indexOf(maxRebound) + 1
    out.push(
      makeRule('R-WT-3', {
        title: '体重出现短期反弹',
        basis: `第 ${idx + 1} 天较前一日回升 ${maxRebound} kg`,
        message:
          `体重比前一天回升 ${maxRebound} kg，这属于日常波动，可能和饮水、进食、测量时间有关，` +
          '不代表脂肪增加，不必焦虑。看趋势比看单天更可靠。',
        action: '继续记录，结合腰围一起观察',
        priority: 3,
        soft: true,
      })
    )
  }

  // R-WT-4 运动达标激励
  if (maxSteps >= 8000 || weekExercise >= 150) {
    const parts = []
    if (weekExercise >= 150) parts.push(`这 ${exercise.length} 天累计运动 ${weekExercise} 分钟，已经达到每周 150 分钟的推荐量`)
    if (maxSteps >= 8000) parts.push(`单日最高步数 ${maxSteps} 步，超过 8000 步目标`)
    out.push(
      makeRule('R-WT-4', {
        title: '运动量达标',
        basis: `周运动 ${weekExercise} 分钟，单日最高步数 ${maxSteps} 步`,
        message: `${parts.join('；')}，做得很不错！`,
        action: '正向反馈',
        priority: 2,
      })
    )
  }

  // R-WT-5 勋章进度跟进
  const earnedTypes = (patient.badges || []).map((b) => b.type)
  const progresses = []
  if (!earnedTypes.includes('步数达标')) {
    progresses.push({
      badge: '健步如飞',
      requirement: '平均步数达到 8000 步',
      current: avgSteps,
      target: 8000,
      percent: Math.min(99, Math.round((avgSteps / 8000) * 100)),
    })
  }
  if (!earnedTypes.includes('连续记录')) {
    progresses.push({ badge: '坚持不懈', requirement: '连续 7 天记录', current: sorted.length, target: 7, percent: Math.min(99, Math.round((sorted.length / 7) * 100)) })
  }
  if (progresses.length) {
    const top = progresses[0]
    out.push(
      makeRule('R-WT-5', {
        title: '勋章进度',
        basis: `「${top.badge}」当前进度 ${top.percent}%`,
        message: `距离「${top.badge}」还差一点：${top.requirement}，当前 ${top.current}/${top.target}。`,
        action: '展示勋章进度与明日目标',
        priority: 5,
        progress: progresses,
      })
    )
  }

  return { rules: out.map((r) => ({ ...r, stats })), stats }
}

/* ------------------------------------------------------------------ *
 * 对外主入口
 * ------------------------------------------------------------------ */

/**
 * 执行全部规则判定
 * @param {object} patient  demoPatients 中的病例对象（提供 medical / lifestyle / badges）
 * @param {Array}  records  健康记录（兼容两套字段命名）
 * @returns {{ matched, byId, highestLevel, levels, stats, personalization, emergency }}
 */
export function evaluateClinicalRules(patient = {}, records = []) {
  const medical = patient.medical || {}
  const bp = evaluateBloodPressure(records, medical)
  const bg = evaluateBloodSugar(records, medical)
  const wt = evaluateWeightBehavior(records, patient)

  const matched = [...bp.rules, ...bg.rules, ...wt.rules].sort(
    (a, b) => (a.priority ?? 9) - (b.priority ?? 9)
  )

  const byId = {}
  for (const r of matched) byId[r.ruleId] = r

  const triggered = matched.filter((r) => levelOrder(r.level) >= levelOrder('watch'))
  const highestLevel = triggered.length ? highestAlertLevel(triggered.map((r) => r.level)) : 'info'

  return {
    matched,
    /**
     * 「关注及以上」的命中项 = 本系统的**规范风险集合**（Step 11 · D-2 新增）。
     * `highestLevel`、`alerts` 落库（PERSIST_LEVELS）、医生端状态、晨报风险等级
     * **全部取自此集合** —— 任何消费方都不要再自己写一遍过滤，否则又会分裂出第二套口径。
     */
    triggered,
    byId,
    highestLevel,
    levels: matched.map((r) => r.level),
    stats: {
      bloodPressure: bp.stats,
      bloodSugar: bg.stats,
      weightBehavior: wt.stats,
    },
    personalization: buildPersonalizedAdvice(patient),
    emergency: emergencyContactPolicy(patient),
  }
}

/** 判定某条规则是否命中 */
export const isRuleMatched = (evaluation, ruleId) => Boolean(evaluation?.byId?.[ruleId])

/** 断言某条规则必须不命中（用于自检） */
export const isRuleForbidden = (evaluation, ruleId) => !evaluation?.byId?.[ruleId]

/* ------------------------------------------------------------------ *
 * 生活画像 → 个性化建议（v2 要求：画像必须真正进入建议逻辑）
 * ------------------------------------------------------------------ */
export function buildPersonalizedAdvice(patient = {}) {
  const tags = patient.lifestyle?.tags || {}
  const advice = []
  const push = (key, text) => advice.push({ key, text, source: 'lifestyle' })

  if (tags.highSalt) push('highSalt', '您口味偏咸，这一项对血压影响比较直接，先从每天食盐减到 5 g 以下做起。')
  if (tags.pickledFood) push('pickledFood', '腌菜建议改成隔天吃，一次不超过一小碟。')
  if (tags.refinedStaple)
    push(
      'refinedStaple',
      '您平时主食以面食为主，可以先从减少约 1/4 的精制面食开始，换成杂粮面或搭配一份蔬菜，不用一下子全换。'
    )
  if (tags.fastEating) push('fastEating', '把进餐速度放慢到 20 分钟以上，先吃菜、再吃肉蛋、最后吃主食。')
  if (tags.lowVegetable) push('lowVegetable', '每餐加一份深色蔬菜，目标每天 500 g（约两捧）。')
  if (tags.lateHeavyDinner) push('lateHeavyDinner', '晚餐吃到七分饱、主食减半，尽量在 19:00 前吃完。')
  if (tags.irregularMeals) push('irregularMeals', '先把三餐时间固定下来，这一步比控制食量更有效。')
  if (tags.sedentary) push('sedentary', '每坐满 1 小时起身活动 3 分钟，先从这一条开始。')
  if (tags.snoring) push('snoring', '夜间打鼾比较明显，建议做一次睡眠呼吸暂停筛查。')

  return advice
}

/* ------------------------------------------------------------------ *
 * 紧急联系人通知策略
 * ------------------------------------------------------------------ */
export function emergencyContactPolicy(patient = {}) {
  const contact = patient.profile?.emergencyContact || null
  const authorized = Boolean(contact?.authorized)
  return {
    contact,
    authorized,
    /** 是否允许发起通知：已授权 且 用户点击确认 */
    canNotify: (userConfirmed = false) => authorized && Boolean(userConfirmed),
    reason: authorized
      ? '联系人已授权，仍需用户本人点击确认后才会发送通知。'
      : '联系人尚未授权，系统只记录风险，不会自动外发任何信息。',
  }
}

/** 组合判定：是否应当真正外发通知 */
export function shouldNotifyEmergencyContact(patient, { userConfirmed = false } = {}) {
  const policy = emergencyContactPolicy(patient)
  return policy.canNotify(userConfirmed)
}

/** 规则命中摘要（给自然语言层做转译输入，禁止模型修改其中的数值与等级） */
export function summarizeForLLM(evaluation) {
  if (!evaluation) return null
  return {
    alertLevel: ALERT_LEVEL[evaluation.highestLevel]?.label || '提示',
    alertLevelKey: evaluation.highestLevel,
    matchedRules: evaluation.matched.map((r) => ({
      ruleId: r.ruleId,
      ruleName: r.name,
      level: r.levelLabel,
      basis: r.basis,
      action: r.action,
    })),
    stats: evaluation.stats,
    personalization: evaluation.personalization.map((a) => a.text),
    emergencyContact: {
      name: evaluation.emergency?.contact?.name || '',
      relation: evaluation.emergency?.contact?.relation || '',
      authorized: evaluation.emergency?.authorized ?? false,
      policy: evaluation.emergency?.reason || '',
    },
  }
}
