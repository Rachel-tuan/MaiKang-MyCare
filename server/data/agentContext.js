/**
 * 迈康 MyCare · 智能体上下文装配（第二阶段 Step 5）
 * ===========================================================================
 * 唯一职责：把 `patient_id` 变成智能体可用的运行上下文。
 *
 *   patient_id → dataProvider(getPatientProfile / getPatientRecords / getPatientBadges)
 *              → SQLite → context → Agent
 *
 * context 的结构与既有 `createToolExecutor(context)` 完全兼容：
 *   { patientId, user, records, badges }
 *   · user    = toUserProfileView(profile) 的派生视图（含 medical.demoThreshold、
 *               lifestyle.tags、emergencyContact.authorized 等规则引擎与工具所需字段）
 *   · records = daily_health_records 的派生视图（供趋势 / 规则引擎使用）
 *   · badges  = badges ⋈ badge_definitions（供 R-WT-5 / list_badges 使用）
 *   · user.memory           = 跨会话「弱记忆」（Step 13；过往诉求 + 医生最近结论，**纯读**）
 *   · user.extraScoreDimensions = 医生审结启用监测域带来的附加评分维度（Step 12）
 *
 * 铁律（Step 5 红线）：
 *   1. 前端**不再**把 records / profile / badges 传回后端；后端一律以 patient_id 自取。
 *   2. 患者不存在 → 由 getPatientProfile 抛 E_PATIENT_NOT_FOUND，**禁止**默认患者兜底。
 *   3. 本文件不计算任何阈值 / 等级 / 达标率 —— 判定仍由 src/utils/clinicalRules.js 执行，
 *      AI 只在既有结论上做自然语言表达。
 *   4. Step 13 的弱记忆同样是**只读派生**：本文件不因装配上下文而写任何一张表。
 */
import { getPatientProfile, toUserProfileView } from './dataProvider.js'
import { getPatientRecords, getPatientBadges, monthsSinceLatestHbA1c } from './patientService.js'
import { readActiveOverridePackage } from './taskOverrideService.js'
import { readPatientMemory } from './agentMemory.js'
import { evaluateClinicalRules } from '../../src/utils/clinicalRules.js'
import { extraDimensionsFromAddedTasks } from '../../src/utils/healthScore.js'

const DEFAULT_DAYS = 7

/**
 * 由 patient_id 装配 Agent 运行上下文。
 * @param {string} patientId
 * @param {{ days?: number }} [opts] 记录窗口天数，默认 7（与演示口径一致）
 */
export async function buildAgentContext(patientId, { days = DEFAULT_DAYS } = {}) {
  const n = Number(days)
  const windowDays = Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_DAYS

  // 患者不存在 → 此处抛 E_PATIENT_NOT_FOUND（不回落默认患者）
  const profile = await getPatientProfile(patientId)
  const user = toUserProfileView(profile)

  // R-BG-4 依赖「距上次 HbA1c 检测的月数」——与医生端同一口径的派生值（不落库）
  user.medical = {
    ...user.medical,
    hba1cLastTestMonthsAgo: monthsSinceLatestHbA1c(patientId),
  }

  // Step 12：医生审结新增的监测域 → 额外适用的评分维度。
  // 与前端 HomePage / 后端 aiScoreService 用**同一个**推导函数，
  // 保证「智能体口播的分数」与「界面上的分数」不会因为来源不同而分叉。
  user.extraScoreDimensions = extraDimensionsFromAddedTasks(
    readActiveOverridePackage(patientId)?.addedTasks
  )

  // Step 13：跨会话「弱记忆」——该患者过往诉求 + 医生最近结论。
  // **纯读**（复现 prescriptions / doctor_notes，见 agentMemory.js 红线），
  // 由 server/index.js 经 memoryPreamble() 注入系统提示词；不写入任何表。
  user.memory = readPatientMemory(patientId)

  const { records } = await getPatientRecords(patientId, windowDays)
  const badges = await getPatientBadges(patientId)

  return {
    patientId,
    user,
    records,
    // 规则引擎 R-WT-5 只用到 type；同时保留名称 / 积分供工具展示
    badges: badges.map((b) => ({ type: b.badge_type, name: b.badge_name, points: b.points })),
    window: { days: windowDays, anchorMode: 'latest' },
  }
}

/**
 * 轻量上下文：仅装配「档案视图」，供多模态解读等只需 age/diseases/bmi 的通道使用。
 * 仍然以 patient_id 为准，前端不回传任何档案字段。
 */
export async function buildVisionContext(patientId) {
  const profile = await getPatientProfile(patientId)
  return { patientId, user: toUserProfileView(profile) }
}

/**
 * 把 context 收敛成规则引擎需要的「病例对象」。
 * 只做字段搬运，**不改动**任何判定语义。
 */
export function toRulePatient(context = {}) {
  const user = context.user || {}
  return {
    id: context.patientId || user.user_id || null,
    profile: { emergencyContact: user.emergencyContact || { authorized: false } },
    medical: user.medical || {},
    lifestyle: user.lifestyle || {},
    badges: (context.badges || []).map((b) => ({ type: b.type || b.badge_type })),
  }
}

/**
 * 用确定性规则引擎评估当前上下文。
 * 返回 `evaluateClinicalRules` 的原始结果（matched / byId / highestLevel / stats / personalization /
 * emergency）。**数值、达标率、预警等级一律来自 clinicalRules，AI 不参与。**
 */
export function buildRuleEvaluation(context = {}) {
  return evaluateClinicalRules(toRulePatient(context), context.records || [])
}
