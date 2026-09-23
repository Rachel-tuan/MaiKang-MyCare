/**
 * 迈康 MyCare · 今日任务覆盖写入服务（Step 11 · Phase 1）
 * ===========================================================================
 * 定位：覆盖层与提案层的**唯一写库出口**，与 alertService.js 同构。
 *
 * 落点（零 schema 变更 · D3 = A′）：
 *   · 生效覆盖包 / 待审提案 → `prescriptions.target_goals`（JSON，用 `kind` 判别）
 *   · 步数目标             → `patient_targets.steps_target`（既有读取链路）
 *
 * 三道红线的实现位置：
 *   · 关口 3 写入 —— 本文件 `applyOverridePackage()` 是**全项目唯一**写覆盖包的函数。
 *     提案通道（Phase 2）在**生成提案时**不得引用它（那时只能写 is_active=0 的提案行）；
 *     **只有医生审结（approve / modify）**才会由 proposalService 调用本函数写入生效包。
 *   · F-1 排序歧义 —— `patient_targets` **只 UPDATE 既有行**（0 行才 INSERT），
 *     读取一律 `ORDER BY created_at DESC, rowid DESC`，绝不新增行造成「读了旧行」。
 *   · F-2 basis 保护 —— 医生调整依据写进 `prescriptions.target_goals.basis`，
 *     **绝不写 `patient_targets.basis`**（该列已被登录页当作 JSON 消费）。
 *
 * 版本策略：新调整 = 新 prescription 版本；同事务内旧版本 `is_active=0`；
 *          生效版本唯一由应用层单事务保证，读取再以排序兜底。
 */
import { randomBytes } from 'node:crypto'

import { DataProviderError, ERROR_CODES } from './errors.js'
import { openDb, get, all } from './db.js'
import {
  PACKAGE_KIND,
  OVERRIDE_CONTRACT_VERSION,
  readEffectiveOverrides,
  OVERRIDE_ERRORS,
} from '../../src/utils/taskOverride.js'

/** 提案有效期（天）—— 懒判定，不写库 */
export const PROPOSAL_TTL_DAYS = 7

/** 只命中「覆盖包」行，绝不误伤同表的「健康处方」行（F-3） */
const LIKE_OVERRIDE = `%"kind":"${PACKAGE_KIND.OVERRIDE}"%`
/** 只命中「提案」行 */
const LIKE_PROPOSAL = `%"kind":"${PACKAGE_KIND.PROPOSAL}"%`

const newId = () => randomBytes(16).toString('hex')
const nowStamp = () => new Date().toISOString().slice(0, 19)

/**
 * 合并「新增监测域」清单（Step 12）。
 * ------------------------------------------------------------------
 * 覆盖包是**整包替换**语义：写新版本时旧版本失效。若医生先同意新增血糖监测、
 * 之后又调整步数目标，新版本必须**继承**上一版本的 addedTasks，否则患者端
 * 刚出现的血糖任务会莫名其妙消失。
 *
 * 按 taskId 去重（后写入的时段配置覆盖先前的）；本轮**不支持取消新增**，
 * 因此这里只做并集，不做差集。
 */
function mergeAddedTasks(prevAdded = [], nextAdded = []) {
  const byId = new Map()
  for (const item of Array.isArray(prevAdded) ? prevAdded : []) {
    if (item?.taskId) byId.set(item.taskId, item)
  }
  for (const item of Array.isArray(nextAdded) ? nextAdded : []) {
    if (item?.taskId) byId.set(item.taskId, item)
  }
  return [...byId.values()]
}

/** 覆盖链路专用错误（HTTP 400 / 409），复用 DataProviderError 的 httpStatus 机制 */
class OverrideError extends DataProviderError {
  constructor(code, message, detail = null, httpStatus = 400) {
    super(code, message, detail)
    this._httpStatus = httpStatus
  }
  get httpStatus() {
    return this._httpStatus
  }
}

/** 覆盖包校验失败 → 400（整包原子拒绝，绝不静默忽略） */
export function validationError(result, detail = null) {
  const first = result?.errors?.[0]
  const code = result?.code || ERROR_CODES.E_INVALID_ARG
  const msg = first?.message || '覆盖包校验未通过'
  const status = code === OVERRIDE_ERRORS.E_CONTRACT_VERSION_UNSUPPORTED ? 409 : 400
  return new OverrideError(code, msg, detail ?? { errors: result?.errors ?? [] }, status)
}

/* ================================================================== *
 * 读：生效覆盖包
 * ================================================================== */

