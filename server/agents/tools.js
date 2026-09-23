/**
 * 迈康 MyCare · 智能体工具集
 *
 * 这里既是「模型可调用的函数」，也是作品的核心算法层：
 * 最小二乘趋势拟合、达标率统计、连续异常检出、分级风险判定、个性化建议生成。
 * 所有工具都在客户端上传的健康快照(context)上运行，服务端无状态、不落库。
 */

import {
  evaluateClinicalRules,
  ALERT_LEVEL,
  buildPersonalizedAdvice,
} from '../../src/utils/clinicalRules.js'
import { computeDailyHealthScore } from '../../src/utils/healthScore.js'
import { todayCST } from '../data/dataProvider.js'

/* ------------------------------------------------------------------ *
 * 疾病谱识别
 * 真实病历中的病名常带前缀/后缀（「2型糖尿病」「原发性高血压」「高血压病3级」），
 * 因此必须按关键字包含匹配，不能用全等比较。
 * ------------------------------------------------------------------ */
export const DISEASE_KEYWORD = {
  hypertension: ['高血压'],
  diabetes: ['糖尿病'],
  dyslipidemia: ['高血脂', '血脂异常', '高脂血症'],
  obesity: ['肥胖'],
  chd: ['冠心病', '冠状动脉'],
  stroke: ['脑梗', '脑卒中', '中风'],
  ckd: ['肾病', '肾功能不全'],
}

/** 疾病谱中是否命中某类疾病（关键字包含匹配） */
export function hasDisease(diseases = [], keywords = []) {
  const list = Array.isArray(diseases) ? diseases : [diseases]
  const joined = list.filter(Boolean).join('|')
  return keywords.some((kw) => joined.includes(kw))
}

/* ------------------------------------------------------------------ *
 * 指标参考模型
 * ------------------------------------------------------------------ */
const VITAL_META = {
  systolic_pressure: { label: '收缩压', unit: 'mmHg', target: 140, warn: 160, danger: 180, low: 90, better: 'lower' },
  diastolic_pressure: { label: '舒张压', unit: 'mmHg', target: 90, warn: 100, danger: 110, low: 60, better: 'lower' },
  blood_sugar: { label: '空腹血糖', unit: 'mmol/L', target: 7.0, warn: 8.0, danger: 16.7, low: 3.9, better: 'lower' },
  heart_rate: { label: '静息心率', unit: '次/分', target: 90, warn: 100, danger: 120, low: 50, better: 'range' },
  weight: { label: '体重', unit: 'kg', target: null, warn: null, danger: null, low: null, better: 'stable' },
  steps: { label: '步数', unit: '步', target: 8000, warn: 6000, danger: null, low: null, better: 'higher' },
  sleep_hours: { label: '睡眠', unit: '小时', target: 7, warn: 6, danger: null, low: null, better: 'higher' },
  exercise_minutes: { label: '运动时长', unit: '分钟', target: 30, warn: 15, danger: null, low: null, better: 'higher' },
}

const round = (n, d = 1) => {
  const p = 10 ** d
  return Math.round((Number(n) + Number.EPSILON) * p) / p
}

/** 最小二乘线性回归，返回斜率与拟合优度 R² */
export function linearRegression(values) {
  const n = values.length
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 }
  const xs = values.map((_, i) => i)
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = values.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - meanX) * (values[i] - meanY)
    den += (xs[i] - meanX) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  const intercept = meanY - slope * meanX

  let ssTot = 0
  let ssRes = 0
  for (let i = 0; i < n; i += 1) {
    ssTot += (values[i] - meanY) ** 2
    ssRes += (values[i] - (slope * xs[i] + intercept)) ** 2
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot)
  return { slope, intercept, r2 }
}

/** 标准差 */
function stdev(values) {
  if (values.length < 2) return 0
  const m = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1))
}

const seriesOf = (records, key) =>
  records
    .map((r) => ({ date: r.record_date, value: r[key] }))
    .filter((x) => x.value !== null && x.value !== undefined && x.value !== '' && !Number.isNaN(Number(x.value)))
    .map((x) => ({ date: x.date, value: Number(x.value) }))

/** 按 record_date 升序（旧 → 新），便于趋势分析 */
export function normalizeRecords(records = []) {
  return [...records]
    .filter((r) => r && r.record_date)
    .sort((a, b) => new Date(a.record_date) - new Date(b.record_date))
}

/** 取最近 N 天 */
export function recentRecords(records, days = 7) {
  const sorted = normalizeRecords(records)
  if (!sorted.length) return []
  const last = new Date(sorted[sorted.length - 1].record_date)
  const from = new Date(last)
  from.setDate(from.getDate() - (days - 1))
  return sorted.filter((r) => new Date(r.record_date) >= from)
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000)
}

/**
 * 单指标的多维分析
 * @returns 均值 / 极值 / 趋势 / 达标率 / 异常片段 / 波动性
 */
