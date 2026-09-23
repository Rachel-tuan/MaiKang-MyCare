/**
 * 迈康 MyCare · 演示视频录制脚本
 * 用 Playwright 驱动本机 Edge 录制真实操作流程，并在页面底部叠加解说字幕。
 * 产出 webm，再由 ffmpeg 转码为 MP4。
 * 用法: node scripts/demo-video.mjs <输出目录>
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { toUserProfile, DEFAULT_PATIENT_ID, getPatientById } from '../src/data/demoPatients.js'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW_PATH || 'playwright')

const BASE = process.env.APP_BASE || 'http://127.0.0.1:3000'
const OUT = process.argv[2] || path.join(process.cwd(), 'video')
fs.mkdirSync(OUT, { recursive: true })

const W = 1366, H = 768

// —— 演示身份统一取自唯一数据源 src/data/demoPatients.js ——
const DEMO_PATIENT = getPatientById(process.env.DEMO_PATIENT_ID || DEFAULT_PATIENT_ID)
const DEMO_USER = toUserProfile(DEMO_PATIENT)
const DEMO_USERNAME = DEMO_USER.username

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const browser = await chromium.launch({ channel: 'msedge' })
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
  recordVideo: { dir: OUT, size: { width: W, height: H } },
})
const page = await ctx.newPage()

/** 在页面底部叠加解说字幕（导航后需重新注入） */
async function caption(text, sub = '') {
  await page.evaluate(({ text, sub }) => {
    let el = document.getElementById('demo-caption')
    if (!el) {
      el = document.createElement('div')
      el.id = 'demo-caption'
      el.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
        'padding:54px 56px 26px', 'text-align:center', 'pointer-events:none',
        'background:linear-gradient(to bottom, rgba(15,23,42,0) 0%, rgba(15,23,42,0.72) 45%, rgba(15,23,42,0.94) 100%)',
        'font-family:"Microsoft YaHei","PingFang SC",sans-serif', 'color:#fff',
        'transition:opacity .35s ease'
      ].join(';')
      const inner = document.createElement('div')
      inner.id = 'demo-caption-inner'
      el.appendChild(inner)
      document.body.appendChild(el)
    }
    const inner = document.getElementById('demo-caption-inner')
    inner.innerHTML =
      `<div style="font-size:22px;font-weight:700;letter-spacing:.6px;text-shadow:0 2px 12px rgba(0,0,0,.5)">${text}</div>` +
      (sub ? `<div style="font-size:14px;opacity:.85;margin-top:8px;letter-spacing:.4px">${sub}</div>` : '')
  }, { text, sub })
}

const hold = (ms) => sleep(ms)

/** 平滑滚动到页面某比例位置 */
async function scrollTo(ratio, ms = 900) {
  await page.evaluate(({ ratio, ms }) => {
    const y = (document.documentElement.scrollHeight - window.innerHeight) * ratio
    window.scrollTo({ top: y, behavior: 'smooth' })
  }, { ratio, ms })
  await sleep(ms)
}

console.log('● 开始录制…')

// ---------------------------------------------------------------- 1. 登录页
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await caption('迈康 MyCare · 老年慢病多智能体协同健康管理平台', '人工智能及应用大类 · 智能体赛道')
await hold(4200)

await caption('适老化登录：大字号、高对比、支持语音播报')
await page.fill('input[placeholder="请输入用户名"]', DEMO_USERNAME)
await hold(900)
await page.fill('input[placeholder="请输入密码"]', 'demo123456')
await hold(900)
await page.click('button[type="submit"]')
await hold(2600)

// 登录成功后确保进入应用（身份与数据同样来自 demoPatients.js）
await seedIdentity(page, DEMO_USER)

// ---------------------------------------------------------------- 2. 首页
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await sleep(1200)
await caption('健康总览：今日体征、健康评分、用药与运动待办', '数据由风险引擎按最新体征实时计算')
await hold(4200)
await scrollTo(0.45)
await caption('八项体征一键读懂：血压、血糖、步数、睡眠与情绪')
await hold(3600)
await scrollTo(1)
await hold(1200)

// ---------------------------------------------------------------- 3. 智能体中心
await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' })
await sleep(1200)
await caption('智能体中心：六个智能体分工协作的可视化控制台', '体征分析 · 风险预警 · 方案规划 · 健康管家 · 多模态识别 · 情感陪伴')
await hold(4600)