/** 生效覆盖包原始行（仅覆盖包，不含健康处方） */
export function readActiveOverrideRow(patientId) {
  return get(
    `SELECT prescription_id, patient_id, target_goals, generated_date, is_active, doctor_modified, created_by
       FROM prescriptions
      WHERE patient_id = ? AND is_active = 1 AND target_goals LIKE ?
      ORDER BY generated_date DESC, rowid DESC
      LIMIT 1`,
    patientId,
    LIKE_OVERRIDE
  )
}

/**
 * 读取当前生效覆盖包（归一化）。
 * @returns {{prescriptionId, overrides, basis, origin, reviewedBy, reviewedAt, createdAt, supersedes, previousStepsTarget, generatedDate}|null}
 */
export function readActiveOverridePackage(patientId) {
  const row = readActiveOverrideRow(patientId)
  if (!row) return null
  const parsed = readEffectiveOverrides(row.target_goals)
  if (!parsed) return null
  return {
    ...parsed,
    prescriptionId: row.prescription_id,
    generatedDate: row.generated_date,
    doctorModified: Boolean(row.doctor_modified),
    createdBy: row.created_by,
  }
}

/** 供 dailyTasks 使用的覆盖包入参（无覆盖时为空对象，行为与 Step 9 完全一致） */
export function getEffectiveOverrides(patientId) {
  const pkg = readActiveOverridePackage(patientId)
  if (!pkg) return { overrides: {}, addedTasks: [], meta: {}, package: null }
  return {
    overrides: pkg.overrides,
    // Step 12：医生审结新增的监测域（dailyTasks 据此补出任务；healthScore 据此加维度）
    addedTasks: Array.isArray(pkg.addedTasks) ? pkg.addedTasks : [],
    meta: {
      by: pkg.reviewedBy ?? pkg.origin ?? null,
      at: pkg.reviewedAt ?? pkg.createdAt ?? null,
      basis: pkg.basis ?? null,
    },
    package: pkg,
  }
}