export function analyzeSeries(records, key, metaOverride = null) {
  const meta = metaOverride || VITAL_META[key] || { label: key, unit: '', better: 'stable' }
  const series = seriesOf(records, key)
  if (!series.length) {
    return { key, label: meta.label, unit: meta.unit, available: false, sampleCount: 0 }
  }

  const values = series.map((s) => s.value)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const { slope, r2 } = linearRegression(values)
  const sd = stdev(values)

  // 达标判定
  let compliant = 0
  let warnDays = 0
  let dangerDays = 0
  const abnormalSpans = []
  let currentSpan = null

  series.forEach((point) => {
    const v = point.value
    // 三级判定：danger(触及危险线/低于下限) > warn(未达目标) > ok(达标)
    // 注意：达标率必须按 target 判定，不能只看 warn/danger 警戒线，
    // 否则「收缩压 150」会被误判为达标（这正是本作品早期版本的缺陷）。
    let level = 'ok'
    if (meta.danger !== null && v >= meta.danger) level = 'danger'
    else if (meta.low !== null && v <= meta.low) level = 'danger'
    else if (meta.better === 'higher') {
      if (meta.target !== null && v < meta.target) level = 'warn'
    } else if (meta.target !== null && v > meta.target) {
      level = 'warn'
    }

    if (level === 'ok') compliant += 1
    else if (level === 'warn') warnDays += 1
    else if (level === 'danger') dangerDays += 1

    if (level !== 'ok') {
      if (currentSpan) currentSpan.days += 1
      else currentSpan = { start: point.date, days: 1, level }
      if (level === 'danger') currentSpan.level = 'danger'
    } else if (currentSpan) {
      abnormalSpans.push(currentSpan)
      currentSpan = null
    }
  })
  if (currentSpan) abnormalSpans.push(currentSpan)

  const longestAbnormal = abnormalSpans.reduce((m, s) => Math.max(m, s.days), 0)
  const pctChange = values.length > 1 && values[0] !== 0 ? ((values[values.length - 1] - values[0]) / values[0]) * 100 : 0

  // 趋势方向判断：结合斜率显著性与变化幅度
  let direction = 'stable'
  const slopeSignificant = r2 > 0.25 && Math.abs(slope) > sd * 0.15
  if (slopeSignificant) direction = slope > 0 ? 'rising' : 'falling'
  else if (Math.abs(pctChange) > 8) direction = pctChange > 0 ? 'rising' : 'falling'

  const total = series.length
  return {
    key,
    label: meta.label,
    unit: meta.unit,
    available: true,
    sampleCount: total,
    first: round(values[0], 1),
    latest: round(values[values.length - 1], 1),
    mean: round(mean, 1),
    min: round(Math.min(...values), 1),
    max: round(Math.max(...values), 1),
    stdDev: round(sd, 2),
    pctChange: round(pctChange, 1),
    slope: round(slope, 3),
    r2: round(r2, 2),
    direction,
    better: meta.better,
    target: meta.target,
    complianceRate: round((compliant / total) * 100, 1),
    compliantDays: compliant,
    warnDays,
    dangerDays,
    longestAbnormalDays: longestAbnormal,
    abnormalSpans,
    // 对「越高越好」的指标，"改善"方向相反
    improving:
      meta.better === 'lower' ? direction === 'falling'
      : meta.better === 'higher' ? direction === 'rising'
      : 'neutral',
  }
}

/** 连续记录天数 */
export function consecutiveRecordDays(records) {
  const sorted = normalizeRecords(records)
  if (!sorted.length) return 0
  let streak = 1
  for (let i = sorted.length - 1; i > 0; i -= 1) {
    if (daysBetween(sorted[i - 1].record_date, sorted[i].record_date) === 1) streak += 1
    else break
  }
  return streak
}

/**
 * 健康总评分（0-100）
 * ---------------------------------------------------------------------------
 * 口径与权重的**唯一实现在 src/utils/healthScore.js**，前端 HealthDataContext
 * 调用的是同一份代码 —— 保证「用户在界面上看到的分数」与「智能体口播的分数」
 * 永远一致，不会出现两套阈值打架。
 *
 * 分母按该患者**适用维度**固定（疾病谱决定），不随当日是否有数据漂移。
 * 旧实现是「有数据才把该维度计入分母」，会因缺测而虚高（血压没测也可能满分）。
 *
 * ⚠️ **评分基准日恒为「真实今天」（东八区）**，与今日任务同源。
 * 旧实现取 `sorted[sorted.length - 1]`（记录窗口内日期最大的一行），当今天还没录入时
 * 会把历史某天当成「今日」：界面/晨报写着「今日健康评分」，算的却是昨天的步数，
 * 与今日任务（按 todayCST() 派生）同屏矛盾；更严重的是让今日未录入的维度被历史值顶上，
 * 白送满分 —— 红线 10「缺测不得当达标」的同类缺陷。
 * 今日无记录时以空对象计分：适用维度全部 `status: 'missing'`，按 0 分计入分母。
 */
