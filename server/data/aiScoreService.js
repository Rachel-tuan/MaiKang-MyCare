/**
 * 迈康 MyCare · AI 评分服务层（Step 11 · Phase 3）
 * ===========================================================================
 * 职责：拿到「当日体征 + 疾病谱 + Rule Score」→ 请模型给出结构化 `adjustments`
 *       → 交给 `src/utils/aiScore.js` 的确定性纯函数校验 + 合成。
 *
 * 红线（逐条对应方案 §4 与 §6）：
 *   1. 本文件**绝不写任何表** —— AI 评分不落库（D7/P4），只做进程内当日缓存。
 *   2. 模型**永远不能直接输出分数**：提示词明令禁止，且 `buildAiAssessment` 只认
 *      `adjustments`，模型若返回 `score` 字段会被直接忽略（不在白名单内）。
 *   3. 一切降级**一律回落 Rule Score**：`unavailable` / `rejected` 都不产生 AI 辅助分。
 *   4. AI 辅助分**不参与**预警等级 / 达标率 / 规则命中 —— 本文件不碰 clinicalRules，
 *      也不回写任何规则常量（验收第 15 条锁死）。
 *   5. 「当日」口径与前端 `getTodayData()` / 晨报 / `verify-health-score` **完全一致**：
 *      基准日恒为**真实今天**（东八区 `todayCST()`），与今日任务同源。
 *      旧实现取「记录窗口内日期最大的一行」，今天还没录入时会把历史某天当成「今日」，
 *      既与今日任务矛盾，也让未录入的维度白送满分（红线 10 同类缺陷）。
 *
 * 缓存策略（§4.5）：
 *   · 键 = `patientId | date | inputHash`，`inputHash` 含当日体征 + 疾病谱 + Rule Score，
 *     **输入一变即失效** —— 避免「数据变了分数没变」这种更难解释的状态。
 *   · 只缓存**确定性结果**（ok / rejected）：同样的输入与同样的模型必然得到同样的包。
 *   · **不缓存 unavailable**：它多半是瞬时故障（超时 / 401 / 配额），下次挂载应当重试；
 *     而「模型未配置」本身是一次布尔判断，重试成本为零。
 */

import {
  chatJSON,
  isModelConfigured,
  resolveFallback,
  resolveFallbackOnError,
} from '../deepseek.js'
import { config } from '../config.js'
import { getPatientProfile, toUserProfileView, todayCST } from './dataProvider.js'
import { getPatientRecords } from './patientService.js'
import { readActiveOverridePackage } from './taskOverrideService.js'
import { computeDailyHealthScore, extraDimensionsFromAddedTasks } from '../../src/utils/healthScore.js'
import {
  AI_SCORE_CONSTRAINTS,
  AI_STATUS,
  AI_STATUS_TEXT,
  DIMENSION_LABELS,
  buildAiAssessment,
  buildInputHash,
} from '../../src/utils/aiScore.js'

/* ------------------------------------------------------------------ *
 * 进程内缓存（不落库）
 * ------------------------------------------------------------------ */

/** key → { aiStatus, ai, code, detail, rejected, generatedAt, model, inputHash } */
const cache = new Map()
const MAX_CACHE_ENTRIES = 200

/** 仅供验收脚本使用：清空进程内缓存 */
export function clearAiScoreCache() {
  cache.clear()
}

/** 当前缓存条目数（验收断言用，避免脚本去摸内部结构） */
export function aiScoreCacheSize() {
  return cache.size
}

function cacheKeyOf(patientId, date, inputHash) {
  return `${patientId}|${date}|${inputHash}`
}

