/**
 * 迈康 MyCare · 任务提案服务（Step 11 · Phase 2）
 * ===========================================================================
 * 定位：把患者与「方案规划」智能体的对话，变成一张**需要医生签字的申请单**。
 *
 * 落点（零 schema 变更 · D3 = A′）：`prescriptions.target_goals`
 *   用 `kind='task_proposal'` 与生效覆盖包（`kind='task_override_package'`）、
 *   健康处方（无 kind）区分开 —— 三者共用同一张表，**只靠 kind 判别**。
 *
 * 两类申请单（条目内的 `type` 字段）：
 *   · `override`        —— 调整「规则已生成任务」的参数；同意后**用提案自身的 proposedValue
 *                          再过一次关口 1**，通过才写覆盖包（唯一写库出口）。
 *   · `monitor_request` —— 患者希望**新增一个当前未生成的监测域**。
 *                          ⚠️ Step 12 语义变更（用户确认）：医生「同意」后**真正启用**该监测域 ——
 *                          写入 `addedTasks` 覆盖包（is_active=1），患者今日任务立即出现该项，
 *                          且该维度同时计入评分适用维度。
 *                          仍受限于白名单：只能启用 `ADDABLE_MONITOR_TASKS`
 *                          （`bp_monitor` / `bg_monitor`）—— 它们在规则库里已存在，
 *                          只是未被该患者的**主诊断**派生；**不得新建规则库之外的任务域**。
 *
 * 六条不可违背的边界（与 docs/Step11_最终技术方案_评审修订版.md §六 一致）：
 *   1. AI 永远不能直接写 task override —— 本文件**只写 is_active=0 的提案行**；
 *      唯一写覆盖包的入口是 `taskOverrideService.applyOverridePackage()`，
 *      且**只在医生审结时**被本文件调用（approve / modify）。
 *   2. 提案行天然不参与 `getDailyTasks()` 的覆盖读取（只读 is_active=1）→
 *      **医生点同意之前，患者端任务一个字都不变**（无需额外判断，由读取口径保证）。
 *   3. `currentValue` 由 `proposalIntent.js` 经后端 `getEffectiveTaskState()` 注入，
 *      模型返回值一律丢弃。
 *   4. 同 `patient + taskId + field` 已有 pending → **UPDATE 而非 INSERT**（行数不变），
 *      避免医生端被重复申请刷满。
 *   5. 7 天过期 = `generated_date + TTL < now` 的**懒判定，不写库**。
 *   6. `reject` 分支**只 UPDATE 提案行** —— 绝不触碰生效覆盖包，也绝不触碰
 *      `patient_targets`。
 */
import { randomBytes } from 'node:crypto'

import { DataProviderError, ERROR_CODES } from './errors.js'
import { openDb, get, all } from './db.js'
import { getPatientProfile, toUserProfileView } from './dataProvider.js'
import { PACKAGE_KIND, OVERRIDE_CONTRACT_VERSION, validateOverridePackage } from '../../src/utils/taskOverride.js'
import {
  applyOverridePackage,
  isProposalExpired,
  listPendingProposalRows,
  PROPOSAL_TTL_DAYS,
  validationError,
} from './taskOverrideService.js'
import { getEffectiveTaskState } from './patientService.js'
import { createDoctorNote } from './doctorNoteService.js'

/** 单轮最多入库的提案条数（与 proposalIntent 同口径，双层兜底） */
export const PROPOSAL_MAX_PER_TURN = 2
/** utterance 截断长度 */
const UTTERANCE_MAX = 200
/** 驳回理由长度区间（与 basis 同口径） */
const REASON_MIN = 4
const REASON_MAX = 200

const newId = () => randomBytes(16).toString('hex')
const nowStamp = () => new Date().toISOString().slice(0, 19)

const safeJsonObj = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 提案链路专用错误（404 / 409），复用 DataProviderError 的 httpStatus 机制 */
class ProposalError extends DataProviderError {
  constructor(code, message, detail = null, httpStatus = 400) {
    super(code, message, detail)
    this._httpStatus = httpStatus
  }
  get httpStatus() {
    return this._httpStatus
  }
}