export function computeHealthScore(records, user = {}) {
  const sorted = normalizeRecords(records)
  const baseDate = todayCST()
  const today = sorted.find((r) => r.record_date === baseDate) || {}
  if (!sorted.length) {
    return { score: 0, grade: '需干预', breakdown: [], reason: '暂无健康记录', date: baseDate }
  }

  const diseases = Array.isArray(user.disease_types)
    ? user.disease_types
    : Array.isArray(user.diseases)
      ? user.diseases
      : []

  // Step 12：extraScoreDimensions 由 buildAgentContext 注入（来源=生效覆盖包的 addedTasks），
  // 保证「智能体口播的分数」与界面 / aiScoreService 三处同源同分母。
  const detail = computeDailyHealthScore({
    today,
    diseases,
    extraDimensions: Array.isArray(user.extraScoreDimensions) ? user.extraScoreDimensions : [],
  })

  return {
    score: detail.score,
    grade: detail.grade,
    applicableWeight: detail.applicableWeight,
    missing: detail.missing,
    breakdown: detail.breakdown.map((b) => ({
      label: b.label,
      weight: b.weight,
      got: b.earned,
      status: b.status,
      basis: b.detail,
    })),
    note:
      detail.missing.length > 0
        ? `满分按该患者适用维度合计 ${detail.applicableWeight} 分计；今日未录入：${detail.missing.join('、')}，按 0 分计入。`
        : `满分按该患者适用维度合计 ${detail.applicableWeight} 分计；各项均已录入。`,
    date: today.record_date || baseDate,
  }
}

/* ------------------------------------------------------------------ *
 * 风险等级 —— 唯一裁定者：clinicalRules
 * ------------------------------------------------------------------ */

/**
 * 内部键位 ↔ 产品键位（提示/关注/预警/紧急）的双向翻译。
 * ⚠️ 这里**只有键名翻译，没有任何阈值**；内部键位之所以存在，仅因为
 * `raise_alert` 工具的入参契约（模型可见）沿用 critical/high/medium/low。
 */
const INTERNAL_TO_PRODUCT = { critical: 'emergency', high: 'alert', medium: 'watch', low: 'info' }
const PRODUCT_TO_INTERNAL = { emergency: 'critical', alert: 'high', watch: 'medium', info: 'low' }

/** 任意键位（内部键 / 产品键）→ 产品键 */
export const toProductLevel = (k) => INTERNAL_TO_PRODUCT[k] || (ALERT_LEVEL[k] ? k : 'info')

/** 产品键 → 内部键（仅用于 raise_alert 入参） */
export const toInternalLevel = (k) => PRODUCT_TO_INTERNAL[k] || (INTERNAL_TO_PRODUCT[k] ? k : 'low')

/** 由智能体档案拼出规则引擎需要的病例结构（与 createToolExecutor 内部同一形状） */
function rulePatientOf(user = {}) {
  return {
    id: user.user_id || user.id || 'patient',
    profile: { emergencyContact: user.emergencyContact || { authorized: false } },
    medical: user.medical || {},
    lifestyle: user.lifestyle || {},
    badges: (user.badges || []).map((b) => ({ type: b.badge_type || b.badgeType || b.type })),
  }
}

/**
 * 描述性观察 —— **不含等级、不参与裁定**
 * ---------------------------------------------------------------------------
 * 保留 `assessRisk` 原有的「自然语言描述」职责：心率 / 睡眠 / 体重波动 / 步数 /
 * 记录中断这些点在 clinicalRules 的规则目录里**没有**对应规则，故只能作为补充文案素材。
 *
 * 返回项**只有 title / detail / action 三个描述字段**，没有 level / 分数 / 标签，
 * 因此任何消费方都无法把它当成风险等级使用（这正是 D-2 要求的「保留描述、去掉裁定」）。
 * 阈值沿用修复前的原值，**未被调参**，仅降级为「描述触发条件」。
 */
function describeObservations(records, user = {}) {
  const sorted = normalizeRecords(records)
  if (!sorted.length) return []
  const out = []
  const push = (title, detail, action) => out.push({ title, detail, action })

  const latest = sorted[sorted.length - 1] || {}
  const hr = Number(latest.heart_rate || 0)
  if (hr && (hr >= 120 || hr <= 45)) {
    push('心率异常', `最新静息心率 ${hr} 次/分`, '静坐 5 分钟后复测，异常请就医')
  }
  const sleepSeries = analyzeSeries(sorted, 'sleep_hours')
  if (sleepSeries.available && sleepSeries.mean < 6) {
    push('睡眠时长不足', `平均 ${sleepSeries.mean} 小时/天`, '固定作息，睡前 1 小时远离屏幕')
  }
  const weightSeries = analyzeSeries(sorted, 'weight')
  if (weightSeries.available && Math.abs(weightSeries.max - weightSeries.min) >= 2) {
    push('体重短期波动较大', `7 天内波动 ${round(weightSeries.max - weightSeries.min, 1)} kg`, '排查水肿与饮食变化，持续记录')
  }
  const stepSeries = analyzeSeries(sorted, 'steps')
  if (stepSeries.available && stepSeries.complianceRate < 40) {
    push('运动量偏低', `步数达标率仅 ${stepSeries.complianceRate}%`, '从每天 20 分钟散步开始逐步增加')
  }
  if (Array.isArray(user.disease_types) && user.disease_types.length && consecutiveRecordDays(sorted) === 0) {
    push('健康记录中断', '近 2 天没有新增记录', '恢复每日记录，这是方案调整的依据')
  }
  return out
}