function remember(key, entry) {
  cache.set(key, entry)
  // 极简 LRU：超限时删掉最早插入的一条（演示规模下不会触发）
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

/**
 * 只读缓存查询（GET 路由专用）：**不触发模型调用**。
 *
 * 必须先把当前输入快照的 `inputHash` 算出来再去命中缓存 —— 只按 patientId 找，
 * 会把「昨天 / 旧数据」的 AI 分返回给今天，这是最容易发生的静默错误。
 *
 * @returns {{ snapshot:object, inputHash:string, hit:object|null }}
 */
export async function readScoreCache(patientId, date) {
  const snapshot = await buildScoreSnapshot(patientId, date)
  const inputHash = buildInputHash({
    today: snapshot.today,
    diseases: snapshot.diseases,
    ruleScore: snapshot.rule.score,
  })
  const hit = cache.get(cacheKeyOf(patientId, snapshot.date, inputHash)) || null
  return { snapshot, inputHash, hit }
}

/* ------------------------------------------------------------------ *
 * 输入快照（与前端 / 晨报同口径）
 * ------------------------------------------------------------------ */

/**
 * 组装评分输入快照。
 * @param {string} patientId
 * @param {string} [date] 指定日期（省略 = **真实今天**，与界面 / 今日任务同源）
 */
export async function buildScoreSnapshot(patientId, date) {
  const profile = await getPatientProfile(patientId)
  const view = toUserProfileView(profile)
  const diseases = Array.isArray(view?.diseases) ? view.diseases : []

  const { records } = await getPatientRecords(patientId, 7)
  const rows = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.record_date)
    .sort((a, b) => String(a.record_date).localeCompare(String(b.record_date)))

  // ⚠️ 基准日恒为「真实今天」（或调用方显式指定的日期），**不得**回落到
  // 「窗口内日期最大的一行」：那会让「今日评估」实际读昨天的步数 —— 与今日任务
  // 矛盾，且今日未录入的维度被历史值顶上（红线 10 同类缺陷）。
  const baseDate = date ? String(date) : todayCST()
  const today = rows.find((r) => r.record_date === baseDate) || {}

  // ⚠️ Rule Score 的唯一实现在 src/utils/healthScore.js，此处**只是调用方**。
  // Step 12：医生审结新增的监测域同时计入评分适用维度（分母），
  // 来源是**同一份**生效覆盖包的 addedTasks —— 与前端使用同一个推导函数，故两侧必然一致。
  const activePkg = readActiveOverridePackage(patientId)
  const extraDimensions = extraDimensionsFromAddedTasks(activePkg?.addedTasks)
  const rule = computeDailyHealthScore({ today, diseases, extraDimensions })

  return {
    date: today.record_date || baseDate,
    today,
    diseases,
    recent: rows.slice(-7),
    rule,
    /** 该患者**适用维度** = 规则分母里实际出现的维度（决定 AI 能调哪几项） */
    applicableDimensions: rule.breakdown.map((d) => d.key),
    /** Step 12：其中由「医生审结新增监测域」带来的维度（供提示词与验收区分来源） */
    doctorOrderDimensions: extraDimensions,
  }
}

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

const fmt = (v, suffix = '') => (v === null || v === undefined || v === '' ? '未记录' : `${v}${suffix}`)

/**
 * 组装提示词。
 * 关键约束（与 §4.2 / §4.3 一一对应）：
 *   · 明确告知「你**不负责给分**」，从源头掐掉模型输出 0–100 分的冲动；
 *   · 维度枚举**动态下发**为「该患者适用维度」，模型不可能猜出一个不适用项（猜了也会被校验拦下）；
 *   · 把 6 条硬约束原文写进提示词 —— 校验器仍然是最终裁判，提示词只是降低重试率。
 */
