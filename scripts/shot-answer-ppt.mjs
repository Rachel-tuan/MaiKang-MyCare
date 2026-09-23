/**
 * 答辩 PPT 截图脚本（当前版本 UI · 2026-09-17）
 * 用法：PW_PATH=<playwright路径> APP_BASE=http://127.0.0.1:3011 node scripts/shot-answer-ppt.mjs
 * 产出：ppt/迈康MyCare_答辩PPT/assets/*.png
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW_PATH)
const BASE = process.env.APP_BASE || 'http://127.0.0.1:3011'
const OUT = 'ppt/迈康MyCare_答辩PPT/assets'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge' })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN' })
const p = await ctx.newPage()

async function shot(name) {
  await p.waitForTimeout(600)
  await p.screenshot({ path: `${OUT}/${name}.png` })
  console.log('SHOT', name, p.url())
}

/* 1. 登录页 */
await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await p.waitForSelector('.demo-card', { timeout: 20000 })
await shot('01_login')

/* 2. 一键进入示范病例（张建国）→ 首页 */
await p.locator('.demo-card').first().click()
await p.waitForURL(/\/$/, { timeout: 20000 }).catch(() => {})
await p.waitForTimeout(2500)
await shot('02_home_top')
await p.evaluate(() => window.scrollTo(0, 99999))
await p.waitForTimeout(800)
await shot('03_home_bottom')

/* 3. 数据记录页 */
await p.goto(`${BASE}/data-record`, { waitUntil: 'networkidle' })
await p.waitForTimeout(1500)
await shot('04_data_record')

/* 4. 智能体中心（协同过程） */
await p.goto(`${BASE}/agents`, { waitUntil: 'networkidle' })
await p.waitForTimeout(1500)
await shot('05_agents_center')

/* 5. 智能体对话：发一条消息 */
const ask = p.locator('textarea, input[placeholder*="问"]').first()
if (await ask.count()) {
  await ask.fill('我最近血压有点偏高，平时要注意什么？')
  await p.keyboard.press('Enter')
  await p.waitForTimeout(6000)
}
await shot('06_agent_chat')

/* 6. 健康建议页 */
await p.goto(`${BASE}/prescription`, { waitUntil: 'networkidle' })
await p.waitForTimeout(1500)
await shot('07_advice')

/* 7. 医生端（默认患者页签） */
await p.goto(`${BASE}/doctor`, { waitUntil: 'networkidle' })
await p.waitForTimeout(2000)
await shot('08_doctor_patients')

/* 8. 医生端 · 待审核页签 */
const auditTab = p.locator('.ant-tabs-tab', { hasText: '待审核' })
if (await auditTab.count()) {
  await auditTab.click()
  await p.waitForTimeout(1500)
}
await shot('09_doctor_audit')

/* 9. 勋章页（激励体系） */
await p.goto(`${BASE}/badges`, { waitUntil: 'networkidle' })
await p.waitForTimeout(1500)
await shot('10_badges')

await browser.close()
console.log('ALL DONE')