/** 提案有效期截止时刻（ISO 8601，秒精度） */
function expiryFrom(stamp) {
  const t = Date.parse(String(stamp).replace(' ', 'T'))
  const base = Number.isNaN(t) ? Date.now() : t
  return new Date(base + PROPOSAL_TTL_DAYS * 86400000).toISOString().slice(0, 19)
}

/* ================================================================== *
 * 读：行 → 视图
 * ================================================================== */

/**
 * 提案行归一化视图。
 * `status` 是**应用层计算得出的派生字段**：pending 且超期 → `'expired'`
 * （原始 JSON 里的 status 恒为 `'pending_review'`，**懒判定不写库**）。
 */
export function toProposalView(row) {
  const pkg = safeJsonObj(row.target_goals) || {}
  const reviewed = Boolean(row.doctor_modified)
  const expired = !reviewed && pkg.status === 'pending_review' && isProposalExpired(row)
  /**
   * 患者姓名与授权状态：医生端「待审核」必须能认出申请人。
   * 患者可能**尚未授权**给任何医生（注册后默认 is_active = 0）——
   * 此时他仍可主动把调整申请提交给医生，医生端应显示姓名 + 「待授权」标记，
   * 而不是只显示一个 patient_id 让人猜。授权状态同时用于提示医生：
   * 该患者的健康数据（体征 / 预警 / 患者详情）此时**不可见**。
   */
  const patient = get('SELECT name FROM patients WHERE patient_id = ?', String(row.patient_id || ''))
  const rel = get(
    'SELECT is_active FROM doctor_patient_relations WHERE patient_id = ? ORDER BY is_active DESC, rowid DESC LIMIT 1',
    String(row.patient_id || '')
  )
  return {
    proposalId: row.prescription_id,
    patientId: row.patient_id,
    patientName: patient?.name ?? null,
    patientAuthorized: Number(rel?.is_active) === 1,
    agentId: pkg.agentId ?? null,
    utterance: pkg.utterance ?? null,
    confidence: pkg.confidence ?? null,
    proposals: Array.isArray(pkg.proposals) ? pkg.proposals : [],
    /** pending_review | approved | rejected | expired */
    status: expired ? 'expired' : (pkg.status ?? 'pending_review'),
    expired,
    createdAt: pkg.createdAt ?? row.generated_date ?? null,
    expiresAt: pkg.expiresAt ?? null,
    generatedDate: row.generated_date ?? null,
    reviewedBy: pkg.reviewedBy ?? null,
    reviewedAt: pkg.reviewedAt ?? null,
    reviewReason: pkg.reviewReason ?? null,
    resultingPrescriptionId: pkg.resultingPrescriptionId ?? null,
    doctorModified: reviewed,
    filtered: Number(pkg.filtered) || 0,
  }
}

/** 单行读取（非提案行 → null） */
export function readProposalRow(proposalId) {
  const row = get(
    `SELECT prescription_id, patient_id, target_goals, generated_date, is_active, doctor_modified, created_by
       FROM prescriptions WHERE prescription_id = ?`,
    String(proposalId || '')
  )
  if (!row) return null
  const pkg = safeJsonObj(row.target_goals)
  if (!pkg || pkg.kind !== PACKAGE_KIND.PROPOSAL) return null
  return row
}

/**
 * 待审提案（未审结 + 未过期）。
 * 查询分两步：SQL 粗筛三列 → **应用层 JSON.parse 过滤 kind**（kind 只能存在于 JSON 内，
 * 无法建索引也无法纯 SQL 区分 —— 这是 D3=A′ 明确接受的代价）。
 */
export function listPendingProposals(patientId = null) {
  return listPendingProposalRows(patientId)
    .map(toProposalView)
    .filter((p) => p.status === 'pending_review')
}

/** 已审结提案（approved / rejected），可按患者过滤 */
export function listReviewedProposals(patientId = null) {
  const sql = `SELECT prescription_id, patient_id, target_goals, generated_date, is_active, doctor_modified, created_by
                 FROM prescriptions
                WHERE created_by = 'agent' AND doctor_modified = 1 AND target_goals LIKE '%"kind":"${PACKAGE_KIND.PROPOSAL}"%'${
                  patientId ? ' AND patient_id = ?' : ''
                }
                ORDER BY generated_date DESC, rowid DESC`
  const rows = patientId ? all(sql, patientId) : all(sql)
  return rows.map(toProposalView).filter((p) => p.status === 'approved' || p.status === 'rejected')
}

