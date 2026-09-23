/**
 * 迈康 MyCare · 预警落库 / 读取（第二阶段 Step 5）
 * ===========================================================================
 * 闭环定位：
 *   patient_id → dataProvider → Agent → **确定性规则** → alerts 落库 → 医生 / 患者端读取
 *
 * 铁律（Step 5 红线，任何改动都不得违背）：
 *   1. 写入 alerts 的 **等级与依据只能来自 `clinicalRules` 的确定性命中结果**
 *      （`rule.level → 产品词表`、`rule.basis → detail`）。AI 只负责在既有链路上做自然语言
 *      表达，**不得**决定或改写预警等级、阈值、达标率。
 *   2. 外部通知（家属 / 医生）遵循「联系人已授权 + 用户本人点击确认」双条件。
 *      落库时一律**只记录不外发**：`notify_targets=['self']`，待确认对象写 `pending_notify`，
 *      `external_blocked=1`、`confirmed=0`。真实外发通道（短信/微信/Push）本阶段未实现。
 *   3. 落库为「每（患者·规则·自然日）一行」的幂等 upsert，避免重复运行造成告警风暴。
 *   4. 库存文本 `level` 使用产品词表（提示 / 关注 / 预警 / 紧急），
 *      **严禁**写入「高危 / 中危 / 低危」等医学危险分层术语。
 */
import { get, all, openDb } from './db.js'
import { DataProviderError, ERROR_CODES, asDataProviderError } from './errors.js'
import { ALERT_LEVEL } from '../../src/utils/clinicalRules.js'

/**
 * 入库的规则等级：关注 / 预警 / 紧急。
 * 「提示」级（info）多为正向激励（记录达成、减重进展、运动达标）或单次轻微异常，
 * 与既有医生端「预警」语义（emergency/alert/watch）保持一致，故不入库，避免噪声。
 */
const PERSIST_LEVELS = ['emergency', 'alert', 'watch']

const pad = (n) => String(n).padStart(2, '0')
const dayKeyOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const levelLabelOf = (key) => ALERT_LEVEL[key]?.label || '提示'

/** 规则等级 → 待确认的外部通知对象（仍需本人确认；落库时一律不外发） */
const pendingTargetsOf = (levelKey) =>
  levelKey === 'emergency' ? ['family', 'doctor'] : ['family']