/** `patient_targets` 当前步数目标（加固排序：created_at DESC, rowid DESC） */
export function readPatientStepsTarget(patientId) {
  return (
    get(
      `SELECT target_id, steps_target FROM patient_targets
        WHERE patient_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
      patientId
    ) ?? null
  )
}

/* ================================================================== *
 * 写：唯一出口
 * ================================================================== */

/**
 * 应用一个**已校验**的覆盖包（单事务）。
 *
 * ⚠️ 调用方必须先跑 `validateOverridePackage()`（关口 1）。
 *    本函数只负责「持久化 + 版本失效 + 步数目标同步」，不重复裁定合法性。
 *
 * @param {object} p
 * @param {string} p.patientId
 * @param {string} p.doctorId          审核 / 操作医生（写入 set_by 与 reviewedBy）
 * @param {object} p.overrides         已校验的覆盖映射（可为空 —— 只要 addedTasks 非空）
 * @param {Array}  [p.addedTasks]      已校验的「新增监测域」清单（Step 12，见 taskOverride.normalizeAddedTasks）
 * @param {string} p.basis             调整依据（4–200 字）
 * @param {string} [p.origin]          'doctor' | 'agent'（谁是初稿来源）
 * @param {string} [p.sourceUtterance] 若源自对话提案，记录患者原话
 * @param {object} [p.supersedesInfo]  { prescriptionId, previousStepsTarget } 供审核链路透传
 * @returns {{prescriptionId:string, package:object, previousStepsTarget:number|null}}
 */
export function applyOverridePackage({
  patientId,
  doctorId,
  overrides = {},
  addedTasks = [],
  basis,
  origin = 'doctor',
  sourceUtterance = null,
  supersedesInfo = null,
} = {}) {
  if (!patientId) throw new OverrideError(ERROR_CODES.E_INVALID_ARG, 'patientId 必填')

  const db = openDb()
  const now = nowStamp()
  const prevRow = readActiveOverrideRow(patientId)
  const prevPkg = prevRow ? readEffectiveOverrides(prevRow.target_goals) : null

  // Step 12：新增监测域跨版本继承（详见 mergeAddedTasks 注释）
  const mergedAddedTasks = mergeAddedTasks(prevPkg?.addedTasks, addedTasks)

  if (!Object.keys(overrides).length && !mergedAddedTasks.length) {
    throw new OverrideError(OVERRIDE_ERRORS.E_OVERRIDES_EMPTY, '覆盖包为空，拒绝写入')
  }

  // 记住「覆盖前的原始步数目标」，供撤销时精确还原（仅 steps 覆盖需要）
  // ⚠️ 必须区分「没有该记录」与「原始值恰为 null」：只要存在旧覆盖包，就**原样继承**它记录的
  //    原始值（哪怕它是 null）。否则第二次应用会把「已被覆盖的值」当成原始值，
  //    撤销后 patient_targets 永远回不到覆盖前 —— 实测踩过。
  const rawSteps = readPatientStepsTarget(patientId)
  const previousStepsTarget = prevPkg
    ? (prevPkg.previousStepsTarget ?? null)
    : supersedesInfo && Object.prototype.hasOwnProperty.call(supersedesInfo, 'previousStepsTarget')
      ? supersedesInfo.previousStepsTarget
      : (rawSteps?.steps_target ?? null)

  const prescriptionId = newId()
  const pkg = {
    kind: PACKAGE_KIND.OVERRIDE,
    contractVersion: OVERRIDE_CONTRACT_VERSION,
    status: 'active',
    origin,
    reviewedBy: doctorId ?? null,
    reviewedAt: now,
    basis: String(basis ?? '').trim(),
    sourceUtterance: sourceUtterance ?? prevPkg?.sourceUtterance ?? null,
    supersedes: supersedesInfo?.prescriptionId ?? prevRow?.prescription_id ?? null,
    createdAt: now,
    previousStepsTarget,
    overrides,
    // Step 12：医生审结新增的监测域（空数组 = 无新增）
    addedTasks: mergedAddedTasks,
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // 1. 旧版本失效（**仅覆盖包行**，不动同表健康处方）
    db.prepare(
      `UPDATE prescriptions SET is_active = 0
        WHERE patient_id = ? AND is_active = 1 AND target_goals LIKE ?`
    ).run(patientId, LIKE_OVERRIDE)

    // 2. 新版本生效
    db.prepare(
      `INSERT INTO prescriptions
         (prescription_id, patient_id, target_goals, generated_date, is_active, doctor_modified, created_by)
       VALUES (?, ?, ?, ?, 1, 1, 'doctor')`
    ).run(prescriptionId, patientId, JSON.stringify(pkg), now)

    // 3. 步数目标同步（F-1：UPDATE 既有行；0 行才 INSERT；**绝不写 basis**）
    const stepsTarget = overrides.steps?.target
    if (Number.isInteger(stepsTarget)) {
      if (rawSteps?.target_id) {
        db.prepare(`UPDATE patient_targets SET steps_target = ?, set_by = ? WHERE target_id = ?`).run(
          stepsTarget,
          doctorId ?? null,
          rawSteps.target_id
        )
      } else {
        db.prepare(`INSERT INTO patient_targets (patient_id, steps_target, set_by) VALUES (?, ?, ?)`).run(
          patientId,
          stepsTarget,
          doctorId ?? null
        )
      }
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
      : new DataProviderError(ERROR_CODES.E_INTERNAL, `写入覆盖包失败：${err.message}`, { patientId })
  }

  return { prescriptionId, package: { ...pkg, prescriptionId }, previousStepsTarget }
}

/**
 * 撤销某任务域的覆盖（回落规则值）。
 * - 剩余覆盖非空 → 生成一个新版本（去掉该 taskId），保留版本链；
 * - 剩余覆盖为空 → 该覆盖包整体失效，并恢复覆盖前的步数目标。
 *
 * @returns {{revoked:boolean, reason?:string, prescriptionId?:string, package?:object}}
 */
export function revokeOverride(patientId, taskId, doctorId = null) {
  const prevRow = readActiveOverrideRow(patientId)
  if (!prevRow) return { revoked: false, reason: 'NO_ACTIVE_OVERRIDE' }
  const prevPkg = readEffectiveOverrides(prevRow.target_goals)
  const overrides = { ...(prevPkg?.overrides || {}) }
  const addedTasks = Array.isArray(prevPkg?.addedTasks) ? prevPkg.addedTasks.slice() : []

  // taskId 可能来自两类变更：参数覆盖（overrides）或医生审结新增（addedTasks）。
  // 两者都可被本接口撤销 —— 撤销新增 = 该监测域回落为「未启用」。
  const hasFieldOverride = Object.prototype.hasOwnProperty.call(overrides, taskId)
  const addedIdx = addedTasks.findIndex((a) => a?.taskId === taskId)
  if (!hasFieldOverride && addedIdx < 0) {
    return { revoked: false, reason: 'TASK_NOT_OVERRIDDEN', prescriptionId: prevRow.prescription_id }
  }
  if (hasFieldOverride) delete overrides[taskId]
  if (addedIdx >= 0) addedTasks.splice(addedIdx, 1)

  const db = openDb()
  const now = nowStamp()

  // —— 剩余为空（既无参数覆盖、也无新增监测域）：整包失效 + 还原步数目标 ——
  if (Object.keys(overrides).length === 0 && addedTasks.length === 0) {
    const rawSteps = readPatientStepsTarget(patientId)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `UPDATE prescriptions SET is_active = 0
          WHERE patient_id = ? AND is_active = 1 AND target_goals LIKE ?`
      ).run(patientId, LIKE_OVERRIDE)
      if (rawSteps?.target_id) {
        db.prepare(`UPDATE patient_targets SET steps_target = ?, set_by = NULL WHERE target_id = ?`).run(
          prevPkg?.previousStepsTarget ?? null,
          rawSteps.target_id
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
    return { revoked: true, reason: 'PACKAGE_CLEARED', prescriptionId: null }
  }

  // —— 剩余非空：生成新版本（去掉该 taskId）——
  const prescriptionId = newId()
  const pkg = {
    kind: PACKAGE_KIND.OVERRIDE,
    contractVersion: OVERRIDE_CONTRACT_VERSION,
    status: 'active',
    origin: prevPkg?.origin ?? 'doctor',
    reviewedBy: doctorId ?? prevPkg?.reviewedBy ?? null,
    reviewedAt: now,
    basis: prevPkg?.basis ?? null,
    sourceUtterance: prevPkg?.sourceUtterance ?? null,
    supersedes: prevRow.prescription_id,
    createdAt: now,
    previousStepsTarget: prevPkg?.previousStepsTarget ?? null,
    overrides,
    // Step 12：撤销一个参数覆盖时，其余已启用的监测域必须原样保留
    addedTasks,
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE prescriptions SET is_active = 0
        WHERE patient_id = ? AND is_active = 1 AND target_goals LIKE ?`
    ).run(patientId, LIKE_OVERRIDE)
    db.prepare(
      `INSERT INTO prescriptions
         (prescription_id, patient_id, target_goals, generated_date, is_active, doctor_modified, created_by)
       VALUES (?, ?, ?, ?, 1, 1, 'doctor')`
    ).run(prescriptionId, patientId, JSON.stringify(pkg), now)
    // 撤销 steps 时同步还原 patient_targets
    if (taskId === 'steps') {
      const rawSteps = readPatientStepsTarget(patientId)
      if (rawSteps?.target_id) {
        db.prepare(`UPDATE patient_targets SET steps_target = ?, set_by = NULL WHERE target_id = ?`).run(
          prevPkg?.previousStepsTarget ?? null,
          rawSteps.target_id
        )
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
  return { revoked: true, reason: 'TASK_REMOVED', prescriptionId, package: { ...pkg, prescriptionId } }
}

/* ================================================================== *
 * 提案（Phase 2 使用，Phase 1 仅提供计数以支撑医生端角标）
 * ================================================================== */

/** 提案是否已过期（懒判定：generated_date + TTL < now；**不写库**） */
export function isProposalExpired(row, now = new Date()) {
  const t = Date.parse(String(row?.generated_date || '').replace(' ', 'T'))
  if (Number.isNaN(t)) return false
  return now.getTime() - t > PROPOSAL_TTL_DAYS * 86400000
}

/** 待审提案原始行（created_by='agent' AND is_active=0 AND doctor_modified=0） */
export function listPendingProposalRows(patientId = null) {
  const sql = `SELECT prescription_id, patient_id, target_goals, generated_date, is_active, doctor_modified, created_by
                 FROM prescriptions
                WHERE created_by = 'agent' AND is_active = 0 AND doctor_modified = 0
                  AND target_goals LIKE ?${patientId ? ' AND patient_id = ?' : ''}
                ORDER BY generated_date DESC, rowid DESC`
  return patientId ? all(sql, LIKE_PROPOSAL, patientId) : all(sql, LIKE_PROPOSAL)
}

/** 待审提案数（未过期的 task_proposal 行）—— 供医生端角标 */
export function countPendingProposals(patientId = null) {
  return listPendingProposalRows(patientId).filter((row) => {
    const pkg = safeJsonObj(row.target_goals)
    if (!pkg || pkg.kind !== PACKAGE_KIND.PROPOSAL) return false
    if (pkg.status !== 'pending_review') return false
    return !isProposalExpired(row)
  }).length
}

function safeJsonObj(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