/**
 * 医生端提案列表。
 * @param {object} p
 * @param {'pending'|'reviewed'|'all'} [p.status]
 * @param {string} [p.patientId]
 */
export function listProposals({ status = 'pending', patientId = null } = {}) {
  if (status === 'pending') return listPendingProposals(patientId)
  if (status === 'reviewed') return listReviewedProposals(patientId)
  return [...listPendingProposals(patientId), ...listReviewedProposals(patientId)].sort((a, b) =>
    String(b.generatedDate || '').localeCompare(String(a.generatedDate || ''))
  )
}

/* ================================================================== *
 * 写：提案落库（去重更新，行数不变）
 * ================================================================== */

/**
 * 写入 / 更新提案（**不新建覆盖包**）。
 *
 * @param {object} p
 * @param {string} p.patientId
 * @param {string} [p.agentId]    提交提案的智能体（默认 planner = 方案规划）
 * @param {string} [p.utterance]  患者原话（≤200 字，超出截断）
 * @param {Array}  p.proposals    已由 proposalIntent 过滤 + 注入 currentValue 的条目
 * @returns {{created:Array, updated:Array, filtered:number}}
 */
export function createOrUpdateProposal({ patientId, agentId = 'planner', utterance = '', proposals = [] } = {}) {
  if (!patientId) {
    throw new ProposalError(ERROR_CODES.E_INVALID_ARG, 'patientId 必填')
  }
  const list = (Array.isArray(proposals) ? proposals : []).filter((p) => p && p.taskId && p.field)
  if (!list.length) return { created: [], updated: [], filtered: 0 }

  const db = openDb()
  const now = nowStamp()
  const utter = String(utterance ?? '').slice(0, UTTERANCE_MAX)

  // pending 索引：同 patient + taskId + field → 命中则 UPDATE（行数不变）
  const index = new Map()
  for (const row of listPendingProposalRows(patientId)) {
    const pkg = safeJsonObj(row.target_goals)
    if (!pkg || pkg.kind !== PACKAGE_KIND.PROPOSAL) continue
    if (pkg.status !== 'pending_review') continue
    if (isProposalExpired(row)) continue
    for (const item of Array.isArray(pkg.proposals) ? pkg.proposals : []) {
      index.set(`${item.taskId}::${item.field}`, { row, pkg })
    }
  }

  const created = []
  const updated = []
  const seen = new Set()

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const raw of list.slice(0, PROPOSAL_MAX_PER_TURN)) {
      const key = `${raw.taskId}::${raw.field}`
      if (seen.has(key)) continue // 同轮同域去重
      seen.add(key)

      const item = {
        type: raw.type === 'monitor_request' ? 'monitor_request' : 'override',
        proposalId: raw.proposalId ?? `prop_${newId().slice(0, 8)}`,
        taskId: raw.taskId,
        field: raw.field,
        label: raw.label ?? null,
        currentValue: raw.currentValue ?? null,
        currentValueSource: raw.currentValueSource ?? 'effective_task_state',
        proposedValue: raw.proposedValue,
        reason: String(raw.reason ?? '').slice(0, 200),
        evidence: Array.isArray(raw.evidence) ? raw.evidence.slice(0, 4) : [],
      }

      const hit = index.get(key)
      if (hit) {
        // —— 去重：UPDATE 该行 proposals[0] + 刷新 generated_date（行数不变）——
        const pkg = {
          ...hit.pkg,
          utterance: utter || hit.pkg.utterance || '',
          proposals: [{ ...hit.pkg.proposals[0], ...item, proposalId: hit.pkg.proposals[0].proposalId }],
          updatedAt: now,
          expiresAt: expiryFrom(now),
        }
        db.prepare('UPDATE prescriptions SET target_goals = ?, generated_date = ? WHERE prescription_id = ?').run(
          JSON.stringify(pkg),
          now,
          hit.row.prescription_id
        )
        updated.push({ proposalId: hit.row.prescription_id, taskId: item.taskId, field: item.field })
        continue
      }

      // —— 新建：is_active=0（天然不参与覆盖读取）+ doctor_modified=0（待审）——
      const prescriptionId = newId()
      const pkg = {
        kind: PACKAGE_KIND.PROPOSAL,
        contractVersion: OVERRIDE_CONTRACT_VERSION,
        status: 'pending_review',
        origin: 'agent',
        agentId,
        patientId,
        utterance: utter,
        createdAt: now,
        expiresAt: expiryFrom(now),
        proposals: [item],
        reviewedBy: null,
        reviewedAt: null,
        reviewReason: null,
        resultingPrescriptionId: null,
      }
      db.prepare(
        `INSERT INTO prescriptions
           (prescription_id, patient_id, target_goals, generated_date, is_active, doctor_modified, created_by)
         VALUES (?, ?, ?, ?, 0, 0, 'agent')`
      ).run(prescriptionId, patientId, JSON.stringify(pkg), now)
      created.push({ proposalId: prescriptionId, taskId: item.taskId, field: item.field })
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err instanceof DataProviderError
      ? err
      : new DataProviderError(ERROR_CODES.E_INTERNAL, `写入提案失败：${err.message}`, { patientId })
  }

  return { created, updated, filtered: 0 }
}