await caption('点击「启动协同」，由智能体自主完成整条决策链')
await hold(1600)

try {
  await page.locator('button:has-text("启动协同")').first().click({ timeout: 6000 })
} catch (e) { console.log('  ! 启动协同点击失败:', e.message.split('\n')[0]) }

await sleep(1400)
await caption('推理中：每个智能体独立产出思考链，并把上下文交接给下一个', '感知 → 分析 → 决策 → 预警 → 汇总')
await hold(5200)

// 等协同结束
const t0 = Date.now()
for (let i = 0; i < 60; i++) {
  await sleep(700)
  if (await page.locator('button:has-text("启动协同")').count() > 0) break
}
console.log(`  → 协同耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
await sleep(600)

await caption('协同完成：四个智能体按依赖拓扑依次产出结论')
await hold(4200)
await scrollTo(0.35)
await caption('风险预警智能体自主调用工具，真实生成预警记录与提醒')
await hold(3800)

// 事件流
try {
  await page.locator('.ant-segmented-item:has-text("事件流")').click({ timeout: 4000 })
  await sleep(800)
  await caption('切换事件流视图：逐条核查智能体的推理、工具调用与交接', '全过程可追溯，可解释性做到产品级')
  await hold(4200)
} catch (e) { console.log('  ! 事件流切换失败') }

// 协同结果面板
try {
  await page.locator('.ant-segmented-item:has-text("卡片")').click({ timeout: 4000 })
} catch {}
await page.locator('.ant-tabs-tab:has-text("协同结果")').click({ timeout: 4000 }).catch(() => {})
await sleep(700)
await scrollTo(0.62)
await caption('协同结果：今日简报 + 风险清单 + 个性化干预方案')
await hold(4200)

// ---------------------------------------------------------------- 4. 智能体对话
await page.locator('.ant-tabs-tab:has-text("智能体对话")').click({ timeout: 5000 }).catch(() => {})
await sleep(900)
await scrollTo(0.5)
await caption('与健康管家对话：可追问、可追问细节，回答基于你的真实档案')
await hold(1800)
const box = page.locator('textarea').first()
if (await box.count()) {
  await box.click()
  await box.type('我最近血压有点高，今天应该注意什么？', { delay: 55 })
  await page.keyboard.press('Enter')
  await sleep(5200)
  await caption('回答由大模型生成，数值一律来自确定性算法，杜绝数值幻觉')
  await hold(3800)
}

// ---------------------------------------------------------------- 5. 图像解读
await page.locator('.ant-tabs-tab:has-text("图像解读")').click({ timeout: 5000 }).catch(() => {})
await sleep(900)
await caption('多模态：上传药盒或化验单照片，由多模态识别智能体解读', '未配置视觉模型时自动降级为浏览器端 OCR')
await hold(4200)

// ---------------------------------------------------------------- 6. 数据记录
await page.goto(`${BASE}/data-record`, { waitUntil: 'networkidle' })
await sleep(1100)
await caption('数据记录：30 秒完成一次体征录入，越简单越能坚持')
await hold(3600)
await page.locator('.ant-tabs-tab:has-text("趋势分析")').click({ timeout: 4000 }).catch(() => {})
await sleep(900)
await caption('趋势分析：最小二乘拟合描出走向，异常自动标记')
await hold(3600)

// ---------------------------------------------------------------- 7. 勋章
await page.goto(`${BASE}/badges`, { waitUntil: 'networkidle' })
await sleep(1100)
await caption('健康勋章：用行为激励把「要我管」变成「我要管」')
await hold(4000)

// ---------------------------------------------------------------- 8. 收尾
await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' })
await sleep(1200)
await caption('迈康 MyCare —— 把慢病管理交给一个会思考的伙伴', '大模型管语言 · 代码管计算 · 六个智能体协同')
await hold(4400)

const videoPath = await page.video().path()
await ctx.close()
await browser.close()

console.log('● 录制完成:', videoPath)
// 统一改名为可预测的文件名
const target = path.join(OUT, 'demo-raw.webm')
try { fs.renameSync(videoPath, target); console.log('● 已重命名:', target) } catch (e) { console.log('  ! 重命名失败:', e.message) }