/**
 * 风险等级评估 —— **等级唯一来源：clinicalRules**（Step 11 · D-2 修复）
 * ===========================================================================
 * 修复前：本函数自带一套独立阈值（收缩压 180/160、血糖 16.7/11.1、心率 120/45…）
 *        与独立词表（critical/high/medium/low），再映射成与 `ALERT_LEVEL` **同名**的
 *        中文标签，于是首页顶部「晨报风险等级」与下方「落库预警卡片」同屏互相打脸
 *        （实测 4 位患者中 3 位不一致，且标签同名致使用户无法察觉是两套系统）。
 *
 * 修复后本函数只承担两件事：
 *   1. 【裁定】`highestLevel` / `levelLabel` / `score` / `risks` **全部取自 clinicalRules**；
 *      `risks` = 其「关注及以上」命中项（`rules.triggered`），与 alerts 落库、
 *      医生端状态、晨报等级**同一集合、同一排序**。
 *   2. 【描述】`observations` 见上（无等级字段，无法再成为第二裁定者）。
 *
 * 铁律：本项目**只有** `clinicalRules` 能裁定风险等级；
 *      本函数内不得再出现任何「比较阈值 → 决定等级」的代码。
 *
 * @param {Array}  records       健康记录（`toRecordView` 的输出）
 * @param {object} user          智能体档案
 * @param {object} [rulesOverride] 复用调用方已算好的 evaluation（避免重复计算）
 */
export function assessRisk(records, user = {}, rulesOverride = null) {
  const rules = rulesOverride || evaluateClinicalRules(rulePatientOf(user), records)
  const level = toProductLevel(rules.highestLevel)

  const risks = (rules.triggered || []).map((m) => ({
    ruleId: m.ruleId,
    group: m.group,
    level: m.level, // 产品键：info / watch / alert / emergency
    levelLabel: m.levelLabel, // 提示 / 关注 / 预警 / 紧急
    title: m.title,
    detail: m.basis, // 兼容旧字段名（原为本函数自算的 detail）
    message: m.message,
    action: m.action,
    priority: m.priority,
  }))

  const sorted = normalizeRecords(records)

  return {
    /** 产品键（info / watch / alert / emergency）—— 唯一来源 clinicalRules */
    highestLevel: level,
    /** 产品词表标签（提示 / 关注 / 预警 / 紧急） */
    levelLabel: ALERT_LEVEL[level].label,
    /** 等级序 1–4（与 ALERT_LEVEL.order 同源，仅用于排序/展示） */
    score: ALERT_LEVEL[level].order,
    /** 关注及以上的规则命中项（与落库预警同源同序） */
    risks,
    /** 描述性素材（无等级） */
    observations: describeObservations(records, user),
    /** clinicalRules 的原始统计（达标率 / 涨幅 / 极差…） */
    stats: rules.stats,
    evaluatedAt: (sorted[sorted.length - 1] || {}).record_date || null,
  }
}