/* ================================================================== *
 * 审核流转
 * ================================================================== */

/** 供 review 复用的校验上下文（与医生端 PUT 的 buildOverrideContext 同口径） */
async function buildReviewContext(patientId) {
  const profile = await getPatientProfile(patientId)
  const view = toUserProfileView(profile)
  const state = await getEffectiveTaskState(patientId)
  return {
    view,
    state,
    ctx: {
      generatedTaskIds: state.taskIds,
      primaryDisease: view.medical.primaryDisease,
      diseases: view.diseases,
    },
  }
}

/** 提案条目 → 人类可读描述（写通知文案用） */
function describeProposal(item) {
  if (item?.type === 'monitor_request') return `申请新增「${item.label || MONITOR_LABEL[item.taskId] || item.taskId}」日常监测`
  if (Array.isArray(item?.proposedValue)) return `${item.taskId} 监测时段 → ${item.proposedValue.join('/')}`
  return `${item.taskId} 目标 → ${item.proposedValue}`
}

/** 申请型提案的展示名（与 proposalIntent 的 MONITOR_SUBJECT 同口径；UI 侧另有同一份映射） */
const MONITOR_LABEL = Object.freeze({
  bg_monitor: '血糖',
  bp_monitor: '血压',
  weight_record: '体重',
})

/**
 * 医生审结一条提案。
 *
 * - `approve`：采纳申请 → 用提案自身的 `proposedValue` 构造覆盖包 → **重新过关口 1** → 落库
 * - `modify` ：按医生修改后的值生效 → 用请求体 `overrides` → **同一把尺子** → 落库
 * - `reject` ：不产生任何任务变化 → **只 UPDATE 提案行** + 写一条含理由的医生建议
 *
 * @param {object} p
 * @param {string} p.proposalId
 * @param {string} p.doctorId
 * @param {'approve'|'modify'|'reject'} p.decision
 * @param {object} [p.overrides] modify 时的覆盖映射
 * @param {string} [p.reason]    modify 时的调整依据 / reject 时的驳回理由
 * @returns {Promise<object>}
 */
