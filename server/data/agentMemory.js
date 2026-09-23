/**
 * 迈康 MyCare · 智能体「弱记忆」读取（Step 13）
 * ===========================================================================
 * 背景：此前对话**完全不落库、也不形成记忆** —— 前端 `chats` 是 React 内存态，
 *       后端只把前端传来的最近 10 条原文拼进 messages 用完即丢，且没有任何会话表。
 *       结果是「同一位患者第 1 轮与第 100 轮拿到的背景信息完全一样」，
 *       患者上一轮说过的诉求（如「我想每天测血糖」）下一轮就消失了。
 *
 * 本模块给智能体补一层**只读**的跨会话延续性：
 *   patient_id → prescriptions（该患者的提案行，含患者原话 + 审结状态）
 *              + doctor_notes（医生对该患者的最近结论）
 *              → 有界的「历史上下文」视图 → 注入系统提示词
 *
 * 七条红线（不得违反）：
 *   1. **纯读、零写**。本文件只有 SELECT，没有任何 INSERT/UPDATE/DELETE；
 *      22 张 P0 表集**不新增表、不加列**（复用既有 `prescriptions` / `doctor_notes`）。
 *   2. **按 patient_id 取，绝不跨患者**。查询一律带 `patient_id = ?`；
 *      患者不存在 → 由底层抛 `E_PATIENT_NOT_FOUND`，**禁止**回落示范患者。
 *   3. **不得出现任何阈值 / 等级 / 达标率**。这里只搬运两类事实：
 *      「患者说过什么」「医生下过什么结论」；数值判定仍由 `clinicalRules.js` 唯一裁定。
 *      申请描述刻意**不带 proposedValue**，避免历史数值被当成当前值。
 *   4. **有界**。诉求 ≤3 条、结论 ≤2 条，单条按字数截断 —— 记忆不许无限膨胀提示词。
 *   5. **只作历史参考**。生成的提示词块必须显式声明「这不是本次新信息、可能已过期、
 *      要当前值必须调工具查」，防止模型拿旧记忆当现状（典型错法：把上次的步数目标
 *      当成今天的任务目标念出来）。
 *   6. **空记忆不注入**。无任何记录时返回空串，避免往提示词里塞噪声。
 *   7. **只渲染日期、不渲染时刻**。⚠️ 既有实现里两张表的时间基不同：
 *      `prescriptions.generated_date` 由读写方用 `new Date().toISOString()` 写入（UTC），
 *      而 `doctor_notes.created_at` 走 schema 默认 `strftime(...,'localtime')`（东八区）。
 *      同一个动作在两张表里实测相差 8 小时，直接展示时刻会让模型读到矛盾的时间线。
 *      列表本身已按各自时间列倒序并标注「新→旧」，故此处只展示日期，不做时区换算
 *      （避免自行推算时间）。该时间基不一致是既有问题，已单独记录，不在本模块内改动。
 */
import { all } from './db.js'
import { PACKAGE_KIND } from '../../src/utils/taskOverride.js'
import { toProposalView } from './proposalService.js'
import { listPatientNotes } from './doctorNoteService.js'

/** 记忆条数与单条长度上限（有界，防止提示词被历史记录挤爆） */
export const MEMORY_LIMITS = Object.freeze({
  requests: 3,
  notes: 2,
  utteranceChars: 60,
  noteChars: 80,
  reasonChars: 60,
})

/** 提案状态 → 中文口径（只是枚举转述，不含任何医学判断） */
const STATUS_TEXT = Object.freeze({
  pending_review: '仍在等待医生审核',
  approved: '医生已同意',
  rejected: '医生未通过',
  expired: '已超时失效',
})

