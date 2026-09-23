/**
 * 迈康 MyCare · AI 评分「三分层」唯一实现（Step 11 · Phase 3）
 * ===========================================================================
 * 红线（与 README / 方案 §4.1 一致，不得违背）：
 *
 *   AI **永远不能直接输出 0–100 分**。它只能输出结构化的 `adjustments`。
 *   最终合成必须由**确定性纯函数**完成；AI 辅助分**不是**临床判据，
 *   只用于向用户解释「规则分之外还看到了什么」。
 *
 * 三分层：
 *   L1 Rule Score       computeDailyHealthScore()          ← 完全确定性，**唯一正式分**
 *   L2 AI Assessment    模型 → adjustments[] + narrative    ← 生成式，可失败、不是分数
 *   L3 AI-assisted Score composeAssistedScore(rule, adj)    ← 纯函数合成，**辅助显示项**
 *
 * 本文件是纯函数模块：无副作用、不读环境、不落库、不调模型。
 * 前端（HomePage / HealthDataContext）与后端（aiScoreService）共用同一份实现，
 * 保证「界面上的 AI 辅助分」与「接口返回的 AI 辅助分」**必然一致**。
 *
 * ⚠️ AI 辅助分**绝不参与**预警等级、达标率、规则命中 —— 那三样只认 clinicalRules.js。
 */

/* ------------------------------------------------------------------ *
 * 约束常量（§4.3）
 * ------------------------------------------------------------------ */

/**
 * AI Assessment 的六条硬约束。任一条不满足 → **整包丢弃**，不做部分采纳。
 *
 * 「不做部分采纳」的理由：半截调整无法向用户解释「为什么这条生效那条没有」，
 * 且会让界面的「守恒」展示（assisted − rule === Σdelta）失真。
 */
export const AI_SCORE_CONSTRAINTS = Object.freeze({
  /** 单轮最多 4 条调整 */
  MAX_ADJUSTMENTS: 4,
  /** 单条 delta 下界（含） */
  DELTA_MIN: -5,
  /** 单条 delta 上界（含） */
  DELTA_MAX: 5,
  /** Σ|delta| 上界（含）—— 防止「拆分多条规避 ±5」 */
  MAX_ABS_DELTA_SUM: 10,
  /** reason 去空白后的长度区间（含端点） */
  REASON_MIN_LEN: 1,
  REASON_MAX_LEN: 80,
})

/** 模型可调整的维度枚举（与 healthScore 的 breakdown.key 同源） */
export const ADJUSTMENT_DIMENSIONS = Object.freeze([
  'steps',
  'bloodPressure',
  'bloodGlucose',
  'exercise',
])

/** 维度中文标签（界面与提示词共用，避免各写一套） */
export const DIMENSION_LABELS = Object.freeze({
  steps: '步数',
  bloodPressure: '血压',
  bloodGlucose: '血糖',
  exercise: '运动',
})

/** AI 层状态：ok = 有效调整 / unavailable = 拿不到意见 / rejected = 意见违反约束被丢 */
export const AI_STATUS = Object.freeze({
  OK: 'ok',
  UNAVAILABLE: 'unavailable',
  REJECTED: 'rejected',
})

/** 界面文案（唯一来源，前端不自行拼写） */
export const AI_STATUS_TEXT = Object.freeze({
  unavailable: 'AI 解读暂不可用',
  rejected: 'AI 建议未通过校验，已忽略',
})

/** 整包丢弃的原因码（供验收与「可展开看被拒原因」） */
export const ADJUSTMENT_REJECT_CODES = Object.freeze({
  E_ADJUSTMENTS_NOT_ARRAY: 'E_ADJUSTMENTS_NOT_ARRAY',
  E_TOO_MANY_ADJUSTMENTS: 'E_TOO_MANY_ADJUSTMENTS',
  E_UNKNOWN_DIMENSION: 'E_UNKNOWN_DIMENSION',
  E_DIMENSION_NOT_APPLICABLE: 'E_DIMENSION_NOT_APPLICABLE',
  E_DUPLICATE_DIMENSION: 'E_DUPLICATE_DIMENSION',
  E_DELTA_NOT_INTEGER: 'E_DELTA_NOT_INTEGER',
  E_DELTA_OUT_OF_RANGE: 'E_DELTA_OUT_OF_RANGE',
  E_REASON_INVALID: 'E_REASON_INVALID',
  E_DELTA_SUM_EXCEEDED: 'E_DELTA_SUM_EXCEEDED',
})

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * 稳定序列化：对象键按字典序递归排序，保证同样的数据永远得到同样的字符串
 * （JS 对象键序在跨进程/跨版本时不保证稳定，直接 JSON.stringify 会让哈希漂移）。
 */
