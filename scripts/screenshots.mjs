/**
 * 迈康 MyCare · 界面截图脚本
 * 用 Playwright 驱动本机 Microsoft Edge，登录后逐页截图，并真实触发一次多智能体协同。
 * 用法: node scripts/screenshots.mjs [输出目录]
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { toUserProfile, DEFAULT_PATIENT_ID, getPatientById } from '../src/data/demoPatients.js'

const require = createRequire(import.meta.url)
// playwright 装在托管工作区，用绝对路径解析（ESM 不认 NODE_PATH）
const { chromium } = require(process.env.PW_PATH || 'playwright')

const BASE = process.env.APP_BASE || 'http://127.0.0.1:3000'
const OUT = process.argv[2] || path.join(process.cwd(), 'screenshots')
fs.mkdirSync(OUT, { recursive: true })

// —— 演示身份统一取自唯一数据源 src/data/demoPatients.js ——
// 不再在本脚本里硬编码一份可能过期的用户档案。
const DEMO_PATIENT = getPatientById(process.env.DEMO_PATIENT_ID || DEFAULT_PATIENT_ID)
const DEMO_USER = toUserProfile(DEMO_PATIENT)

/** 写入演示身份，并清空旧健康数据，交由应用按 demoPatients.js 重新载入固定脚本 */
const seedIdentity = (target, user) =>
  target.evaluate((u) => {
    localStorage.setItem('user', JSON.stringify(u))
    localStorage.setItem(
      'userSettings',
      JSON.stringify({ elderlyMode: u.elderly_mode, voiceEnabled: u.voice_enabled }),
    )
    localStorage.removeItem('healthRecords')
    localStorage.removeItem('badges')
    localStorage.removeItem('prescriptions')
    localStorage.removeItem('userPoints')
  }, user)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ channel: 'msedge' })
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
})
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)) })

const shots = []
async function shot(name, { full = false, wait = 900 } = {}) {
  await sleep(wait)
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage: full })
  const kb = (fs.statSync(file).size / 1024).toFixed(0)
  shots.push(`${name}.png`)
  console.log(`  ✓ ${name}.png (${kb} KB)`)
}

async function go(route, name, opt) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' })
  await shot(name, opt)
}

console.log('\n[1] 登录页')
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await shot('01-登录页', { full: true })

console.log('\n[2] 注入演示用户并进入应用')
await seedIdentity(page, DEMO_USER)

console.log('\n[3] 首页')
await go('/', '02-首页-健康总览', { full: true })

console.log('\n[4] 智能体中心')
await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' })
await shot('03-智能体中心-待命', { full: true })

// 真实触发一次多智能体协同
console.log('  → 点击「启动协同」并等待推理完成…')
const started = Date.now()
try {
  await page.getByRole('button', { name: /启动协同/ }).click({ timeout: 8000 })
} catch {
  await page.locator('button:has-text("启动协同")').first().click({ timeout: 8000 })
}
// 抓一张“推理中”的瞬间
await sleep(1200)
await shot('04-智能体中心-协同推理中', { wait: 0 })

// 等待协同结束（出现“协同结束”事件或按钮恢复）
for (let i = 0; i < 90; i++) {
  await sleep(1000)
  const btn = await page.locator('button:has-text("启动协同")').count()
  const done = await page.locator('text=协同结束').count()
  if (btn > 0 || done > 0) break
}
console.log(`  → 协同耗时约 ${((Date.now() - started) / 1000).toFixed(1)}s`)
await shot('05-智能体中心-协同结果', { full: true, wait: 800 })

// 事件流视图
try {
  await page.locator('.ant-segmented-item:has-text("事件流")').click({ timeout: 5000 })
  await shot('06-智能体中心-事件流', { wait: 700 })
} catch (e) { console.log('  ! 事件流切换失败:', e.message.split('\n')[0]) }

// 返回卡片视图 + 智能体对话
try {
  await page.locator('.ant-segmented-item:has-text("卡片")').click({ timeout: 5000 })
  await page.locator('.ant-tabs-tab:has-text("智能体对话")').click({ timeout: 5000 })
  await sleep(600)
  const box = page.locator('textarea').first()
  if (await box.count()) {
    await box.fill('我最近血压有点高，今天应该注意什么？')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(6000)
  }
  await shot('07-智能体对话', { full: true, wait: 500 })
} catch (e) { console.log('  ! 对话截图失败:', e.message.split('\n')[0]) }

// 图像解读
try {
  await page.locator('.ant-tabs-tab:has-text("图像解读")').click({ timeout: 5000 })
  await shot('08-图像解读', { wait: 900 })
} catch (e) { console.log('  ! 图像解读截图失败:', e.message.split('\n')[0]) }

console.log('\n[5] 其余页面')
await go('/prescription', '09-健康建议', { full: true })
await go('/data-record', '10-数据记录', { full: true })
await go('/badges', '11-健康勋章', { full: true })
await go('/doctor', '12-医生端', { full: true })
await go('/profile', '13-我的', { full: true })

// 移动端视图（老年机适配）
console.log('\n[6] 移动端视图')
const mctx = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
})
const mp = await mctx.newPage()
await mp.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await seedIdentity(mp, DEMO_USER)
await mp.goto(`${BASE}/agents`, { waitUntil: 'networkidle' })
await sleep(1200)
await mp.screenshot({ path: path.join(OUT, '14-移动端-智能体中心.png') })
console.log('  ✓ 14-移动端-智能体中心.png')

await browser.close()
console.log(`\n完成，共 ${shots.length + 1} 张，输出目录：${OUT}`)
