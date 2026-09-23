/**
 * Render / 线上环境启动入口
 * ---------------------------------------------------------------------------
 * 1) 确保 data 目录存在
 * 2) 首次启动时自动初始化演示数据库（之后重启保留数据）
 * 3) 启动 Express 服务
 */
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, 'data')
const DEMO_DB = resolve(DATA_DIR, 'mycare-demo.db')

// 确保 data 目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true })
  console.log('[start] created data/ directory')
}

// 首次启动：初始化演示数据库
if (!existsSync(DEMO_DB)) {
  console.log('[start] database not found, seeding demo data ...')
  const r = spawnSync(
    process.execPath,
    [resolve(__dirname, 'scripts', 'db', 'reset-demo.mjs')],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) {
    console.warn('[start] seed failed, continuing anyway ...')
  }
} else {
  console.log('[start] using existing database:', DEMO_DB)
}

// 设置数据库路径（必须在导入 server 之前）
process.env.MYCARE_DB_PATH = DEMO_DB
console.log('[start] MYCARE_DB_PATH =', process.env.MYCARE_DB_PATH)

// 启动服务
await import('./server/index.js')
