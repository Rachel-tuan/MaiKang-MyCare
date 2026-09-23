/**
 * 迈康 MyCare · 验收：「完善健康档案」弹窗的自动弹出行为
 * ===========================================================================
 * 被验收的行为：
 *   注册用户（档案不完整）进入首页时，必须**自动弹出**「完善健康档案」弹窗；
 *   档案完整的用户（示范病例 / 已建档账号）**不得**被弹窗打扰。
 *
 * 为什么必须单独验收它：
 *   该行为曾因 React 18 严格模式**双调用 effect** 而失效 ——
 *   「已提示过」的标记写在定时器之前，第一次挂载的定时器被清理、
 *   第二次挂载又因标记已存在而直接 return，于是**开发模式下弹窗永不出现**
 *   （生产构建正常，因此只在 `npm run dev` 上复现，极难发现）。
 *   本脚本在 **3000（开发）与 3001（生产构建）两个入口上都必须通过**。
 *
 * 做法（全程只读，不写任何库）：
 *   ① 先访问 /login 建立 origin（localStorage 按 origin 隔离，必须先访问过）；
 *   ② 从后端取该患者的**真实 profile 视图**，原样注入 localStorage.user
 *      （前端只认这个键，其结构就是 toUserProfileView 的返回）；
 *   ③ 导航到首页，等弹窗延迟（800ms）过后检查 DOM。
 *
 * 用法：
 *   node scripts/db/verify-profile-modal.mjs                     # 打 3000（开发）
 *   PROBE_WEB=http://127.0.0.1:3001 node scripts/db/verify-profile-modal.mjs   # 打 3001（生产）
 * ---------------------------------------------------------------------------
 * 前提：3000 / 3001 已在运行（本脚本不自起服务）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PORT = 9347
const WEB = process.env.PROBE_WEB || 'http://127.0.0.1:3000'
const API = 'http://127.0.0.1:3001'
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const exe = BROWSERS.find((p) => p && fs.existsSync(p))
if (!exe) {
  console.log('未找到本机 Edge/Chrome，跳过探针。')
  process.exit(0)
}

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-probe-'))
const child = spawn(
  exe,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${udd}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--no-proxy-server',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws
let seq = 0
const pending = new Map()
function send(method, params = {}, sessionId) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve) => pending.set(id, resolve))
}

let version = null
for (let i = 0; i < 60 && !version; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    if (r.ok) version = await r.json()
  } catch {
    /* retry */
  }
  if (!version) await sleep(250)
}
if (!version) throw new Error('CDP 未就绪')

ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')))
})
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
  }
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (r?.exceptionDetails) return `__ERR__ ${r.exceptionDetails.text}`
  return r?.result?.value
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.stale] 把紧急联系人与生活画像**抹掉**后再注入。
 *   这是为了复现真实缺陷场景：注册时写进 localStorage 的 `user` 是**登录快照**，
 *   用户之后在弹窗里补全了档案（后端已完整），但 localStorage 仍是旧的 ——
 *   若引导卡的判定只看 `user`，就会**明明填过还一直提示**。
 *   注入「旧快照 + 后端新档案」正是这一组合。
 */
async function probe(label, pid, expectModal, opts = {}) {
  const res = await fetch(`${API}/api/patients/${pid}/profile`)
  const data = await res.json()
  const view = data?.view
  if (!view) {
    console.log(`【${label}】${pid} 取不到档案视图（HTTP ${res.status}），跳过`)
    return
  }
  const injected = opts.stale
    ? { ...view, emergencyContact: null, emergency_contact: null, lifestyle: null }
    : view

  // ① 建立 origin
  await send('Page.navigate', { url: `${WEB}/login` }, sessionId)
  await sleep(1800)

  // ② 注入登录态
  await evalJs(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(injected))})`)

  // ③ 进首页，等弹窗延迟
  await send('Page.navigate', { url: `${WEB}/` }, sessionId)
  await sleep(6500)

  const raw = await evalJs(`JSON.stringify({
    path: location.pathname,
    isLoginPage: document.body.innerText.indexOf('一键进入示范病例') >= 0,
    hasModal: !!document.querySelector('.ant-modal'),
    modalTitle: (document.querySelector('.ant-modal-title') || {}).innerText || '',
    hasGuideCard: !!document.querySelector('[data-testid="profile-guide-card"]'),
    userInLs: (function(){ try { return (JSON.parse(localStorage.getItem('user')||'{}').user_id)||'' } catch(e){ return 'parse-err' } })(),
    text: document.body.innerText.replace(/\\s+/g,' ').slice(0, 200),
  })`)
  const info = raw && raw.startsWith('{') ? JSON.parse(raw) : {}

  const guardOK = info.path === '/' && info.isLoginPage === false
  check(`${pid} 页面守卫：确实落在首页（不是登录页）`, guardOK, `path=${info.path} 含登录页特征=${info.isLoginPage}`)
  check(
    `${label}（${pid}）：${expectModal ? '自动弹出建档弹窗' : '**不**弹建档弹窗'}`,
    info.hasModal === expectModal,
    `期望=${expectModal} 实际=${info.hasModal} 标题="${info.modalTitle}"`
  )
  // 引导卡与弹窗必须**同进同退**：档案完整 → 两个都不该出现
  check(
    `${label}（${pid}）：${expectModal ? '显示' : '**不**显示'}首页引导卡`,
    info.hasGuideCard === expectModal,
    `期望=${expectModal} 实际=${info.hasGuideCard}`
  )
}

await probe('未建档账号', 'patient_4', true)
await probe('已建档账号', 'patient_5', false)
/* ⚠️ 关键回归：登录快照是旧的（缺紧急联系人与生活画像），而后端档案已完整。
   旧实现只看快照 → 引导卡与弹窗会一直冒出来（用户实测反馈）。 */
await probe('已建档账号 · 登录快照过期', 'patient_5', false, { stale: true })
/* 反向对照：快照旧 **且** 后端档案确实不完整 → 必须照常提示，不能「修过头」 */
await probe('未建档账号 · 登录快照过期', 'patient_4', true, { stale: true })

try {
  child.kill()
} catch {
  /* ignore */
}
console.log('\n' + '='.repeat(64))
console.log(`通过 ${passed} / ${passed + failed}${failed === 0 ? '　全部通过 ✅' : ''}`)
console.log('='.repeat(64))
console.log('说明：本脚本只读，未写入任何数据；真实库与演示库均零改动。')
process.exit(failed === 0 ? 0 : 1)