export async function reviewProposal({ proposalId, doctorId, decision, overrides = null, reason = null } = {}) {
  const row = readProposalRow(proposalId)
  if (!row) {
    throw new ProposalError(
      ERROR_CODES.E_PROPOSAL_NOT_FOUND,
      '提案不存在或已不是待审提案',
      { proposalId },
      404
    )
  }
  const pkg = safeJsonObj(row.target_goals) || {}
  if (Boolean(row.doctor_modified) || pkg.status !== 'pending_review') {
    throw new ProposalError(
      ERROR_CODES.E_PROPOSAL_ALREADY_REVIEWED,
      `提案已审结（当前状态：${pkg.status ?? 'unknown'}）`,
      { proposalId, status: pkg.status ?? null },
      409
    )
  }
  if (isProposalExpired(row)) {
    throw new ProposalError(
      ERROR_CODES.E_PROPOSAL_EXPIRED,
      `提案已超过 ${PROPOSAL_TTL_DAYS} 天有效期，不再受理`,
      { proposalId, generatedDate: row.generated_date },
      409
    )
  }

  const patientId = row.patient_id
  const item = (Array.isArray(pkg.proposals) ? pkg.proposals : [])[0]
  if (!item) {
    throw new ProposalError(ERROR_CODES.E_PROPOSAL_NOT_FOUND, '提案内容为空', { proposalId }, 404)
  }

  const now = nowStamp()
  const db = openDb()

  /* ---------------- reject：只改提案行，零任务影响 ---------------- */
  if (decision === 'reject') {
    const text = String(reason ?? '').trim()
    if (text.length < REASON_MIN || text.length > REASON_MAX) {
      throw new ProposalError(
        ERROR_CODES.E_BASIS_REQUIRED,
        `驳回理由必填（${REASON_MIN}–${REASON_MAX} 字）`,
        { proposalId },
        400
      )
    }
    db.prepare('UPDATE prescriptions SET target_goals = ?, doctor_modified = 1 WHERE prescription_id = ?').run(
      JSON.stringify({
        ...pkg,
        status: 'rejected',
        reviewedBy: doctorId,
        reviewedAt: now,
        reviewReason: text,
        resultingPrescriptionId: null,
      }),
      proposalId
    )
    // ⚠️ 此处**不得**出现 applyOverridePackage / patient_targets 的任何写入
    createDoctorNote({
      doctorId,
      patientId,
      content: `您提出的调整申请「${describeProposal(item)}」未获通过。医生说明：${text}`,
      noteType: '建议',
      priority: '中',
    })
    return {
      decision: 'reject',
      proposalId,
      patientId,
      status: 'rejected',
      reviewReason: text,
      tasksUnchanged: true,
    }
  }

  /* -------- 申请新增监测项：医生审结 → **真正启用该监测域**（Step 12） --------
   * 语义变更（用户确认「同意即启用并计入评分」）：
   *   医生「同意」= 该监测域立刻进入患者的每日任务，并同时计入评分适用维度（分母）。
   * 仍然守住的两条界线（红线未放开）：
   *   · 只能启用 taskOverride.ADDABLE_MONITOR_TASKS 白名单内的监测域 —— 它们在
   *     DAILY_TASK_RULES 里**已经存在**，只是未被该患者的主诊断派生；
   *     **不得新建规则库不存在的任务域**（白名单外一律 E_ADDED_TASK_UNKNOWN）。
   *   · 唯一的写库出口仍是 applyOverridePackage（只有医生审结会走到这里，且写入 is_active=1）。
   * 医生「修改后生效」时可指定测量时段；未指定则回落规则库默认时段。
   */
  if (item.type === 'monitor_request') {
    const taskId = item.taskId
    const label = item.label || MONITOR_LABEL[taskId] || taskId

    // 兼容医生端既有请求体 { overrides: { [taskId]: { slots: [...] } } }
    const slotsFromOverrides = overrides?.[taskId]?.slots
    const addedEntry = { taskId }
    if (decision === 'modify') {
      if (!Array.isArray(slotsFromOverrides) || slotsFromOverrides.length === 0) {
        throw new ProposalError(
          ERROR_CODES.E_INVALID_ARG,
          '新增监测申请需指定测量时段（slots）后才能「修改后生效」',
          { proposalId, taskId },
          400
        )
      }
      addedEntry.slots = slotsFromOverrides
    }

    const { ctx } = await buildReviewContext(patientId)
    const basisRaw = (decision === 'modify' ? String(reason ?? '').trim() : '') ||
      `采纳患者申请：${item.reason || describeProposal(item)}`
    const basisText = String(basisRaw).slice(0, REASON_MAX)

    // —— 关口 1：与医生端 PUT 同一个校验函数（白名单 / 时段枚举 / 已派生拦截都在这里）——
    const verdict = validateOverridePackage({ overrides: {}, addedTasks: [addedEntry], basis: basisText }, ctx)
    if (!verdict.ok) {
      throw validationError(verdict, { patientId, addedTasks: [addedEntry], source: 'monitor_request_review' })
    }

    const applied = applyOverridePackage({
      patientId,
      doctorId,
      overrides: {},
      addedTasks: verdict.normalized.addedTasks,
      basis: verdict.normalized.basis,
      origin: 'agent',
      sourceUtterance: item.evidence?.[0] ?? pkg.utterance ?? null,
    })
    const finalSlots = verdict.normalized.addedTasks[0].slots

    db.prepare('UPDATE prescriptions SET target_goals = ?, doctor_modified = 1 WHERE prescription_id = ?').run(
      JSON.stringify({
        ...pkg,
        status: 'approved',
        reviewedBy: doctorId,
        reviewedAt: now,
        reviewReason:
          decision === 'modify'
            ? `医生调整时段后生效：${finalSlots.join('、')}`
            : `医生同意新增该监测项（${finalSlots.join('、')}）`,
        resultingPrescriptionId: applied.prescriptionId,
        appliedAddedTasks: verdict.normalized.addedTasks,
      }),
      proposalId
    )
    createDoctorNote({
      doctorId,
      patientId,
      content:
        `您申请新增「${label}」日常监测已通过。医生已将该需求记为随访关注项，` +
        `并从今天起为您的每日任务增加该项监测（${finalSlots.join('、')}，每日 ${finalSlots.length} 次）；` +
        `该指标同时会计入您的当日健康评分。如需调整时段，可在医生端今日任务中调整。`,
      noteType: '建议',
      priority: '中',
    })
    return {
      decision,
      proposalId,
      patientId,
      status: 'approved',
      monitorTaskId: taskId,
      addedTasks: verdict.normalized.addedTasks,
      resultingPrescriptionId: applied.prescriptionId,
      /** 审结后患者端今日任务**确实发生变化**（新增该监测任务 → 该字段为 false） */
      tasksUnchanged: false,
      requiresFollowUp: false,
    }
  }

  /* ---------------- approve / modify：同一把尺子 → 唯一写库出口 ---------------- */
  const basisSource = decision === 'approve' ? `采纳患者申请：${item.reason || describeProposal(item)}` : reason
  const basis = String(basisSource ?? '').trim().slice(0, REASON_MAX)
  const proposed = decision === 'approve' ? { [item.taskId]: { [item.field]: item.proposedValue } } : overrides

  const { ctx, state } = await buildReviewContext(patientId)

  // —— 关口 1：与医生端 PUT 完全同一个函数（modify 不得绕过校验）——
  const verdict = validateOverridePackage({ overrides: proposed, basis }, ctx)
  if (!verdict.ok) {
    throw validationError(verdict, { patientId, overrides: proposed, source: 'proposal_review' })
  }

  // —— 关口 3：唯一写库出口（单事务）——
  const applied = applyOverridePackage({
    patientId,
    doctorId,
    overrides: verdict.normalized.overrides,
    basis: verdict.normalized.basis,
    origin: 'agent',
    sourceUtterance: pkg.utterance ?? null,
  })

  db.prepare('UPDATE prescriptions SET target_goals = ?, doctor_modified = 1 WHERE prescription_id = ?').run(
    JSON.stringify({
      ...pkg,
      status: 'approved',
      reviewedBy: doctorId,
      reviewedAt: now,
      reviewReason: decision === 'modify' ? verdict.normalized.basis : null,
      resultingPrescriptionId: applied.prescriptionId,
      appliedOverrides: verdict.normalized.overrides,
    }),
    proposalId
  )

  const deltaDesc = Object.entries(verdict.normalized.overrides)
    .map(([taskId, fields]) => {
      const from = state.tasks.find((t) => t.taskId === taskId)
      if (Array.isArray(fields.slots)) return `${taskId} 监测时段 ${(from?.slots || []).length} 项 → ${fields.slots.length} 项`
      return `${taskId} 目标 ${from?.target ?? '—'} → ${fields.target}`
    })
    .join('；')

  createDoctorNote({
    doctorId,
    patientId,
    content:
      decision === 'approve'
        ? `您提出的调整申请已通过，今日任务已更新（${deltaDesc}）。依据：${verdict.normalized.basis}`
        : `您提出的调整申请已由医生修改后生效（${deltaDesc}）。依据：${verdict.normalized.basis}`,
    noteType: '建议',
    priority: '中',
  })

  return {
    decision,
    proposalId,
    patientId,
    status: 'approved',
    prescriptionId: applied.prescriptionId,
    overrides: verdict.normalized.overrides,
    previousStepsTarget: applied.previousStepsTarget,
    tasksUnchanged: false,
  }
}

/* ================================================================== *
 * 辅助查询
 * ================================================================== */

/** 待审提案总数（医生端角标；与 taskOverrideService.countPendingProposals 同口径） */
export function countPending(patientId = null) {
  return listPendingProposals(patientId).length
}
