/**
 * 迈康 MyCare · 确定性「当日健康评分」唯一实现（Step 10）
 * ===========================================================================
 * 定位：与 clinicalRules.js / dailyTasks.js 同一模式 —— **前端与后端共用同一份实现**。
 *   服务端智能体工具 compute_health_score 与前端 HealthDataContext.getHealthScore
 *   都调用本文件，保证「用户界面上看到的分数」与「智能体口播的分数」**必然一致**。
 *
 * 口径（Step 10 修订，修正此前「缺测 = 满分」的缺陷）：
 *   1. **分母固定**为该患者「适用维度」的权重之和，**不随当日是否有数据漂移**。
 *      修订前是「有数据才把该维度计入分母」，于是没测血压 / 没测血糖时这些维度
 *      既不进分子也不进分母 —— 极端情况下（当天只走了步数、血压血糖全没测）
 *      会算出 100 分「优秀」，与同屏的「风险等级：预警」自相矛盾。
 *   2. **适用维度由疾病谱决定**：血压系疾病 → 计血压；血糖系疾病 → 计血糖；
 *      步数与运动属慢病管理通用项，恒计。因此不吃降糖药的患者不会因为
 *      「本来就不需要测血糖」而被扣分。
 *   3. 已录入但未达标 → 按阶梯拿部分分；**未录入 → 该维度记 0 分并标 missing**，
 *      界面据此解释「分是怎么扣的」。
 *   4. 权重与阶梯是**本项目 Demo 规则**，非临床指南，不可对外表述为医学标准。
 *
 * 纯函数、无副作用、不读环境、不落库。
 */

/* ------------------------------------------------------------------ *
 * 权重与分档
 * ------------------------------------------------------------------ */

/** 各维度满分权重（合计与「全维度适用」时的 100 分对齐：30+25+25+20） */
export const SCORE_WEIGHTS = Object.freeze({
  steps: 30,
  bloodPressure: 25,
  bloodGlucose: 25,
  exercise: 20,
})

/** 分档阈值（降序，取第一个 score >= min 的档） */
export const SCORE_GRADES = Object.freeze([
  { min: 85, label: '优秀' },
  { min: 70, label: '良好' },
  { min: 55, label: '一般' },
  { min: 0, label: '需干预' },
])

/**
 * 维度适用性关键字 —— 疾病谱按「关键字包含匹配」判定
 * （真实病历病名常带分级前缀，如「原发性高血压」「2 型糖尿病」，不可用全等比较）。
 * 与 tools.js 的 DISEASE_KEYWORD、dailyTasks.js 的疾病判定保持同一思路。
 */
export const DIMENSION_KEYWORDS = Object.freeze({
  bloodPressure: ['高血压', '血压', '代谢综合征'],
  bloodGlucose: ['糖尿病', '血糖'],
})

/**
 * 监测任务 → 评分维度（Step 12）。
 * ------------------------------------------------------------------
 * 医生审结「同意新增监测项」后，该监测域**同时**成为评分适用维度 ——
 * 口径与疾病谱一致：**既然医生要求了这项监测，当天没测就应当体现在分数里**，
 * 否则会出现「任务卡片写着要测血糖、分数却完全不看血糖」的自相矛盾。
 *
 * 只有与评分维度对应的两个监测域在这里注册；`weight_record` 没有评分维度，故不在列。
 */
export const MONITOR_TASK_SCORE_DIMENSION = Object.freeze({
  bp_monitor: 'bloodPressure',
  bg_monitor: 'bloodGlucose',
})

/**
 * 从覆盖包的 `addedTasks` 推导「额外适用的评分维度」（**前后端唯一实现**）。
 *
 * 输入必须是**已校验**的 addedTasks（见 taskOverride.validateOverridePackage）；
 * 本函数只做映射，不重复裁定合法性。
 *
 * @param {Array<{taskId?:string}>} addedTasks
 * @returns {string[]} 形如 ['bloodGlucose']，顺序稳定
 */
export function extraDimensionsFromAddedTasks(addedTasks) {
  const out = new Set()
  for (const item of Array.isArray(addedTasks) ? addedTasks : []) {
    const d = MONITOR_TASK_SCORE_DIMENSION[item?.taskId]
    if (d) out.add(d)
  }
  return [...out]
}

/** 分数 → 档位文案 */
export function gradeOf(score) {
  const s = Number(score) || 0
  return (SCORE_GRADES.find((g) => s >= g.min) || SCORE_GRADES[SCORE_GRADES.length - 1]).label
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : 0
}

const listOf = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : [])

const matchKeyword = (diseases, keywords) =>
  listOf(diseases).some((d) => keywords.some((kw) => String(d).includes(kw)))

/** 步数 → 达成率（< 4000 步按线性给分，且封顶在 0.4，防止 9999 步越过 6000 步档） */
function ratioSteps(v) {
  const s = num(v)
  if (s >= 10000) return 1
  if (s >= 8000) return 0.85
  if (s >= 6000) return 0.68
  if (s >= 4000) return 0.5
  return Math.min(s / 10000, 0.4)
}

/** 血压 → 达成率；未录入返回 null（调用方记 0 分并标 missing） */
function ratioBloodPressure(systolic, diastolic) {
  const sp = num(systolic)
  const dp = num(diastolic)
  if (!sp || !dp) return null
  if (sp <= 140 && dp <= 90) return 1
  if (sp <= 160 && dp <= 100) return 0.6
  return 0.2
}

/** 血糖 → 达成率；未录入返回 null */
function ratioBloodGlucose(v) {
  const bs = num(v)
  if (!bs) return null
  if (bs <= 7) return 1
  if (bs <= 8) return 0.8
  if (bs <= 10) return 0.6
  return 0.2
}

