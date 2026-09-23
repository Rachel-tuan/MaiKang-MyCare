/**
 * 迈康 MyCare · SQLite 访问层（dataProvider 专用）
 * ---------------------------------------------------------------------------
 * 驱动：Node 22 内置 node:sqlite（DatabaseSync）—— 零第三方依赖。
 * 数据库：<rootDir>/data/mycare.db（Step 1 建库 / Step 2 灌种子）。
 *
 * 本模块只做「打开连接 + 通用查询 + 结构自省」，
 * 不含任何业务语义，也不读取 src/data/demoPatients.js。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

import { config } from '../config.js'
import { DataProviderError, ERROR_CODES } from './errors.js'

/** 允许用 MYCARE_DB_PATH 覆盖（测试/备份库用），默认 data/mycare.db */
export const DB_PATH =
  process.env.MYCARE_DB_PATH || path.join(config.rootDir, 'data', 'mycare.db')

let _db = null
const _columnsCache = new Map()

/** 打开（并复用）数据库连接；失败一律抛 E_DB_UNAVAILABLE */
export function openDb() {
  if (_db) return _db
  if (!fs.existsSync(DB_PATH)) {
    throw new DataProviderError(
      ERROR_CODES.E_DB_UNAVAILABLE,
      `数据库文件不存在：${DB_PATH}。请先运行 node scripts/db/build-sqlite.mjs 与 node scripts/db/seed-sqlite.mjs`,
      { dbPath: DB_PATH }
    )
  }
  try {
    _db = new DatabaseSync(DB_PATH)
    _db.exec('PRAGMA foreign_keys = ON;')
    return _db
  } catch (err) {
    throw new DataProviderError(ERROR_CODES.E_DB_UNAVAILABLE, `打开数据库失败：${err.message}`, {
      dbPath: DB_PATH,
    })
  }
}

export function closeDb() {
  if (_db) {
    try {
      _db.close()
    } catch {
      /* ignore */
    }
    _db = null
  }
}

/** 该表是否真实存在（用于 source_not_built 判定，不臆造） */
export function tableExists(table) {
  const db = openDb()
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
    return Boolean(row)
  } catch (err) {
    throw new DataProviderError(ERROR_CODES.E_DB_UNAVAILABLE, `结构自省失败：${err.message}`, { table })
  }
}

/** 表的列名集合（缓存），用于判定 record_status / measure_type 等可选列是否存在 */
export function tableColumns(table) {
  if (_columnsCache.has(table)) return _columnsCache.get(table)
  if (!tableExists(table)) return new Set()
  const db = openDb()
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))
  _columnsCache.set(table, cols)
  return cols
}

/** 通用查询：返回多行 */
export function all(sql, ...params) {
  const db = openDb()
  try {
    return db.prepare(sql).all(...params)
  } catch (err) {
    throw new DataProviderError(ERROR_CODES.E_DB_UNAVAILABLE, `查询失败：${err.message}`, { sql, params })
  }
}

/** 通用查询：返回单行或 undefined */
export function get(sql, ...params) {
  const db = openDb()
  try {
    return db.prepare(sql).get(...params)
  } catch (err) {
    throw new DataProviderError(ERROR_CODES.E_DB_UNAVAILABLE, `查询失败：${err.message}`, { sql, params })
  }
}

/** 已建表清单（供验证脚本对照 P0 22 张） */
export function listTables() {
  return all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name)
}