/** 个性化干预方案生成（规则引擎 + 疾病谱匹配） */
export function draftInterventionPlan(user = {}, risk = {}, analysis = []) {
  const age = Number(user.age || 65)
  const bmi = Number(user.bmi || 24)
  const diseases = Array.isArray(user.disease_types) ? user.disease_types : []
  const hasHBP = hasDisease(diseases, DISEASE_KEYWORD.hypertension)
  const hasDM = hasDisease(diseases, DISEASE_KEYWORD.diabetes)
  const isObese = bmi >= 28
  const isHighRisk = ['alert', 'emergency'].includes(risk.highestLevel)
  const lowMobility = age >= 75

  // —— 运动建议 ——
  let exercise
  if (isHighRisk) {
    exercise = {
      type: '室内缓步走 / 坐姿关节活动',
      duration: 15,
      frequency: '每日 2 次',
      intensity: '极低强度',
      note: '当前处于高风险期，以安全为先，避免心率明显上升；身体不适立即停止并就医。',
    }
  } else if (lowMobility || isObese) {
    exercise = {
      type: hasDM ? '快走 + 弹力带抗阻' : '快走',
      duration: 30,
      frequency: lowMobility ? '每周 4-5 次' : '每周 5 次',
      intensity: '低强度',
      note: hasDM ? '餐后 1 小时开始，运动前后各测一次血糖。' : '避免憋气用力的动作，注意监测心率。',
    }
  } else {
    exercise = {
      type: hasHBP ? '快走 / 慢跑 / 太极拳' : '快走 / 游泳 / 骑行',
      duration: 40,
      frequency: '每周 5 次',
      intensity: '中等强度',
      note: '以「能说话但唱不了歌」的强度为准。',
    }
  }

  // —— 饮食建议 ——
  const restrictions = []
  const recommendations = []
  if (hasHBP) {
    restrictions.push('每日食盐不超过 5g', '避免腌制品、卤味、加工肉等高钠食物')
    recommendations.push('多摄入富钾食物（菠菜、香蕉、土豆）', '用葱姜蒜香辛料替代部分食盐调味')
  }
  if (hasDM) {
    restrictions.push('限制精制糖与含糖饮料', '主食定量，优选低 GI 食物')
    recommendations.push('进餐顺序：蔬菜 → 蛋白质 → 主食', '每餐主食控制在 1 拳大小')
  }
  if (isObese) {
    restrictions.push('控制总热量，减少油炸与动物油脂')
    recommendations.push('每餐保证一掌心优质蛋白', '先喝汤/吃菜再吃主食以增强饱腹感')
  }
  if (!restrictions.length) {
    restrictions.push('保持三餐规律，避免暴饮暴食')
    recommendations.push('每天保证 500g 蔬菜与 200g 水果')
  }

  // —— 用药提醒（只做提醒，不改剂量）——
  const reminders = []
  if (hasHBP) reminders.push({ name: '降压药', time: '08:00', tip: '每日固定时间服用，服药后静坐 10 分钟再测血压' })
  if (hasDM) reminders.push({ name: '降糖药 / 胰岛素', time: '07:30', tip: '餐前按医嘱使用，随身携带糖果以防低血糖' })
  if (!reminders.length) reminders.push({ name: '日常维生素 / 钙片', time: '09:00', tip: '随餐服用吸收更好' })

  // —— 目标设定 ——
  // 控制目标一律取自病例的个体化演示阈值，不写死通用值
  const bpTargetSys = Number(user.medical?.demoThreshold?.systolic) || 140
  const bpTargetDia = Number(user.medical?.demoThreshold?.diastolic) || 90
  const bsTarget = Number(user.medical?.demoThreshold?.fastingGlucose) || 7.0
  const weightKg = Number(user.weight) || 0

  const goals = {
    steps: isHighRisk ? 3000 : isObese ? 10000 : 8000,
    systolicTarget: `≤${bpTargetSys} mmHg`,
    diastolicTarget: `≤${bpTargetDia} mmHg`,
    bloodSugarTarget: hasDM
      ? `空腹 ≤${bsTarget} mmol/L（本病例演示判定阈值）`
      : '空腹 ≤6.1 mmol/L',
    weightTarget: isObese
      ? `3–6 个月减重 5%–10%${
          weightKg ? `（约 ${round(weightKg * 0.05, 1)}–${round(weightKg * 0.1, 1)} kg）` : ''
        }，每周 0.5–1.0 kg 匀速下降`
      : '保持当前体重 ±1kg',
    recordStreak: '每日记录不间断',
  }

  // —— 随访计划 ——
  const followUp = isHighRisk
    ? '建议 24 小时内与家庭医生取得联系，48 小时内复诊。'
    : risk.highestLevel === 'watch'
      ? '建议 3 日内复测相关指标，1 周内复诊评估。'
      : '保持每月一次常规复查。'

  // 生活画像 → 个性化建议
  // v2 要求：画像必须真正进入建议逻辑，而不是只存储不使用。
  // 例如李秀英「主食以面食为主」→「先从减少约 1/4 的精制面食开始」。
  const personalization = buildPersonalizedAdvice(user).map((a) => a.text)

  return {
    generatedFor: { age, bmi, diseases, lifestyleSummary: user.lifestyle?.diet || '' },
    riskLevel: risk.highestLevel || 'info',
    riskLevelLabel: risk.levelLabel || ALERT_LEVEL[toProductLevel(risk.highestLevel)]?.label || '提示',
    exercise,
    diet: {
      restrictions,
      // 个性化条目排在通用条目之前，更贴合本人情况
      recommendations: [...new Set([...personalization, ...recommendations])],
    },
    personalization,
    medicationReminders: reminders,
    goals,
    followUp,
    weightNotice: isObese
      ? '体重变化受水分、糖原储备、进食与测量时间影响，短期净变化不能等同于脂肪减少，也不宜线性外推。'
      : null,
    disclaimer: '以上方案由迈康 MyCare 智能体基于历史记录生成，仅供健康管理参考，不能替代执业医师的诊断与治疗决策。',
  }
}

/* ------------------------------------------------------------------ *
 * 本地健康知识库（离线检索，用于多模态识别智能体的兜底）
 * ------------------------------------------------------------------ */
const KNOWLEDGE_BASE = [
  {
    keywords: ['血压', '高血压', '收缩压', '舒张压'],
    title: '血压管理要点',
    content:
      '家庭自测血压建议早晚各一次，测量前静坐 5 分钟。一般老年人控制目标为 140/90 mmHg 以下；合并糖尿病或肾病者建议 130/80 mmHg 以下。连续 3 天超过 160/100 mmHg 需及时复诊。',
  },
  {
    keywords: ['血糖', '糖尿病', '空腹血糖', '餐后血糖', '糖化'],
    title: '血糖管理要点',
    content:
      '老年糖尿病患者空腹血糖建议控制在 7.0 mmol/L 以内，餐后 2 小时 10.0 mmol/L 以内。糖化血红蛋白一般目标 7.0%。出现心慌、出汗、手抖提示低血糖，应立即补充 15g 碳水。',
  },
  {
    keywords: ['他汀', '阿司匹林', '降压药', '二甲双胍', '用药'],
    title: '常见慢病用药注意事项',
    content:
      '降压药需固定时间服用、不可自行停药；二甲双胍建议随餐或餐后服用以减少胃肠反应；他汀类建议睡前服用；阿司匹林肠溶片需空腹整片吞服。任何剂量调整必须由医生决定。',
  },
  {
    keywords: ['运动', '锻炼', '步数', '快走'],
    title: '老年慢病人群运动建议',
    content:
      '推荐每周累计 150 分钟中等强度有氧运动，如快走、太极、游泳，分散到 5 天进行。运动强度以「能说话但不能唱歌」为宜。血压高于 180/110 mmHg 时应暂停运动。',
  },
  {
    keywords: ['饮食', '盐', '钠', '低盐', 'GI'],
    title: '慢病人群膳食原则',
    content:
      '每日食盐不超过 5g；优先选择全谷物、深色蔬菜、优质蛋白；限制精制糖与饱和脂肪。进餐顺序建议蔬菜→蛋白质→主食，有助于平稳餐后血糖。',
  },
  {
    keywords: ['睡眠', '失眠'],
    title: '老年人睡眠建议',
    content: '建议保持 7-8 小时睡眠，固定起卧时间；午睡不超过 30 分钟；睡前 1 小时避免屏幕与浓茶咖啡。长期入睡困难需排查焦虑与呼吸睡眠暂停。',
  },
]