export function stableStringify(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k])
      return out
    }
    if (typeof v === 'number' && !Number.isFinite(v)) return null
    return v === undefined ? null : v
  }
  return JSON.stringify(walk(value))
}

/**
 * FNV-1a 32 位哈希 → 8 位十六进制。
 * 不用 node:crypto —— 本模块要前后端共用，浏览器侧拿不到 crypto.createHash。
 * 用途仅为「缓存键」，不承担安全职责，32 位足够区分当日体征快照。
 */
export function fnv1a32(text) {
  let h = 0x811c9dc5
  const s = String(text)
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    // 乘以 16777619（FNV prime），用移位避免大整数精度丢失
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 只保留参与评分的当日体征字段（顺序无关，stableStringify 会排序） */
const HASH_VITAL_FIELDS = [
  'record_date',
  'steps',
  'systolic_pressure',
  'diastolic_pressure',
  'blood_sugar',
  'fasting_glucose',
  'exercise_minutes',
  'weight',
]

/**
 * 输入快照哈希 = 当日体征 + 疾病谱 + Rule Score 的稳定哈希。
 *
 * 语义（§4.5）：**inputHash 变化即缓存失效** —— 避免出现
 * 「数据变了、分数没变」这种比「重新生成后结果略有不同」更难解释的状态。
 *
 * @param {{ today?:object, diseases?:string[], ruleScore?:number }} p
 */
export function buildInputHash({ today = {}, diseases = [], ruleScore = 0 } = {}) {
  const vitals = {}
  for (const k of HASH_VITAL_FIELDS) {
    const v = today?.[k]
    if (v === undefined || v === null || v === '') continue
    vitals[k] = typeof v === 'number' ? v : String(v)
  }
  const list = Array.isArray(diseases) ? diseases.filter(Boolean).map(String) : []
  list.sort()
  return fnv1a32(
    stableStringify({ vitals, diseases: list, ruleScore: Number(ruleScore) || 0 }),
  )
}

/* ------------------------------------------------------------------ *
 * L2 → 校验（关口：模型给的东西能不能用）
 * ------------------------------------------------------------------ */

/**
 * 校验模型返回的 AI Assessment（§4.3 六条约束）。
 *
 * 返回值三态：
 *   · `{ ok:true,  adjustments:[...] }`                       —— 合法，可合成
 *   · `{ ok:false, structural:true,  code }`                  —— **结构不完整**（没有 adjustments 数组）
 *                                                                  → 调用方判为 `unavailable`
 *   · `{ ok:false, structural:false, code, rejected:[...] }`  —— **违反约束** → 调用方判为 `rejected`
 *
 * ⚠️ 结构性缺失与违反约束必须分开：前者是「模型没按格式输出」（等价于拿不到意见），
 * 后者是「模型给了意见但不合法」（要如实告诉用户它被丢了）。
 *
 * @param {object} raw                    模型返回的对象（可能来自 safeParseJSON 的 {text} 回落）
 * @param {{ applicableDimensions?: string[] }} opts
 *        applicableDimensions 省略/为空 → 只校验枚举，不校验「该患者是否适用」
 */
export function validateAdjustments(raw, { applicableDimensions } = {}) {
  const C = AI_SCORE_CONSTRAINTS
  const applicable = Array.isArray(applicableDimensions)
    ? applicableDimensions.filter((d) => ADJUSTMENT_DIMENSIONS.includes(d))
    : []

  const source = raw && typeof raw === 'object' ? raw : {}
  const arr = source.adjustments

  /* ① 结构性缺失 → unavailable（不是「被拒」） */
  if (!Array.isArray(arr)) {
    return {
      ok: false,
      structural: true,
      code: ADJUSTMENT_REJECT_CODES.E_ADJUSTMENTS_NOT_ARRAY,
      detail: '模型输出中没有 adjustments 数组',
      adjustments: [],
      rejected: [],
    }
  }

  const rejected = []
  const adjustments = []
  const seen = new Set()

  /* ② 条数上限 */
  if (arr.length > C.MAX_ADJUSTMENTS) {
    rejected.push({
      code: ADJUSTMENT_REJECT_CODES.E_TOO_MANY_ADJUSTMENTS,
      detail: `调整条数 ${arr.length} 超过上限 ${C.MAX_ADJUSTMENTS}`,
    })
  }

  /* ③ 逐条校验（任一条不合规 → 整包丢，故此处只收集，不提前返回） */
  arr.forEach((item, index) => {
    const it = item && typeof item === 'object' ? item : {}
    const rawDimension = it.dimension
    const dimension = typeof rawDimension === 'string' ? rawDimension.trim() : ''
    const { delta } = it
    const reason = typeof it.reason === 'string' ? it.reason.trim() : ''

    if (!ADJUSTMENT_DIMENSIONS.includes(dimension)) {
      rejected.push({
        index,
        code: ADJUSTMENT_REJECT_CODES.E_UNKNOWN_DIMENSION,
        detail: `未知维度 ${JSON.stringify(rawDimension)}`,
      })
      return
    }
    if (applicable.length > 0 && !applicable.includes(dimension)) {
      rejected.push({
        index,
        code: ADJUSTMENT_REJECT_CODES.E_DIMENSION_NOT_APPLICABLE,
        detail: `维度 ${dimension} 不在该患者适用维度 [${applicable.join(', ')}] 内`,
      })
      return
    }
    if (seen.has(dimension)) {
      rejected.push({
        index,
        code: ADJUSTMENT_REJECT_CODES.E_DUPLICATE_DIMENSION,
        detail: `维度 ${dimension} 重复出现（防拆分规避 ±5）`,
      })
      return
    }
    seen.add(dimension)

    if (typeof delta !== 'number' || !Number.isInteger(delta)) {
      rejected.push({
        index,
        code: ADJUSTMENT_REJECT_CODES.E_DELTA_NOT_INTEGER,
        detail: `delta 必须为整数，实际为 ${JSON.stringify(delta)}`,
      })
      return
    }
    if (delta < C.DELTA_MIN || delta > C.DELTA_MAX) {
      rejected.push({
        index,
        code: ADJUSTMENT_REJECT_CODES.E_DELTA_OUT_OF_RANGE,
        detail: `delta ${delta} 超出 [${C.DELTA_MIN}, ${C.DELTA_MAX}]`,
      })
      return
    }
    if (reason.length < C.REASON_MIN_LEN || reason.length > C.REASON_MAX_LEN) {
      rejected.push({
        index,
        code: ADJUSTMENT_REJECT_CODES.E_REASON_INVALID,
        detail: `reason 去空白后长度 ${reason.length} 不在 [${C.REASON_MIN_LEN}, ${C.REASON_MAX_LEN}]`,
      })
      return
    }

    adjustments.push({ dimension, label: DIMENSION_LABELS[dimension], delta, reason })
  })

  /* ④ Σ|delta| 上限（在「单条已合法」的集合上算） */
  const absSum = adjustments.reduce((n, a) => n + Math.abs(a.delta), 0)
  if (absSum > C.MAX_ABS_DELTA_SUM) {
    rejected.push({
      code: ADJUSTMENT_REJECT_CODES.E_DELTA_SUM_EXCEEDED,
      detail: `Σ|delta| = ${absSum} 超过上限 ${C.MAX_ABS_DELTA_SUM}`,
    })
  }

  if (rejected.length > 0) {
    /* 整包丢弃：不部分采纳 */
    return {
      ok: false,
      structural: false,
      code: rejected[0].code,
      detail: rejected[0].detail,
      adjustments: [],
      rejected,
    }
  }

  return { ok: true, structural: false, code: null, detail: null, adjustments, rejected: [] }
}

/* ------------------------------------------------------------------ *
 * L3 → 合成（纯函数，唯一算分的地方）
 * ------------------------------------------------------------------ */

/**
 * 合成 AI 辅助分。
 *
 *   Σdelta      = Σ adjustments[].delta
 *   rawAssisted = ruleScore + Σdelta
 *   assisted    = clamp(rawAssisted, 0, 100)
 *   clamped     = assisted !== rawAssisted
 *
 * **守恒断言**：`assisted − ruleScore === Σdelta`（当 `clamped === false`）。
 * 当 `clamped === true` 时守恒式**不成立**（如 rule=98, Σ=+10 → assisted=100 而 raw=108），
 * 此时必须**如实上报** `clamped` 与 `rawAssisted`，**不得静默**（否则界面会显示
 * 「规则基线 98 · AI 调整 +10 → 辅助分 100」，用户一算就知道对不上）。
 *
 * @param {number} ruleScore                    L1 Rule Score
 * @param {Array<{dimension?:string,delta:number}>} adjustments 已通过 validateAdjustments 的调整
 */
export function composeAssistedScore(ruleScore, adjustments = []) {
  const rule = Number.isFinite(Number(ruleScore)) ? Math.round(Number(ruleScore)) : 0
  const list = Array.isArray(adjustments) ? adjustments : []
  const sumDelta = list.reduce((n, a) => n + (Number.isFinite(Number(a?.delta)) ? Number(a.delta) : 0), 0)
  const rawAssisted = rule + sumDelta
  const assisted = clamp(rawAssisted, 0, 100)
  return {
    rule,
    assisted,
    rawAssisted,
    sumDelta,
    clamped: assisted !== rawAssisted,
  }
}

/**
 * 便捷组合：把「模型原始输出 + 该患者适用维度 + Rule Score」一步合成最终结果。
 * 后端路由与验收脚本共用，避免各处自己拼状态机。
 *
 * @returns {{
 *   aiStatus: 'ok'|'unavailable'|'rejected',
 *   ai: null | {
 *     assisted:number, rawAssisted:number, clamped:boolean, sumDelta:number,
 *     adjustments:Array, narrative:string, insights:string[]
 *   },
 *   code: string|null, detail: string|null, rejected: Array
 * }}
 */
export function buildAiAssessment(raw, { ruleScore, applicableDimensions } = {}) {
  const v = validateAdjustments(raw, { applicableDimensions })

  if (v.structural) {
    return {
      aiStatus: AI_STATUS.UNAVAILABLE,
      ai: null,
      code: v.code,
      detail: v.detail,
      rejected: [],
    }
  }

  if (!v.ok) {
    return {
      aiStatus: AI_STATUS.REJECTED,
      ai: null,
      code: v.code,
      detail: v.detail,
      rejected: v.rejected,
    }
  }

  const composed = composeAssistedScore(ruleScore, v.adjustments)
  const source = raw && typeof raw === 'object' ? raw : {}

  return {
    aiStatus: AI_STATUS.OK,
    ai: {
      assisted: composed.assisted,
      rawAssisted: composed.rawAssisted,
      clamped: composed.clamped,
      sumDelta: composed.sumDelta,
      adjustments: v.adjustments,
      // narrative / insights 是**纯解释**，不参与计分（§4.2）
      narrative: typeof source.narrative === 'string' ? source.narrative.slice(0, 400) : '',
      insights: Array.isArray(source.insights)
        ? source.insights.filter((s) => typeof s === 'string').slice(0, 6)
        : [],
    },
    code: null,
    detail: null,
    rejected: [],
  }
}

export default {
  AI_SCORE_CONSTRAINTS,
  ADJUSTMENT_DIMENSIONS,
  DIMENSION_LABELS,
  AI_STATUS,
  AI_STATUS_TEXT,
  ADJUSTMENT_REJECT_CODES,
  validateAdjustments,
  composeAssistedScore,
  buildAiAssessment,
  buildInputHash,
  stableStringify,
  fnv1a32,
}
