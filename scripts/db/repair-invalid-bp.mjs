#!/usr/bin/env node
/**
 * 迈康 MyCare · 血压脏数据修复：作废但不删除（Step 9）
 * ===========================================================================
 * 背景
 *   真实库 data/mycare.db 里出现过一条生理上不可能的记录：
 *     patient_1 · 2026-09-14 · 收缩压 90 / 舒张压 120
 *   （收缩压必须大于舒张压）。它会污染确定性规则判定 —— 实测会把
 *   张建国从「R-BP-2 预警」错判成「R-BP-3 紧急」，与冻结的演示人设冲突。
 *
 * 处置口径（用户确认）
 *   · **作废，不删除**：把该行标记为 `record_status='void'`，**保留原值**以便追溯。
 *   · 读取层已同步过滤 void（patientService.getPatientRecords / dataProvider 指标序列），
 *     因此作废后该行既不进入 7 天窗口，也不参与规则判定。
 *   · 若该日之后产生了新的有效测量（readings），
 *     `recomputeDailyCompat` 会用新测量重建当日兼容值并把状态恢复为 valid。
 *
 * 用法
 *   node scripts/db/repair-invalid-bp.mjs --dry-run    # 只报告，不写入
 *   node scripts/db/repair-invalid-bp.mjs              # 执行作废
 *   MYCARE_DB_PATH=xxx node scripts/db/repair-invalid-bp.mjs
 *
 * 注意
 *   · 只做「标记 void」，**绝不 DELETE、绝不改写原值**。
 *   · 默认作用于 data/mycare.db；演示/验收副本库由 reset-demo.mjs 从干净种子重建，
 *     天然不含此类脏数据，无需修复。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const DB_PATH = process.env.MYCARE_DB_PATH
  ? resolve(process.env.MYCARE_DB_PATH)
  : resolve(ROOT, 'data', 'mycare.db')

const DRY_RUN = process.argv.includes('--dry-run')
const line = '─'.repeat(78)

/** 生理合理性判定（与录入侧 appendBloodPressureReading 的校验口径一致） */
const SYS_RANGE = [60, 300]
const DIA_RANGE = [30, 200]
const outOfRange = (v, [lo, hi]) => v !== null && v !== undefined && (v < lo || v > hi)

if (!existsSync(DB_PATH)) {
  console.error(`❌ 数据库不存在：${DB_PATH}`)
  process.exit(1)
}

const db = new DatabaseSync(DB_PATH)

console.log(line)
console.log(`迈康 MyCare · 血压脏数据作废修复${DRY_RUN ? '（DRY-RUN，不写入）' : ''}`)
console.log(line)
console.log(`目标库 : ${DB_PATH}`)
console.log(line)

const rows = db
  .prepare(
    `SELECT patient_id, record_date, systolic_pressure AS sys, diastolic_pressure AS dia, record_status
       FROM daily_health_records
      WHERE (systolic_pressure IS NOT NULL AND diastolic_pressure IS NOT NULL
             AND systolic_pressure <= diastolic_pressure)
         OR (systolic_pressure IS NOT NULL AND (systolic_pressure < ? OR systolic_pressure > ?))
         OR (diastolic_pressure IS NOT NULL AND (diastolic_pressure < ? OR diastolic_pressure > ?))
      ORDER BY patient_id, record_date`
  )
  .all(SYS_RANGE[0], SYS_RANGE[1], DIA_RANGE[0], DIA_RANGE[1])

const targets = rows.filter((r) => r.record_status !== 'void')

if (!rows.length) {
  console.log('✅ 未发现生理上不可能的血压记录，无需修复。')
  db.close()
  process.exit(0)
}

console.log(`命中可疑记录 ${rows.length} 行（其中需作废 ${targets.length} 行）：`)
for (const r of rows) {
  const reason = r.sys <= r.dia ? '收缩压 ≤ 舒张压（生理不可能）' : '数值超出可录入范围'
  console.log(`  ${r.patient_id}  ${r.record_date}  ${r.sys}/${r.dia}  status=${r.record_status}  ← ${reason}`)
}
console.log(line)

if (!targets.length) {
  console.log('✅ 可疑记录均已作废，无需再处理。')
  db.close()
  process.exit(0)
}

if (DRY_RUN) {
  console.log('DRY-RUN：以上记录将被标记 record_status=void（原值保留、不删除）。')
  console.log('去掉 --dry-run 即执行。')
  db.close()
  process.exit(0)
}

db.exec('BEGIN')
try {
  const stmt = db.prepare(
    `UPDATE daily_health_records
        SET record_status = 'void',
            updated_at    = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
      WHERE patient_id = ? AND record_date = ?`
  )
  for (const r of targets) stmt.run(r.patient_id, r.record_date)
  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  console.error('❌ 作废失败，已回滚：', e.message)
  db.close()
  process.exit(1)
}

console.log(`✅ 已作废 ${targets.length} 行（原值保留，仅标记 record_status='void'）`)
for (const r of targets) {
  const after = db
    .prepare('SELECT systolic_pressure AS sys, diastolic_pressure AS dia, record_status FROM daily_health_records WHERE patient_id=? AND record_date=?')
    .get(r.patient_id, r.record_date)
  console.log(`  ${r.patient_id}  ${r.record_date}  ${after.sys}/${after.dia}  status=${after.record_status}`)
}

const voids = db
  .prepare("SELECT COUNT(*) AS c FROM daily_health_records WHERE record_status = 'void'")
  .get().c
console.log(line)
console.log(`当前 void 行合计：${voids}`)
console.log('提示：作废后该日不进入 7 天窗口与规则判定；若当日产生新的有效测量，会由新测量重建并恢复 valid。')
console.log(line)

db.close()