/** 截断（保留可读性，避免提示词里出现半截长文） */
function clip(text, max) {
  const s = String(text ?? '').trim()
  if (!s) return null
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

/** 只取日期部分（YYYY-MM-DD）；原因见文件头红线 7 */
function fmtDay(stamp) {
  const s = String(stamp ?? '').trim()
  if (s.length < 10) return s || null
  return s.slice(0, 10)
}

/**
 * 把提案条目转成一句**不含数值**的申请描述。
 * 刻意不带 proposedValue：记忆只负责「患者想改什么」，具体数值由工具查当前状态。
 */
function describeProposalItem(item) {
  if (!item || typeof item !== 'object') return '任务调整申请'
  if (item.type === 'monitor_request') return `申请新增「${item.label || item.taskId}」日常监测`
  return `申请调整【${item.taskId}】的任务目标`
}

/**
 * 患者过往诉求（按时间倒序）。
 * 来源：`prescriptions` 中该患者的提案行（`kind = task_proposal`），
 * 待审 / 已通过 / 已驳回三种状态都算「患者说过的话」。
 */
export function readRecentRequests(patientId, limit = MEMORY_LIMITS.requests) {
  const pid = String(patientId || '')
  if (!pid) return []
  const like = `%"kind":"${PACKAGE_KIND.PROPOSAL}"%`
  const rows = all(
    `SELECT prescription_id, patient_id, target_goals, generated_date, is_active, doctor_modified, created_by
       FROM prescriptions
      WHERE patient_id = ? AND target_goals LIKE ?
      ORDER BY generated_date DESC, rowid DESC
      LIMIT ?`,
    pid,
    like,
    Number(limit) || MEMORY_LIMITS.requests
  )

  return rows
    .map(toProposalView)
    .filter((v) => v.utterance)
    .map((v) => ({
      /** 有医生审结时间就用审结时间，否则用提案产生时间 */
      at: fmtDay(v.reviewedAt || v.createdAt || v.generatedDate),
      utterance: clip(v.utterance, MEMORY_LIMITS.utteranceChars),
      item: describeProposalItem(v.proposals[0]),
      status: v.status,
      outcome: STATUS_TEXT[v.status] || null,
      doctorReason: v.status === 'rejected' ? clip(v.reviewReason, MEMORY_LIMITS.reasonChars) : null,
    }))
}

/** 医生对该患者的最近结论（按时间倒序，复用 doctorNoteService 的既有读取口径） */
export function readRecentDoctorNotes(patientId, limit = MEMORY_LIMITS.notes) {
  const pid = String(patientId || '')
  if (!pid) return []
  // 患者不存在时此处抛 E_PATIENT_NOT_FOUND（不回落、不静默）
  return listPatientNotes(pid, { limit: Number(limit) || MEMORY_LIMITS.notes }).map((n) => ({
    at: fmtDay(n.createdAt),
    noteType: n.noteType || null,
    doctorName: n.doctorName || null,
    content: clip(n.content, MEMORY_LIMITS.noteChars),
  }))
}

/**
 * 装配一位患者的弱记忆视图。
 * @returns {{recentRequests:Array, recentDoctorNotes:Array, hasMemory:boolean}}
 */
export function readPatientMemory(patientId, opts = {}) {
  const recentRequests = readRecentRequests(patientId, opts.requests)
  const recentDoctorNotes = readRecentDoctorNotes(patientId, opts.notes)
  return {
    recentRequests,
    recentDoctorNotes,
    hasMemory: recentRequests.length > 0 || recentDoctorNotes.length > 0,
  }
}

/**
 * 把弱记忆渲染成系统提示词片段。
 *
 * 措辞上刻意做了三层防呆（对应红线 5）：
 *   · 明确「不是本次新信息、可能已过期」；
 *   · 明确「要当前数值 / 任务 / 等级必须调工具」，堵死「拿旧记忆当现状」；
 *   · 明确「不要逐条念出来」，避免每轮把历史复述一遍显得啰嗦。
 *
 * @returns {string} 空记忆 → 空串（调用方可直接拼接，不会产生空行）
 */
export function memoryPreamble(memory) {
  const reqs = Array.isArray(memory?.recentRequests) ? memory.recentRequests : []
  const notes = Array.isArray(memory?.recentDoctorNotes) ? memory.recentDoctorNotes : []
  if (!reqs.length && !notes.length) return ''

  const lines = [
    '【该患者的历史上下文（弱记忆，由系统按 patient_id 从数据库读取）】',
    '以下都是**过去**发生过的记录，用途仅是保持对话延续性。它们**不是**本次新信息，',
    '也**可能已经过期**：凡涉及「当前」的任务、数值、预警等级、达标率，一律必须调用工具',
    '查询当前数据后再回答，**不得**凭这些历史记录推断或下结论；也不要在开头逐条复述它们，',
    '只在患者提到相关话题时自然引用。',
  ]

  if (reqs.length) {
    lines.push('患者过往诉求（新→旧）：')
    reqs.forEach((r, i) => {
      const parts = [r.at || '时间不详', `患者原话「${r.utterance}」`, r.item]
      if (r.outcome) parts.push(r.outcome)
      if (r.doctorReason) parts.push(`医生说明：${r.doctorReason}`)
      lines.push(`${i + 1}. ${parts.join(' · ')}`)
    })
  }

  if (notes.length) {
    lines.push('医生最近结论（新→旧）：')
    notes.forEach((n, i) => {
      const who = n.doctorName || '医生'
      lines.push(`${i + 1}. ${n.at || '时间不详'} · ${n.noteType || '建议'} · ${who}：${n.content}`)
    })
  }

  return lines.join('\n')
}
