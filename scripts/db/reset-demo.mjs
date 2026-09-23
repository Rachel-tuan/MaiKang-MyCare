#!/usr/bin/env node
/**
 * 迈康 MyCare · 演示 / 验收副本库一键重建（Step 9）
 * ===========================================================================
 * 目的
 *   · 演示与验收**不再直接跑在真实库** data/mycare.db 上。
 *     真实库里可能有真实注册账号、被反复演示改写的 daily 行等"现场痕迹"，
 *     直接拿它演示，第二次演示就会叠加痕迹，也无法复现冻结口径。
 *   · 本脚本从**冻结种子源**（src/data/demoPatients.js）重建一份干净副本库，
 *     使演示可反复重放、结果可复现，真实库全程零改动。
 *
 * 产出
 *   data/mycare-demo.db（可用 MYCARE_DEMO_DB_PATH 覆盖）
 *   —— 3 位示范患者、每位 7 天 daily、alerts 干净重建，无注册残留账号。
 *
 * 用法
 *   node scripts/db/reset-demo.mjs
 *   SEED_END_DATE=2026-09-14 node scripts/db/reset-demo.mjs    # 指定 7 天窗口末日
 *
 * 用副本库跑应用 / 跑验收
 *   MYCARE_DB_PATH=data/mycare-demo.db node server/index.js
 *
 * 注意
 *   · 只重建副本库，**绝不动** data/mycare.db。
 *   · 种子 7 天窗口末日默认为「中国时区的今天」，与既有验收脚本的日期口径一致。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')

const DEMO_DB = process.env.MYCARE_DEMO_DB_PATH
  ? resolve(process.env.MYCARE_DEMO_DB_PATH)
  : resolve(ROOT, 'data', 'mycare-demo.db')
const REAL_DB = resolve(ROOT, 'data', 'mycare.db')

/** 中国时区（UTC+8）的今天，避免机器时区导致串日 */
const cstToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

if (DEMO_DB === REAL_DB) {
  console.error('❌ 拒绝把副本库指向真实库 data/mycare.db（会清空真实数据）')
  process.exit(1)
}

const line = '─'.repeat(78)
console.log(line)
console.log('迈康 MyCare · 演示 / 验收副本库重建')
console.log(line)
console.log(`副本库 : ${DEMO_DB}`)
console.log(`真实库 : ${REAL_DB}  ← 全程只读，不会被本脚本改动`)
console.log(line)

if (existsSync(DEMO_DB)) {
  rmSync(DEMO_DB)
  console.log('· 旧副本库已删除')
}

const runStep = (script, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [resolve(__dirname, script)], {
    cwd: ROOT,
    env: { ...process.env, MYCARE_DB_PATH: DEMO_DB, ...extraEnv },
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error(`❌ ${script} 失败（退出码 ${r.status}）`)
    process.exit(r.status ?? 1)
  }
}

const END = process.env.SEED_END_DATE || cstToday()
runStep('build-sqlite.mjs')
runStep('seed-sqlite.mjs', { SEED_END_DATE: END })

/* ------------------------------ 结果核对 ------------------------------ */
const db = new DatabaseSync(DEMO_DB, { readOnly: true })
const one = (sql, ...p) => db.prepare(sql).get(...p)
const tables = one("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").c
const patients = one('SELECT COUNT(*) AS c FROM patients').c
const daily = one('SELECT COUNT(*) AS c FROM daily_health_records').c
const alerts = one('SELECT COUNT(*) AS c FROM alerts').c
const p1 = db
  .prepare(
    `SELECT record_date, systolic_pressure AS sys, diastolic_pressure AS dia
       FROM daily_health_records WHERE patient_id='patient_1' ORDER BY record_date`
  )
  .all()
const badBp = one(
  `SELECT COUNT(*) AS c FROM daily_health_records
    WHERE systolic_pressure IS NOT NULL AND diastolic_pressure IS NOT NULL
      AND systolic_pressure <= diastolic_pressure`
).c

db.close()

console.log(line)
console.log('核对结果')
console.log(`  表数量         : ${tables}（P0 22 张）`)
console.log(`  患者           : ${patients}（3 位示范病例，无注册残留）`)
console.log(`  daily 记录     : ${daily}（3 × 7 天）`)
console.log(`  alerts         : ${alerts}（种子重建后由 orchestrator 落库）`)
console.log(`  patient_1 血压 : ${p1.map((r) => `${r.record_date.slice(5)} ${r.sys}/${r.dia}`).join('  ')}`)
console.log(`  生理不可能血压 : ${badBp} 行（应为 0）`)
console.log(line)

if (patients !== 3 || badBp !== 0) {
  console.error('❌ 副本库未达到干净口径，请检查上方步骤输出')
  process.exit(1)
}

console.log('✅ 副本库就绪。演示 / 验收请使用：')
console.log(`   MYCARE_DB_PATH=${DEMO_DB} node server/index.js`)
console.log(line)