const safeJson = (text, fallback) => {
  if (text === null || text === undefined || text === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

const assertPatientId = (patientId, fn) => {
  if (typeof patientId !== 'string' || patientId.trim() === '') {
    throw new DataProviderError(ERROR_CODES.E_INVALID_ARG, 'patientId 必填且不能为空', {
      fn,
      patientId: patientId ?? null,
    })
  }
}

/** 患者必须存在，否则 E_PATIENT_NOT_FOUND（不回落默认患者） */
const assertPatientExists = (patientId, fn) => {
  const row = get('SELECT patient_id FROM patients WHERE patient_id = ?', patientId)
  if (!row) {
    throw new DataProviderError(ERROR_CODES.E_PATIENT_NOT_FOUND, `未找到患者：${patientId}`, {
      fn,
      patientId,
    })
  }
}

const toAlertView = (r) => ({
  alertId: r.alert_id,
  id: r.alert_id,
  patientId: r.patient_id,
  // 已是产品词表（提示 / 关注 / 预警 / 紧急）
  level: r.level,
  levelKey: Object.keys(ALERT_LEVEL).find((k) => ALERT_LEVEL[k].label === r.level) || null,
  title: r.title,
  detail: r.detail,
  action: r.action,
  ruleId: r.rule_id,
  notifyTargets: safeJson(r.notify_targets, []),
  pendingNotify: safeJson(r.pending_notify, []),
  externalBlocked: Boolean(r.external_blocked),
  confirmed: Boolean(r.confirmed),
  source: r.source,
  createdAt: r.created_at,
})

/* ================================================================== *
 * 1. 落库：确定性规则命中 → alerts
 * ================================================================== */
export async function persistRuleAlerts(patientId, evaluation, { source = 'rule_engine' } = {}) {
  try {
    assertPatientId(patientId, 'persistRuleAlerts')

    const rules = (evaluation?.matched || []).filter((r) => PERSIST_LEVELS.includes(r.level))
    const day = dayKeyOf()
    const result = { patientId, source, inserted: 0, updated: 0, alerts: [] }
    if (!rules.length) return result

    const db = openDb()
    const selectExisting = db.prepare(
      `SELECT alert_id FROM alerts
        WHERE patient_id = ? AND rule_id = ? AND substr(created_at, 1, 10) = ?`
    )
    const updateStmt = db.prepare(
      `UPDATE alerts
          SET level = ?, title = ?, detail = ?, action = ?,
              notify_targets = ?, pending_notify = ?,
              external_blocked = 1, confirmed = 0, source = ?
        WHERE alert_id = ?`
    )
    const insertStmt = db.prepare(
      `INSERT INTO alerts
         (patient_id, level, title, detail, action,
          notify_targets, pending_notify, external_blocked, confirmed, rule_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
    )

    for (const r of rules) {
      const levelLabel = levelLabelOf(r.level)
      const notifyTargets = JSON.stringify(['self'])
      const pendingNotify = JSON.stringify(pendingTargetsOf(r.level))

      const existing = selectExisting.get(patientId, r.ruleId, day)
      if (existing) {
        updateStmt.run(
          levelLabel,
          r.title ?? null,
          r.basis ?? null,
          r.action ?? null,
          notifyTargets,
          pendingNotify,
          source,
          existing.alert_id
        )
        result.updated += 1
        result.alerts.push({
          alertId: existing.alert_id,
          ruleId: r.ruleId,
          level: levelLabel,
          title: r.title,
          updated: true,
        })
      } else {
        const info = insertStmt.run(
          patientId,
          levelLabel,
          r.title ?? null,
          r.basis ?? null,
          r.action ?? null,
          notifyTargets,
          pendingNotify,
          r.ruleId,
          source
        )
        result.inserted += 1
        result.alerts.push({
          alertId: Number(info.lastInsertRowid),
          ruleId: r.ruleId,
          level: levelLabel,
          title: r.title,
          created: true,
        })
      }
    }
    return result
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'persistRuleAlerts', patientId })
  }
}

/* ================================================================== *
 * 2. 读取：患者端 / 医生端
 * ================================================================== */
export async function listPatientAlerts(patientId, { limit = 20 } = {}) {
  try {
    assertPatientId(patientId, 'listPatientAlerts')
    assertPatientExists(patientId, 'listPatientAlerts')
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100)
    const rows = all(
      `SELECT alert_id, patient_id, level, title, detail, action,
              notify_targets, pending_notify, external_blocked, confirmed,
              rule_id, source, created_at
         FROM alerts
        WHERE patient_id = ?
        ORDER BY datetime(created_at) DESC, alert_id DESC
        LIMIT ?`,
      patientId,
      n
    )
    return { patientId, count: rows.length, alerts: rows.map(toAlertView) }
  } catch (err) {
    throw asDataProviderError(err, ERROR_CODES.E_INTERNAL, { fn: 'listPatientAlerts', patientId })
  }
}

/** 医生端：某患者最近若干条落库预警（供 doctor 列表卡片使用） */
export async function listPatientAlertRecords(patientId, { limit = 5 } = {}) {
  const { alerts } = await listPatientAlerts(patientId, { limit })
  return alerts
}

/** 仅统计（不读明细），供列表页轻量使用 */
export function countPatientAlerts(patientId) {
  const row = get('SELECT COUNT(*) AS c FROM alerts WHERE patient_id = ?', patientId)
  return row?.c ?? 0
}

export { PERSIST_LEVELS, levelLabelOf, toAlertView }