export function searchHealthKnowledge(query) {
  const q = String(query || '').toLowerCase()
  if (!q) return []
  const scored = KNOWLEDGE_BASE.map((item) => ({
    item,
    score: item.keywords.reduce((s, k) => s + (q.includes(k) ? k.length : 0), 0),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  return scored.map((x) => ({ title: x.item.title, content: x.item.content }))
}

/* ------------------------------------------------------------------ *
 * 工具定义（OpenAI Function Calling 格式）
 * ------------------------------------------------------------------ */
export const TOOL_SCHEMAS = {
  get_user_profile: {
    type: 'function',
    function: {
      name: 'get_user_profile',
      description: '获取当前老年用户的个人档案：年龄、性别、身高体重、BMI、确诊慢病类型、紧急联系人。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  get_health_records: {
    type: 'function',
    function: {
      name: 'get_health_records',
      description: '获取用户最近若干天的原始体征记录（血压、血糖、体重、步数、睡眠、运动、心率）。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '回溯天数，默认 7，最大 30' },
        },
        required: [],
      },
    },
  },
  analyze_vital_trends: {
    type: 'function',
    function: {
      name: 'analyze_vital_trends',
      description:
        '对全部体征指标执行统计分析：均值、极值、最小二乘趋势方向、达标率、异常持续天数、波动性。这是判断健康走向的权威依据。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  compute_health_score: {
    type: 'function',
    function: {
      name: 'compute_health_score',
      description: '计算当日综合健康评分（0-100）及分项得分明细。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  assess_risk: {
    type: 'function',
    function: {
      name: 'assess_risk',
      description:
        '基于最新体征与趋势执行分级风险评估。返回产品预警等级（提示 / 关注 / 预警 / 紧急，非医学危险分层）、风险清单，以及确定性规则的命中情况（R-BP-x / R-BG-x / R-WT-x）与依据生活画像生成的个性化建议。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  draft_intervention_plan: {
    type: 'function',
    function: {
      name: 'draft_intervention_plan',
      description:
        '结合用户疾病谱、BMI、年龄、生活画像与当前风险等级，生成个性化运动/饮食/用药提醒方案与量化目标。返回结果中的 personalization 字段即依据生活画像给出的个性化建议，输出措辞应优先采用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  raise_alert: {
    type: 'function',
    function: {
      name: 'raise_alert',
      description: '生成一条风险预警记录，用于推送给用户本人、家属或家庭医生。',
      parameters: {
        type: 'object',
        properties: {
          level: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description:
              '预警级别，依次对应产品等级：紧急 / 预警 / 关注 / 提示。不得使用「高危」等医学危险分层术语。',
          },
          title: { type: 'string', description: '预警标题，15 字以内' },
          detail: { type: 'string', description: '预警详情，说明触发依据' },
          action: { type: 'string', description: '建议立即采取的行动' },
          notify: {
            type: 'array',
            items: { type: 'string', enum: ['self', 'family', 'doctor'] },
            description:
              '通知对象。family / doctor 属于对外通知，需用户已授权且本人点击确认后才会真正外发，否则仅记录不外发。',
          },
          confirmed: {
            type: 'boolean',
            description: '用户是否已点击确认对外通知，默认 false（仅记录，不外发）',
          },
        },
        required: ['level', 'title', 'detail', 'action'],
      },
    },
  },
  schedule_reminder: {
    type: 'function',
    function: {
      name: 'schedule_reminder',
      description:
        '在**本次会话内**记录一条口头提醒（服药、测量、运动、饮水等）。' +
        '⚠️ 它不会持久化，也不会改变患者的每日任务、监测频次或提醒计划——' +
        '调用后**不得**对患者说「已排进每日提醒 / 已生效」；如需调整每日任务，只能告知「已提交医生审核」。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '提醒内容' },
          time: { type: 'string', description: '提醒时间，24 小时制 HH:mm' },
          repeat: { type: 'string', enum: ['once', 'daily', 'weekly'], description: '重复规则' },
        },
        required: ['text', 'time'],
      },
    },
  },
  list_badges: {
    type: 'function',
    function: {
      name: 'list_badges',
      description: '获取用户已获得的健康勋章列表，用于正向激励。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  list_recent_alerts: {
    type: 'function',
    function: {
      name: 'list_recent_alerts',
      description: '获取本次会话中已经产生的预警记录，避免重复报警。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  search_health_knowledge: {
    type: 'function',
    function: {
      name: 'search_health_knowledge',
      description: '检索内置的慢病健康知识库，获取权威的居家管理建议与指标参考范围。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词' } },
        required: ['query'],
      },
    },
  },
}

/** 为某个智能体组装其可用的工具 schema */
export function toolsForAgent(agent) {
  return (agent?.tools || []).map((name) => TOOL_SCHEMAS[name]).filter(Boolean)
}

/**
 * 创建工具执行器。每次请求创建一个独立闭包，内部维护本次会话的
 * 预警记录 / 提醒 / 工具调用副作用，保证服务端无状态。
 */
export function createToolExecutor(context = {}) {
  const records = normalizeRecords(context.records || [])
  const user = context.user || {}
  const badges = context.badges || []
  const alerts = []
  const reminders = []
  let cachedAnalysis = null
  let cachedRisk = null
  let cachedRules = null

  /** 把前端档案拼成规则引擎需要的病例结构 */
  const patient = {
    id: user.user_id || user.id || 'patient',
    profile: {
      emergencyContact: user.emergencyContact || { authorized: false },
    },
    medical: user.medical || {},
    lifestyle: user.lifestyle || {},
    badges: (badges || []).map((b) => ({ type: b.badge_type || b.badgeType })),
  }

  /** v2 确定性规则判定（与前端共用同一实现 src/utils/clinicalRules.js） */
  const getRules = () => {
    if (!cachedRules) cachedRules = evaluateClinicalRules(patient, records)
    return cachedRules
  }

  /** 按病例的个体化演示阈值覆盖指标参考模型（如李秀英空腹血糖 7.8） */
  const metaOf = (key) => {
    const base = VITAL_META[key]
    const t = user.medical?.demoThreshold || {}
    if (key === 'systolic_pressure' && t.systolic) return { ...base, target: Number(t.systolic) }
    if (key === 'diastolic_pressure' && t.diastolic) return { ...base, target: Number(t.diastolic) }
    if (key === 'blood_sugar' && t.fastingGlucose) return { ...base, target: Number(t.fastingGlucose) }
    return base
  }

  const getAnalysis = () => {
    if (!cachedAnalysis) {
      cachedAnalysis = Object.keys(VITAL_META)
        .map((k) => analyzeSeries(records, k, metaOf(k)))
        .filter((a) => a.available)
    }
    return cachedAnalysis
  }

  const getRisk = () => {
    // 复用同一份 clinicalRules 评估结果 —— 等级只有这一个来源（Step 11 · D-2）
    if (!cachedRisk) cachedRisk = assessRisk(records, user, getRules())
    return cachedRisk
  }

  const handlers = {
    get_user_profile: () => {
      // 兼容三种来源的字段命名：本地档案(name) / 数据库(user_name,userName)
      const height = Number(user.height) || 0
      const weight = Number(user.weight) || 0
      const bmi = user.bmi || (height > 0 ? Number((weight / (height / 100) ** 2).toFixed(1)) : null)
      const contact = user.emergencyContact

      return {
        name: user.name || user.user_name || user.userName || '未填写',
        age: user.age ?? '未填写',
        gender: user.gender ?? '未填写',
        height: user.height ?? '未填写',
        weight: user.weight ?? '未填写',
        waist: user.waist ?? '未填写',
        bmi: bmi ?? '未填写',
        diseaseTypes: user.disease_types || user.diseaseTypes || [],
        // v2：生活画像 —— AI 个性化建议必须引用这里的字段
        lifestyle: user.lifestyle
          ? {
              职业状态: user.lifestyle.occupation,
              饮食习惯: user.lifestyle.diet,
              运动习惯: user.lifestyle.exercise,
              睡眠: user.lifestyle.sleep,
              最大困难: user.lifestyle.biggestDifficulty,
              沟通风格: user.lifestyle.aiStyle,
            }
          : null,
        // v2：医学设定 —— 诊断 / 危险分层由医生侧表述，与产品预警等级分开
        medical: user.medical
          ? {
              主诊断: user.medical.primaryDisease,
              分级: user.medical.diseaseGrade,
              病程: user.medical.diseaseDuration,
              危险分层: user.medical.riskStratification,
              控制目标: user.medical.controlTarget,
              演示判定阈值: user.medical.demoThreshold,
            }
          : null,
        medications: (user.medications || []).map((m) => `${m.name} ${m.dosage} ${m.frequency}`),
        emergencyContact: contact
          ? `${contact.name}（${contact.relation}）${contact.phone}`
          : user.emergency_contact || user.phone || '未填写',
        emergencyContactAuthorized: Boolean(contact?.authorized),
      }
    },

    get_health_records: ({ days = 7 } = {}) => {
      const list = recentRecords(records, Math.min(Number(days) || 7, 30))
      return {
        total: list.length,
        days,
        records: list.map((r) => ({
          date: r.record_date,
          steps: r.steps,
          收缩压: r.systolic_pressure,
          舒张压: r.diastolic_pressure,
          血糖: r.blood_sugar,
          体重: r.weight,
          心率: r.heart_rate,
          运动分钟: r.exercise_minutes,
          睡眠: r.sleep_hours,
        })),
        consecutiveRecordDays: consecutiveRecordDays(records),
      }
    },

    analyze_vital_trends: () => ({
      sampleWindow: getAnalysis()[0]?.sampleCount ?? 0,
      indicators: getAnalysis().map((a) => ({
        indicator: a.label,
        unit: a.unit,
        mean: a.mean,
        latest: a.latest,
        range: `${a.min} ~ ${a.max}`,
        direction: { rising: '上升', falling: '下降', stable: '平稳' }[a.direction],
        r2: a.r2,
        达标率: `${a.complianceRate}%`,
        超标天数: a.warnDays + a.dangerDays,
        最长连续异常天数: a.longestAbnormalDays,
        改善中: a.improving === true ? '是' : a.improving === 'neutral' ? '不适用' : '否',
      })),
    }),

    compute_health_score: () => computeHealthScore(records, user),

    assess_risk: () => {
      const r = getRisk()
      const rules = getRules()
      return {
        // 产品预警等级词表（提示 / 关注 / 预警 / 紧急）—— 非医学危险分层
        // 等级**唯一来源** clinicalRules（Step 11 · D-2）；此处不再有第二套判定
        highestLevel: r.levelLabel,
        highestLevelKey: r.highestLevel,
        riskCount: r.risks.length,
        // 关注及以上的规则命中项 —— 与落库预警、医生端状态同一集合
        risks: r.risks.map((x) => ({
          ruleId: x.ruleId,
          level: x.levelLabel,
          title: x.title,
          basis: x.detail,
          action: x.action,
        })),
        // 描述性观察（心率 / 睡眠 / 体重波动 / 步数 / 记录中断）—— **不含等级**
        observations: r.observations.map((x) => ({
          title: x.title,
          detail: x.detail,
          action: x.action,
        })),
        // v2 确定性规则命中（R-BP-x / R-BG-x / R-WT-x）
        matchedRules: rules.matched.map((m) => ({
          ruleId: m.ruleId,
          name: m.name,
          level: m.levelLabel,
          basis: m.basis,
          action: m.action,
        })),
        ruleStats: rules.stats,
        personalization: rules.personalization.map((p) => p.text),
        emergencyContact: {
          authorized: rules.emergency.authorized,
          policy: rules.emergency.reason,
        },
      }
    },

    draft_intervention_plan: () => {
      const plan = draftInterventionPlan(user, getRisk(), getAnalysis())
      // 方案一旦生成，服药提醒即作为方案的附属动作被确定性创建，
      // 避免「有方案但没有提醒」的空档（模型是否调用 schedule_reminder 具有不确定性）。
      for (const m of plan.medicationReminders || []) {
        if (reminders.some((r) => r.text === m.name)) continue
        reminders.push({
          id: `reminder_${Date.now()}_${reminders.length}`,
          text: m.name,
          time: m.time,
          repeat: 'daily',
          tip: m.tip,
          source: 'planner',
        })
      }
      return plan
    },

    /**
     * 生成预警记录。
     * 合规约束（v2 第 4.1 节 R-BP-4）：通知紧急联系人属于敏感操作，
     * 必须「已授权 + 用户本人点击确认」双条件成立；未满足时只记录风险，
     * 不外发任何信息，并把待确认对象挂在 pendingNotify 上。
     */
    raise_alert: ({ level, title, detail, action, notify = ['self'], confirmed = false }) => {
      const policy = getRules().emergency
      const wantsExternal = notify.some((t) => t === 'family' || t === 'doctor')
      const externalAllowed = policy.authorized && Boolean(confirmed)
      const effectiveNotify = externalAllowed ? notify : notify.filter((t) => t === 'self')
      const blocked = wantsExternal && !externalAllowed

      const alert = {
        id: `alert_${Date.now()}_${alerts.length}`,
        level,
        // 标签**唯一来源**：clinicalRules 的 ALERT_LEVEL
        // （本工具入参仍沿用内部键位 critical/high/medium/low，只做键名翻译，不含阈值）
        levelLabel: ALERT_LEVEL[toProductLevel(level)]?.label || '提示',
        title,
        detail,
        action,
        notify: effectiveNotify,
        pendingNotify: blocked ? notify.filter((t) => t !== 'self') : [],
        externalNotifyBlocked: blocked,
        confirmed: externalAllowed,
        createdAt: new Date().toISOString(),
      }
      alerts.push(alert)
      return {
        created: true,
        alert,
        totalAlerts: alerts.length,
        notice: blocked
          ? '已记录风险。通知紧急联系人需用户已授权并由本人点击确认，本次未外发任何信息。'
          : undefined,
      }
    },

    list_recent_alerts: () => ({ count: alerts.length, alerts }),

    schedule_reminder: ({ text, time, repeat = 'daily' }) => {
      const reminder = { id: `reminder_${Date.now()}_${reminders.length}`, text, time, repeat }
      reminders.push(reminder)
      return { created: true, reminder }
    },

    list_badges: () => ({
      count: badges.length,
      badges: badges.map((b) => ({ name: b.badge_name, description: b.badge_description, points: b.points })),
    }),

    search_health_knowledge: ({ query }) => {
      const hits = searchHealthKnowledge(query)
      return hits.length ? { hit: true, results: hits } : { hit: false, message: '知识库中未检索到相关内容' }
    },
  }

  return {
    async execute(name, args) {
      const handler = handlers[name]
      if (!handler) throw new Error(`未知工具：${name}`)
      return handler(args || {})
    },
    /** 暴露副作用供编排器汇总 */
    effects: { alerts, reminders },
    analysis: getAnalysis,
    risk: getRisk,
    rules: getRules,
  }
}

export { VITAL_META }