export function buildAiScorePrompt({
  diseases,
  today,
  recent,
  rule,
  applicableDimensions,
  doctorOrderDimensions = [],
}) {
  const applicable = applicableDimensions.map((k) => `${k}（${DIMENSION_LABELS[k] || k}）`).join('、')
  const byDoctorOrder = (Array.isArray(doctorOrderDimensions) ? doctorOrderDimensions : [])
    .map((k) => `${k}（${DIMENSION_LABELS[k] || k}）`)
    .join('、')

  const system = [
    '你是「迈康 MyCare」慢病管理系统的健康数据分析助手。',
    '',
    '【最重要的前提】你**不负责给分**。系统已经用确定性临床规则算出了 Rule Score，',
    '你的职责**只是**指出规则分之外你额外观察到的、值得让患者知道的信息。',
    '你**绝对不能**输出任何 0–100 的分数，也**绝对不能**建议修改任何医学阈值',
    '（血压控制目标、血糖控制目标等）—— 阈值只能由医生设定。',
    '',
    '【输出格式】只输出一个 JSON 对象，不要 markdown 代码块，不要任何额外文字：',
    '{"adjustments":[{"dimension":"维度","delta":整数,"reason":"依据"}],"narrative":"可选一句话","insights":["可选要点"]}',
    '',
    `【dimension】只能从以下枚举中取（这是该患者适用维度）：${applicable}`,
    ...(byDoctorOrder
      ? [
          `【注意】其中 ${byDoctorOrder} 是**医生审结新增的监测项**（并非诊断派生）。` +
            '当当天没有该项记录时，按「未记录」如实描述，并可以指出「医生已要求监测、但今日尚未记录」，' +
            '不要把它说成患者已有的疾病诊断。',
        ]
      : []),
    `【delta】必须是 [${AI_SCORE_CONSTRAINTS.DELTA_MIN}, ${AI_SCORE_CONSTRAINTS.DELTA_MAX}] 之间的**整数**，` +
      '正数表示「规则分低估了患者」，负数表示「规则分高估了患者」。',
    `【条数】最多 ${AI_SCORE_CONSTRAINTS.MAX_ADJUSTMENTS} 条；同一 dimension 不得重复出现；` +
      `所有 delta 绝对值之和不得超过 ${AI_SCORE_CONSTRAINTS.MAX_ABS_DELTA_SUM}。`,
    `【reason】必须非空、不超过 ${AI_SCORE_CONSTRAINTS.REASON_MAX_LEN} 个字，写清楚你依据的是哪几天、哪个指标。`,
    '',
    '【什么时候不该调整】如果规则分已经足够贴合当日数据，就返回 {"adjustments":[]}。',
    '宁可不调整，也不要为了凑数编一条理由。',
    '',
    '【时间口径】所有「今日 / 今天 / 当日」都指【当日体征】标题里给出的**评分基准日**，' +
      '不要另行推算日期。若该基准日没有记录，就按「未记录」描述，' +
      '**不要把前几天的数值说成今天发生的**。',
  ].join('\n')

  const recentLines = recent
    .map(
      (r) =>
        `  ${r.record_date}  步数 ${fmt(r.steps)}  血压 ${fmt(r.systolic_pressure)}/${fmt(r.diastolic_pressure)}` +
        `  血糖 ${fmt(r.blood_sugar ?? r.fasting_glucose)}  运动 ${fmt(r.exercise_minutes, '分钟')}  体重 ${fmt(r.weight, 'kg')}`,
    )
    .join('\n')

  const breakdownLines = rule.breakdown
    .map((d) => `  ${d.label}：${d.earned}/${d.weight}（${d.status === 'missing' ? '未记录' : d.detail}）`)
    .join('\n')

  const user = [
    '【疾病谱】' + (diseases.length ? diseases.join('、') : '无'),
    '',
    '【当日体征（评分基准日 ' + (today.record_date || '—') + '）】',
    `  步数 ${fmt(today.steps)}  血压 ${fmt(today.systolic_pressure)}/${fmt(today.diastolic_pressure)}` +
      `  血糖 ${fmt(today.blood_sugar ?? today.fasting_glucose)}  运动 ${fmt(today.exercise_minutes, '分钟')}` +
      `  体重 ${fmt(today.weight, 'kg')}`,
    '',
    '【近 7 日记录】',
    recentLines || '  （无）',
    '',
    '【系统已算出的 Rule Score】' + rule.score + ' 分（' + rule.grade + '），分母 ' + rule.applicableWeight + ' 分',
    '【Rule Score 分项】',
    breakdownLines,
    '【未录入项】' + (rule.missing.length ? rule.missing.join('、') : '无'),
    '',
    '请基于以上数据，按格式给出你的 adjustments（没有补充观察就返回空数组）。',
  ].join('\n')

  return { system, user }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

function degrade(status, code, detail, { model = null, rejected = [] } = {}) {
  return {
    aiStatus: status,
    ai: null,
    code,
    detail,
    rejected,
    generatedAt: new Date().toISOString(),
    model,
  }
}

/**
 * 计算某患者的「Rule Score + AI 辅助分」。
 *
 * @param {string} patientId
 * @param {{ date?:string, force?:boolean, snapshot?:object }} [opts]
 *        force=true 跳过缓存（仅验收脚本用）
 * @returns {Promise<object>} 见文件末尾的返回结构说明
 */
export async function computeAiScore(patientId, { date, force = false, snapshot: provided } = {}) {
  const snap = provided || (await buildScoreSnapshot(patientId, date))
  const { rule, today, diseases, recent, applicableDimensions, doctorOrderDimensions = [] } = snap

  const inputHash = buildInputHash({
    today,
    diseases,
    ruleScore: rule.score,
  })
  const key = cacheKeyOf(patientId, snap.date, inputHash)

  const base = {
    patientId,
    date: snap.date,
    inputHash,
    rule: rule.score,
    ruleGrade: rule.grade,
    ruleBreakdown: rule.breakdown,
    applicableDimensions,
    // Step 12：其中由「医生审结新增监测域」带来的维度（提示词据此区分来源）
    doctorOrderDimensions,
  }

  /* ---- 缓存命中 ---- */
  if (!force) {
    const hit = cache.get(key)
    if (hit) {
      return {
        ...base,
        aiStatus: hit.aiStatus,
        ai: hit.ai,
        code: hit.code,
        detail: hit.detail,
        rejected: hit.rejected,
        aiMessage: hit.aiStatus === AI_STATUS.OK ? null : AI_STATUS_TEXT[hit.aiStatus] || null,
        model: hit.model,
        cached: true,
        generatedAt: hit.generatedAt,
      }
    }
  }

  /* ---- 模型可用性 ---- */
  if (!isModelConfigured()) {
    // allowMockFallback=false 时 resolveFallback 会抛 503（排障开关语义：确认 Key 有没有被读到）。
    // AI 评分没有「本地推理引擎」可回落，故正常模式下直接判为 unavailable —— 页面只显示 Rule Score。
    resolveFallback('AI 评分')
    const entry = degrade(
      AI_STATUS.UNAVAILABLE,
      'E_MODEL_NOT_CONFIGURED',
      '未检测到 DEEPSEEK_API_KEY，AI 解读不可用（Rule Score 不受影响）',
    )
    return {
      ...base,
      ...entry,
      aiMessage: AI_STATUS_TEXT[AI_STATUS.UNAVAILABLE],
      cached: false,
    }
  }

  /* ---- 调用模型 ---- */
  let raw
  const { system, user } = buildAiScorePrompt({
    diseases,
    today,
    recent,
    rule,
    applicableDimensions,
    doctorOrderDimensions,
  })
  try {
    raw = await chatJSON({ system, user, temperature: 0.2 })
  } catch (err) {
    // allowMockFallback=false → 原样抛出真实故障（401 / 超时 / 配额），不掩盖原因
    resolveFallbackOnError(err)
    const entry = degrade(
      AI_STATUS.UNAVAILABLE,
      'E_MODEL_CALL_FAILED',
      `模型调用失败：${String(err?.message || err).slice(0, 200)}`,
      { model: config.model },
    )
    return {
      ...base,
      ...entry,
      aiMessage: AI_STATUS_TEXT[AI_STATUS.UNAVAILABLE],
      cached: false,
    }
  }

  /* ---- 确定性校验 + 合成（唯一算分处） ---- */
  const assessed = buildAiAssessment(raw, {
    ruleScore: rule.score,
    applicableDimensions,
  })

  const entry = {
    aiStatus: assessed.aiStatus,
    ai: assessed.ai,
    code: assessed.code,
    detail: assessed.detail,
    rejected: assessed.rejected,
    generatedAt: new Date().toISOString(),
    model: config.model,
  }

  // 只缓存确定性结果（ok / rejected）；unavailable 属瞬时故障，下次重试
  if (assessed.aiStatus !== AI_STATUS.UNAVAILABLE) {
    remember(key, { ...entry, inputHash })
  }

  return {
    ...base,
    ...entry,
    aiMessage: assessed.aiStatus === AI_STATUS.OK ? null : AI_STATUS_TEXT[assessed.aiStatus] || null,
    cached: false,
  }
}

/**
 * 返回结构（POST /api/agent/score 与 GET /api/patients/:id/score 共用）：
 *
 * {
 *   patientId, date, inputHash,
 *   rule, ruleGrade, ruleBreakdown, applicableDimensions,   // L1 · 唯一正式分
 *   aiStatus: 'ok' | 'unavailable' | 'rejected',             // L2 状态
 *   ai: null | { assisted, rawAssisted, clamped, sumDelta,   // L3 · 辅助显示项
 *                adjustments:[{dimension,label,delta,reason}], narrative, insights },
 *   code, detail, rejected,                                  // 降级/被拒的如实上报
 *   aiMessage,                                               // 界面文案（唯一来源）
 *   model, cached, generatedAt
 * }
 */
export default computeAiScore
