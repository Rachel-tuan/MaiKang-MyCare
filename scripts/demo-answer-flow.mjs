/**
 * 迈康 MyCare · 答辩主线走查脚本（对应答辩视频 8 步）
 * ===========================================================================
 * 目的：在**不改动任何演示库**的前提下，把答辩要讲的整条主线真跑一遍，
 *      每一步落地一张截图（可选整段录像），产出「可照做的分镜」与「可放进 PPT 的图」。
 *
 * 覆盖的 8 步：
 *   ① 注册登录
 *   ② 新用户建档 → 记录今日任务数据 → 看两个评分（规则评分 / AI 辅助分）
 *   ③ 与智能体聊天 → 生成待审提案 → 医生端审结同意 → 患者端今日任务出现
 *   ④ 六个智能体协同（启动协同 → 推理中 → 结果 → 事件流）
 *   ⑤ 智能体对话
 *   ⑥ 健康建议
 *
 * 为什么必须打在副本库上：
 *   注册会落库、提案与审结会写 prescriptions / doctor_notes、
 *   录入体征会写 daily_health_records 并可能生成 alerts。
 *   本脚本一律指向 `APP_BASE`（默认 127.0.0.1:3011 的**副本库实例**），
 *   绝不指向演示实例或真实库。
 *
 * 用法：
 *   # ① 先起一个副本库实例（示例）
 *   cp data/mycare-demo.db data/_rehearsal.db
 *   PORT=3011 MYCARE_DB_PATH=data/_rehearsal.db node server/index.js
 *
 *   # ② 走查（截图）
 *   PW_PATH=<playwright路径> APP_BASE=http://127.0.0.1:3011 node scripts/demo-answer-flow.mjs
 *
 *   # ③ 走查 + 录像（产出 webm，再自行转 MP4）
 *   RECORD=1 ... node scripts/demo-answer-flow.mjs
 * ---------------------------------------------------------------------------
 * 关键设计（踩过的坑）：
 *   · 每一步独立 try/catch —— 单步失败不中断，最后统一出报告；
 *   · 所有「等页面就绪」都用 networkidle + 显式等待目标元素，不靠 sleep 硬等；
 *   · 建档弹窗共 5 步，非当前步的字段是 display:none，
 *     Playwright 对隐藏元素会等到超时，因此**必须逐步点击「下一步」**，
 *     不能一次性把所有字段写完；
 *   · 慢性病**只勾「高血压」**——这样「新增血糖监测」才不会被主诊断派生出来，
 *     第 3 步的提案才有意义（这是答辩最容易讲错的一处）。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW_PATH || 'playwright')

const BASE = process.env.APP_BASE || 'http://127.0.0.1:3011'
const OUT = path.resolve(process.argv[2] || 'docs/answer-shots')
const RECORD = process.env.RECORD === '1'
const VIDEO_DIR = path.resolve(process.env.VIDEO_DIR || 'docs/answer-video')
const USERNAME = process.env.DEMO_USERNAME || `ans${String(Date.now()).slice(-7)}`
const PASSWORD = process.env.DEMO_PASSWORD || 'MyCare2026'
const REAL_NAME = process.env.DEMO_REALNAME || '周桂芳'

fs.mkdirSync(OUT, { recursive: true })
if (RECORD) fs.mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let shotNo = 0
const shots = []
const results = []

async function step(label, fn) {
  try {
    const note = await fn()
    results.push({ label, ok: true, note: note || '' })
    console.log(`PASS  ${label}${note ? `  (${note})` : ''}`)
  } catch (e) {
    const full = String(e.message || e)
    const msg = full.split('\n')[0]
    results.push({ label, ok: false, note: msg })
    console.log(`FAIL  ${label}  -> ${msg}`)
    // 失败现场：不打印的话后面所有步骤都会「在错误的页面上静默跑完」
    try {
      const where = await page.evaluate(() => ({
        path: location.pathname + location.search,
        title: document.title,
        modal: !!document.querySelector('.ant-modal'),
        demoCards: document.querySelectorAll('.demo-card').length,
        tabs: [...document.querySelectorAll('.ant-tabs-tab')].map((e) => e.innerText.trim()).join('|'),
        head: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
      }))
      console.log(`      现场: ${JSON.stringify(where)}`)
    } catch { /* 页面已崩则忽略 */ }
    if (process.env.VERBOSE === '1') console.log(full.split('\n').slice(0, 12).join('\n      '))
  }
}

