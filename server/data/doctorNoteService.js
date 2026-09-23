/**
 * 迈康 MyCare · 医生建议（doctor_notes）落库服务（Step 11 · Phase 1 · D8）
 * ===========================================================================
 * 背景：医生端「添加备注」此前是**纯前端内存态**（useState），提示成功但刷新即丢，
 *       `doctor_notes` 表 0 行 —— 本条将其改为真落库，与 alertService.js 同构。
 *
 * 红线：
 *   · 表结构已就绪（P0 冻结 22 张表之一），**不新增表、不加列**。
 *   · `note_type` 枚举沿用既有 CHECK（'建议' / '警告' / '表扬' / '处方调整'），
 *     界面文案统一用「建议」；枚举不得因文案调整而改名。
 *   · `doctor_id` 外键指向 doctors，必须真实存在（不得伪造医生身份）。
 *   · 健康数据不落 localStorage；本服务只写服务端库。
 */
import { randomBytes } from 'node:crypto'

import { DataProviderError, ERROR_CODES } from './errors.js'
import { openDb, get, all } from './db.js'

/** note_type 合法枚举（严格对齐 schema CHECK） */
export const NOTE_TYPES = Object.freeze(['建议', '警告', '表扬', '处方调整'])
/** priority 合法枚举 */
export const NOTE_PRIORITIES = Object.freeze(['低', '中', '高', '紧急'])

const newId = () => randomBytes(16).toString('hex')

function requireDoctor(doctorId) {
  const row = get('SELECT doctor_id, name, title, department FROM doctors WHERE doctor_id = ?', String(doctorId || ''))
  if (!row) {
    throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到医生：${doctorId}`, { doctorId })
  }
  return row
}

/** 供路由层复用：医生必须存在（不得伪造医生身份） */
export function assertDoctorExists(doctorId) {
  return requireDoctor(doctorId)
}

function requirePatientExists(patientId) {
  const row = get('SELECT patient_id, name FROM patients WHERE patient_id = ?', String(patientId || ''))
  if (!row) {
    throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到患者：${patientId}`, { patientId })
  }
  return row
}

/** 行 → 视图（前端直用的驼峰命名） */
function toNoteView(r, doctor) {
  return {
    noteId: r.note_id,
    patientId: r.patient_id,
    doctorId: r.doctor_id,
    doctorName: doctor?.name ?? null,
    doctorTitle: doctor?.title ?? null,
    doctorDepartment: doctor?.department ?? null,
    content: r.content,
    noteType: r.note_type,
    priority: r.priority,
    isRead: Boolean(r.is_read),
    source: r.source,
    createdAt: r.created_at,
  }
}

/**
 * 新建一条医生建议（真落库）。
 * @returns 视图对象；患者端可读（is_read 初始 0）
 */
export function createDoctorNote({ doctorId, patientId, content, noteType = '建议', priority = '中', source = 'doctor' } = {}) {
  const text = String(content ?? '').trim()
  if (text.length < 2) {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '建议内容必填（至少 2 个字符）', { fn: 'createDoctorNote' })
  }
  if (text.length > 1000) {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, '建议内容过长（≤ 1000 字）', { fn: 'createDoctorNote' })
  }
  if (!NOTE_TYPES.includes(noteType)) {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, `noteType 非法，只能为：${NOTE_TYPES.join(' / ')}`, { noteType })
  }
  if (!NOTE_PRIORITIES.includes(priority)) {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, `priority 非法，只能为：${NOTE_PRIORITIES.join(' / ')}`, { priority })
  }

  const doctor = requireDoctor(doctorId)
  requirePatientExists(patientId)

  const noteId = newId()
  openDb()
    .prepare(
      `INSERT INTO doctor_notes (note_id, doctor_id, patient_id, content, note_type, priority, is_read, source)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(noteId, doctor.doctor_id, patientId, text, noteType, priority, source)

  const row = get('SELECT * FROM doctor_notes WHERE note_id = ?', noteId)
  return toNoteView(row, doctor)
}

/** 患者端：读取自己的医生建议 */
export function listPatientNotes(patientId, { unreadOnly = false, limit = 20 } = {}) {
  requirePatientExists(patientId)
  const rows = all(
    `SELECT * FROM doctor_notes
      WHERE patient_id = ?${unreadOnly ? ' AND is_read = 0' : ''}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
    patientId,
    Number(limit) || 20
  )
  return rows.map((r) => {
    const doctor = get('SELECT name, title, department FROM doctors WHERE doctor_id = ?', r.doctor_id)
    return toNoteView(r, doctor)
  })
}

/** 医生端：某患者的历史建议 */
export function listPatientNotesForDoctor(patientId, { limit = 50 } = {}) {
  return listPatientNotes(patientId, { limit })
}

/** 未读数（患者端角标） */
export function countUnreadNotes(patientId) {
  const row = get('SELECT COUNT(*) AS c FROM doctor_notes WHERE patient_id = ? AND is_read = 0', patientId)
  return row?.c ?? 0
}

/** 标记已读（患者端） */
export function markNoteRead(patientId, noteId) {
  const row = get('SELECT * FROM doctor_notes WHERE note_id = ? AND patient_id = ?', noteId, patientId)
  if (!row) {
    throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到该建议：${noteId}`, { patientId, noteId })
  }
  openDb().prepare('UPDATE doctor_notes SET is_read = 1 WHERE note_id = ? AND patient_id = ?').run(noteId, patientId)
  return { noteId, isRead: true }
}

/** 指定医生名下的建议总数（医生端概览统计用） */
export function countDoctorNotes(doctorId) {
  const row = get('SELECT COUNT(*) AS c FROM doctor_notes WHERE doctor_id = ?', String(doctorId || ''))
  return row?.c ?? 0
}