/** 运动分钟数 → 达成率；0 分钟计 0 分（不做「没记录也给保底分」的白送） */
function ratioExercise(v) {
  const m = num(v)
  if (m >= 60) return 1
  if (m >= 30) return 0.75
  if (m >= 15) return 0.5
  if (m > 0) return 0.3
  return 0
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 计算某患者「当日」健康评分。
 *
 * @param {object}   p
 * @param {object}   p.today     当日体征（字段名与 daily_health_records 一致）
 *                               { steps, systolic_pressure, diastolic_pressure, blood_sugar, exercise_minutes }
 * @param {string[]} p.diseases  疾病谱（决定哪些维度适用）
 * @param {string[]} [p.extraDimensions] 额外适用的维度键（Step 12：医生审结启用的监测域）。
 *                               来源必须是覆盖包的 `addedTasks`，用
 *                               `extraDimensionsFromAddedTasks()` 推导，前后端同一份实现。
 * @returns {{
 *   score: number,             // 0-100（已按适用维度归一化，满分即 100）
 *   grade: string,             // 优秀 / 良好 / 一般 / 需干预
 *   applicableWeight: number,  // 分母：适用维度权重之和
 *   earnedWeight: number,      // 分子：各维度实得权重之和
 *   missing: string[],         // 未录入的适用维度中文名
 *   breakdown: Array<{ key:string, label:string, weight:number, earned:number,
 *                      ratio:number, status:'ok'|'partial'|'missing'|'none', detail:string,
 *                      source:'always'|'diagnosis'|'doctorOrder' }>
 * }}
 */
export function computeDailyHealthScore({ today = {}, diseases = [], extraDimensions = [] } = {}) {
  const t = today || {}
  const extra = Array.isArray(extraDimensions) ? extraDimensions : []
  const byDiagnosisBp = matchKeyword(diseases, DIMENSION_KEYWORDS.bloodPressure)
  const byDiagnosisBg = matchKeyword(diseases, DIMENSION_KEYWORDS.bloodGlucose)
  // 适用 = 疾病谱命中 **或** 医生审结启用了对应监测域（Step 12）。
  // ⚠️ 两者都不命中时**绝不**把维度计入分母 —— 分母仍由「适用性」唯一决定，不随当日数据漂移。
  const hasBp = byDiagnosisBp || extra.includes('bloodPressure')
  const hasBg = byDiagnosisBg || extra.includes('bloodGlucose')

  const breakdown = []

  const push = ({ key, label, weight, ratio, status, detail, source = 'always' }) => {
    const r = ratio === null || ratio === undefined ? 0 : Math.max(0, Math.min(1, ratio))
    breakdown.push({
      key,
      label,
      weight,
      ratio: r,
      earned: Math.round(weight * r * 100) / 100,
      status,
      detail,
      // 'always' 通用项 / 'diagnosis' 疾病谱命中 / 'doctorOrder' 医生审结启用（Step 12）
      source,
    })
  }

  /* 步数（通用项，恒计） */
  const steps = num(t.steps)
  push({
    key: 'steps',
    label: '步数',
    weight: SCORE_WEIGHTS.steps,
    ratio: ratioSteps(steps),
    status: steps >= 10000 ? 'ok' : steps > 0 ? 'partial' : 'missing',
    detail: steps > 0 ? `${steps.toLocaleString('zh-CN')} 步` : '今日未记录',
  })

  /* 血压（仅在疾病谱命中时计入分母） */
  if (hasBp) {
    const sp = num(t.systolic_pressure)
    const dp = num(t.diastolic_pressure)
    const ratio = ratioBloodPressure(sp, dp)
    push({
      key: 'bloodPressure',
      label: '血压',
      weight: SCORE_WEIGHTS.bloodPressure,
      ratio,
      status: ratio === null ? 'missing' : ratio >= 1 ? 'ok' : 'partial',
      detail:
        ratio === null
          ? byDiagnosisBp
            ? '今日未记录'
            : '今日未记录（医生已要求监测）'
          : `${sp}/${dp} mmHg`,
      source: byDiagnosisBp ? 'diagnosis' : 'doctorOrder',
    })
  }

  /* 血糖（仅在疾病谱命中时计入分母） */
  if (hasBg) {
    const bs = num(t.blood_sugar)
    const ratio = ratioBloodGlucose(bs)
    push({
      key: 'bloodGlucose',
      label: '血糖',
      weight: SCORE_WEIGHTS.bloodGlucose,
      ratio,
      status: ratio === null ? 'missing' : ratio >= 1 ? 'ok' : 'partial',
      detail:
        ratio === null
          ? byDiagnosisBg
            ? '今日未记录'
            : '今日未记录（医生已要求监测）'
          : `${bs} mmol/L`,
      source: byDiagnosisBg ? 'diagnosis' : 'doctorOrder',
    })
  }

  /* 运动（通用项，恒计） */
  const ex = num(t.exercise_minutes)
  push({
    key: 'exercise',
    label: '运动',
    weight: SCORE_WEIGHTS.exercise,
    ratio: ratioExercise(ex),
    status: ex >= 60 ? 'ok' : ex > 0 ? 'partial' : 'missing',
    detail: ex > 0 ? `${ex} 分钟` : '今日未记录',
  })

  const applicableWeight = breakdown.reduce((n, d) => n + d.weight, 0)
  const earnedWeight = Math.round(breakdown.reduce((n, d) => n + d.earned, 0) * 100) / 100
  const score = applicableWeight > 0 ? Math.round((earnedWeight / applicableWeight) * 100) : 0

  return {
    score,
    grade: gradeOf(score),
    applicableWeight,
    earnedWeight,
    missing: breakdown.filter((d) => d.status === 'missing').map((d) => d.label),
    breakdown,
  }
}

export default computeDailyHealthScore