console.log(`\n答辩主线走查`)
console.log(`  目标实例 : ${BASE}`)
console.log(`  输出目录 : ${OUT}`)
console.log(`  录像     : ${RECORD ? VIDEO_DIR : '关闭'}`)
console.log(`  新账号   : ${USERNAME} / ${PASSWORD}\n`)

const browser = await chromium.launch({ channel: 'msedge' })
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
  ...(RECORD ? { recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 1024 } } } : {}),
})
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('   [console.error]', m.text().slice(0, 140))
})

async function shot(name, { full = false } = {}) {
  shotNo += 1
  const file = path.join(OUT, `${String(shotNo).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file, fullPage: full })
  shots.push(path.basename(file))
  console.log(`   · 截图 ${path.basename(file)}`)
}

/** 页面守卫：断言确实落在预期页面，避免在错误页面上「静默跑完」 */
async function guard(expectText, forbidText = '一键进入示范病例') {
  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 4000))
  if (expectText && !body.includes(expectText)) {
    throw new Error(`页面守卫失败：未找到「${expectText}」（当前 path=${new URL(page.url()).pathname}）`)
  }
  if (forbidText && body.includes(forbidText)) {
    throw new Error(`页面守卫失败：仍停留在登录页（含「${forbidText}」）`)
  }
  return body
}

/* ══════════════════════════ ① 注册登录 ══════════════════════════ */
await step('①-a 登录页', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.demo-card', { timeout: 15000 })
  await shot('登录页-示范入口', { full: true })
  const cards = await page.locator('.demo-card .demo-name').allInnerTexts()
  return `示范病例 ${cards.join('/')}`
})

await step('①-b 注册新账号', async () => {
  await page.locator('.ant-tabs-tab', { hasText: '注册' }).click()
  await page.getByPlaceholder('请输入真实姓名').fill(REAL_NAME)
  await page.getByPlaceholder('请设置用户名（用于后续登录）').fill(USERNAME)
  await page.getByPlaceholder('请设置密码').fill(PASSWORD)
  await page.getByPlaceholder('请再次输入密码').fill(PASSWORD)
  await page.getByPlaceholder('请输入手机号（用于找回密码）').fill('13900001234')
  await page.getByPlaceholder('年龄').fill('68')
  await page.locator('.ant-radio-wrapper', { hasText: '女' }).first().click()
  await page.getByPlaceholder('身高').fill('158')
  await page.getByPlaceholder('体重').fill('66')
  await page.locator('.ant-checkbox-input').first().check({ force: true })
  await shot('注册表单已填')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await page.waitForSelector('.ant-message-success', { timeout: 15000 })
  await sleep(800)
  // 注册后**不自动登录**：回到「登录」页签并回填用户名
  await page.locator('.ant-tabs-tab', { hasText: '登录' }).click()
  await sleep(500)
  await shot('注册成功-回登录页')
  return '注册即落库，不自动登录'
})

await step('①-c 登录', async () => {
  const userBox = page.getByPlaceholder('请输入用户名')
  if ((await userBox.inputValue()) !== USERNAME) await userBox.fill(USERNAME)
  await page.getByPlaceholder('请输入密码').fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 })
  return `已进入 ${new URL(page.url()).pathname}`
})

/* ══════════════ ② 建档弹窗 → 记录数据 → 两个评分 ══════════════ */
await step('②-a 建档弹窗（5 步）', async () => {
  await page.waitForSelector('.ant-modal', { timeout: 20000 })
  await page.waitForSelector('.ant-modal-title:has-text("完善健康档案")', { timeout: 10000 })
  await sleep(600)
  await shot('建档弹窗-第1步')

  // 第 1 步：基本信息
  await page.locator('.ant-modal').getByPlaceholder('请输入真实姓名').fill(REAL_NAME)
  await page.locator('.ant-modal .ant-radio-wrapper', { hasText: '女' }).first().click()
  await page.locator('.ant-modal').getByPlaceholder('岁').fill('68')
  await page.locator('.ant-modal').getByPlaceholder('cm').fill('158')
  await page.locator('.ant-modal').getByPlaceholder('选填，会记为今天的数据').fill('66')
  await page.locator('.ant-modal').getByPlaceholder('用于找回密码与医生联系').fill('13900001234')
  await page.locator('.ant-modal').getByRole('button', { name: '下一步' }).click()
  await sleep(700)

  // 第 2 步：紧急联系人
  await page.locator('.ant-modal').getByPlaceholder('如：张伟').fill('周小雨')
  await page.locator('.ant-modal .ant-select').first().click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: '女儿' }).first().click()
  await page.keyboard.press('Escape')
  await page.locator('.ant-modal').getByPlaceholder('用于紧急情况联系').fill('13900005678')
  await page.locator('.ant-modal').getByRole('button', { name: '下一步' }).click()
  await sleep(700)

  // 第 3 步：疾病与用药 —— ⚠️ 只勾「高血压」，否则第 3 步的血糖申请会被主诊断提前派生
  await page.locator('.ant-modal .ant-select').first().click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: /^高血压$/ }).first().click()
  await page.keyboard.press('Escape')
  await sleep(400)
  await shot('建档弹窗-疾病只勾高血压')
  await page.locator('.ant-modal').getByRole('button', { name: '下一步' }).click()
  await sleep(700)

  // 第 4 / 5 步：生活画像、控制目标（均为选填）
  await page.locator('.ant-modal').getByRole('button', { name: '下一步' }).click()
  await sleep(700)
  await shot('建档弹窗-控制目标')
  await page.locator('.ant-modal').getByRole('button', { name: '保存档案' }).click()
  await page.waitForSelector('.ant-modal', { state: 'hidden', timeout: 25000 })
  await sleep(900)
  return `已建档：${REAL_NAME} / 高血压`
})

await step('②-b 首页：今日任务 + 两个评分', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await guard('今日任务', null)
  await sleep(1200)
  await shot('首页-今日任务与评分', { full: true })
  const info = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ')
    return {
      tasks: (t.match(/今日任务/) || []).length,
      hasRule: t.includes('规则评分'),
      hasAi: t.includes('AI 辅助分'),
    }
  })
  if (!info.hasRule) throw new Error('首页未出现「规则评分」标签')
  return `规则评分=${info.hasRule} / AI 辅助分=${info.hasAi}`
})

await step('②-c 点今日任务 → 录入 → 评分变化', async () => {
  // 点「步数」任务卡（原地跳 /data-record?focus=steps 并聚焦）
  const card = page.locator('.ant-card').filter({ hasText: /步数/ }).first()
  await card.click()
  await page.waitForURL(/data-record/, { timeout: 15000 })
  await page.waitForSelector('#health-record-form', { timeout: 15000 })
  await sleep(900)
  await shot('数据记录-由今日任务跳入并聚焦')

  await page.getByPlaceholder('今日步数').fill('8000')
  await page.getByPlaceholder('运动时长').fill('35')
  await page.getByPlaceholder('收缩压').fill('158')
  await page.getByPlaceholder('舒张压').fill('92')
  await page.getByPlaceholder('心率').fill('78')
  await shot('数据记录-已填写')
  await page.getByRole('button', { name: '保存健康数据' }).click()
  await page.waitForSelector('.ant-message-success', { timeout: 20000 })
  await sleep(1000)

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await sleep(1500)
  await shot('首页-录入后评分与预警', { full: true })
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  return `含「规则评分」=${t.includes('规则评分')} 含预警=${/预警|关注/.test(t)}`
})

/* ═══ ③ 对话 → 提案 → 医生审结 → 今日任务出现 ═══ */
await step('③-a 与智能体对话，提出新增血糖监测', async () => {
  await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' })
  await page.locator('.ant-tabs-tab', { hasText: '智能体对话' }).click()
  await sleep(800)
  const box = page.locator('textarea').first()
  await box.click()
  await box.fill('我还想每天监测一下血糖，毕竟年纪老了')
  await shot('智能体对话-提问')
  await page.keyboard.press('Enter')
  await sleep(1000)
  await page.waitForSelector('text=/申请新增|已提交医生审核|待医生/', { timeout: 90000 })
  await sleep(1500)
  await shot('智能体对话-生成待审申请', { full: true })
  return '已生成「申请新增监测」提案'
})

await step('③-b 医生端待审列表', async () => {
  await page.goto(`${BASE}/doctor`, { waitUntil: 'networkidle' })
  await sleep(1500)
  await page.waitForSelector('text=/申请新增监测/', { timeout: 20000 })
  await shot('医生端-待审提案', { full: true })
  return '医生端可见该提案（含紫色「申请新增监测」标签）'
})

await step('③-c 医生点「同意」', async () => {
  await page.locator('button', { hasText: /^同意$/ }).first().click()
  await page.waitForSelector('.ant-message-success', { timeout: 25000 })
  await sleep(1200)
  await shot('医生端-审结完成', { full: true })
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  if (!txt.includes('已同意')) throw new Error('未出现「已同意」回执')
  return '医生同意 → 后端写 addedTasks 覆盖包'
})

await step('③-d 患者端今日任务出现血糖监测', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await sleep(1800)
  await shot('首页-审结后今日任务出现血糖监测', { full: true })
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  if (!t.includes('血糖')) throw new Error('今日任务未出现血糖监测')
  if (!t.includes('医生新增')) throw new Error('未出现「医生新增」标记')
  return '今日任务含「血糖监测」，并带「医生新增」标记'
})

/* ══════════════ ④ 六智能体协同 ══════════════ */
await step('④-a 启动协同 → 推理中', async () => {
  await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' })
  await sleep(1200)
  await shot('智能体中心-待命', { full: true })
  await page.locator('button', { hasText: /启动协同/ }).first().click({ timeout: 15000 })
  await sleep(1500)
  await shot('智能体中心-协同推理中')
  return '协同已启动'
})

await step('④-b 协同结果 + 事件流', async () => {
  for (let i = 0; i < 120; i += 1) {
    await sleep(1000)
    const done = await page.locator('text=协同结束').count()
    const btn = await page.locator('button:has-text("启动协同")').count()
    if (done > 0 || btn > 0) break
  }
  await sleep(1500)
  await shot('智能体中心-协同结果', { full: true })
  try {
    await page.locator('.ant-segmented-item:has-text("事件流")').click({ timeout: 6000 })
    await sleep(1200)
    await shot('智能体中心-事件流', { full: true })
  } catch {
    console.log('   ! 事件流视图切换失败（不影响主线）')
  }
  return '协同完成'
})

/* ══════════════ ⑤ 智能体对话（含问答） ══════════════ */
await step('⑤ 智能体对话（追问血压）', async () => {
  await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' })
  await page.locator('.ant-tabs-tab', { hasText: '智能体对话' }).click()
  await sleep(800)
  const box = page.locator('textarea').first()
  await box.click()
  await box.fill('我最近血压有点高，今天应该注意什么？')
  await page.keyboard.press('Enter')
  await sleep(12000)
  await shot('智能体对话-回答', { full: true })
  return '含 1 轮问答'
})

/* ══════════════ ⑥ 健康建议 ══════════════ */
await step('⑥ 健康建议页', async () => {
  await page.goto(`${BASE}/prescription`, { waitUntil: 'networkidle' })
  await sleep(1500)
  await shot('健康建议', { full: true })
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  if (!t.includes('建议')) throw new Error('健康建议页无内容')
  return '含医生建议与随访关注项'
})

/* ══════════════ ⑦ 收尾：其余可讲页面 ══════════════ */
await step('⑦ 补充页面（团队/勋章/我的）', async () => {
  await page.goto(`${BASE}/care-team`, { waitUntil: 'networkidle' })
  await sleep(1200)
  await shot('我的医疗团队', { full: true })
  await page.goto(`${BASE}/badges`, { waitUntil: 'networkidle' })
  await sleep(1000)
  await shot('健康勋章', { full: true })
  await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' })
  await sleep(1000)
  await shot('我的-健康档案', { full: true })
  return '3 张补充截图'
})

await ctx.close()
await browser.close()

/* ------------------------------ 汇总 ------------------------------ */
const okN = results.filter((r) => r.ok).length
console.log('\n' + '='.repeat(70))
console.log(`走查结果：${okN} / ${results.length} 步通过`)
console.log('='.repeat(70))
for (const r of results) {
  console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.label}${r.note ? `  — ${r.note}` : ''}`)
}
console.log(`\n截图 ${shots.length} 张 -> ${OUT}`)
if (RECORD) console.log(`录像 -> ${VIDEO_DIR}（webm，可用 ffmpeg 转 MP4）`)
console.log(`本脚本落在副本库实例 ${BASE}，真实库与演示库零改动。`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
