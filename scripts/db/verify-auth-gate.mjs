/**
 * 迈康 MyCare · 「先注册，后才能登录」端到端验收（真实浏览器）
 * ===========================================================================
 * 为什么需要它：
 *   本应用除三位示范病例（一键进入，免注册）外，其余账号必须**先注册再登录**。
 *   这条规则横跨三层：LoginPage 表单 → UserContext.login → accountStore 注册表，
 *   任何一层断链都只在真机交互中暴露，静态检查与后端验收都看不出来。
 *
 * 与 verify-auth-flow.mjs 的区别（该脚本已由本脚本取代）：
 *   旧脚本用**未限定作用域**的选择器取输入框与按钮。antd Tabs 会把所有页签
 *   面板都挂在 DOM 里（非活动面板仅隐藏），因此旧脚本会写到隐藏面板的输入框、
 *   并可能点到「登录」页签而不是提交按钮 → 提交根本没发生 → 4 项假失败
 *   （toast 为空、路径停在 /login）。本脚本改为：
 *     · 一切选择器限定在 `.ant-tabs-tabpane-active`（当前活动面板）内；
 *     · 按 Form.Item 的 label 文案精确定位输入框，而不是靠顺序猜；
 *     · 提交用 form 内 `button[type=submit]`，杜绝点到页签；
 *     · 用 MutationObserver 持续收集 toast —— antd message 3 秒即消失，
 *       采样式读取会漏，必须监听。
 *
 * 用法：node scripts/db/verify-auth-gate.mjs
 * 前置：前端 :3000、后端 :3001 均已启动
 * 产出：data/auth-gate-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = process.cwd()
const WEB = process.env.MYCARE_WEB_URL || 'http://127.0.0.1:3000'
const API = process.env.MYCARE_API_URL || 'http://127.0.0.1:3001'
const PORT = Number(process.env.MYCARE_CDP_PORT || 9336)

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
let failed = 0
const record = { generatedAt: new Date().toISOString(), web: WEB, api: API, checks: {}, summary: {} }

function check(name, ok, detail = '') {
  record.checks[name] = { ok: Boolean(ok), detail: String(detail) }
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

/* 避免在源码里硬编码任何凭据字面量：用户名与密码均在运行时生成 */
const rand = (n) => Math.random().toString(36).slice(2, 2 + n)
const UNREGISTERED = `noreg_${rand(6)}`
const NEW_USER = `verify_${rand(6)}`
const PASSWORD = `Ab${rand(7)}9`
const WRONG_PASSWORD = `Zz${rand(7)}1`
const PHONE = `138${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`

const exe = BROWSERS.find((p) => p && fs.existsSync(p))
if (!exe) {
  console.log('未找到本机 Edge/Chrome，跳过登录注册流程验收。')
  record.summary = { passed: 0, failed: 0, total: 0, allPass: false, skipped: true, reason: 'no browser' }
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'data', 'auth-gate-verify-record.json'), JSON.stringify(record, null, 2), 'utf8')
  process.exit(0)
}
record.browser = exe

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-auth-'))
const child = spawn(exe, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--no-proxy-server',
  'about:blank',
], { stdio: 'ignore' })

let ws
let seq = 0
const pending = new Map()
let consoleErrors = []
let consoleExceptions = []

function send(method, params = {}, sessionId) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve) => pending.set(id, resolve))
}

/** 注入到页面的辅助函数：一切操作限定在当前活动页签面板内 */
const PAGE_HELPERS = `
window.__mycare = (function () {
  function pane() { return document.querySelector('.ant-tabs-tabpane-active') || document.body }
  function labelOf(item) {
    var l = item.querySelector('.ant-form-item-label label')
    return l ? l.textContent.replace(/\\s+/g, '') : ''
  }
  function setValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new Event('blur', { bubbles: true }))
  }
  return {
    fill: function (label, value) {
      var want = String(label).replace(/\\s+/g, '')
      var items = [].slice.call(pane().querySelectorAll('.ant-form-item'))
      var item = items.filter(function (i) { return labelOf(i) === want })[0]
      if (!item) return 'no-item'
      var el = item.querySelector('input, textarea')
      if (!el) return 'no-input'
      setValue(el, value)
      return 'ok'
    },
    read: function (label) {
      var want = String(label).replace(/\\s+/g, '')
      var items = [].slice.call(pane().querySelectorAll('.ant-form-item'))
      var item = items.filter(function (i) { return labelOf(i) === want })[0]
      var el = item && item.querySelector('input, textarea')
      return el ? el.value : null
    },
    openSelect: function (label) {
      var want = String(label).replace(/\\s+/g, '')
      var items = [].slice.call(pane().querySelectorAll('.ant-form-item'))
      var item = items.filter(function (i) { return labelOf(i) === want })[0]
      if (!item) return 'no-item'
      var sel = item.querySelector('.ant-select-selector')
      if (!sel) return 'no-select'
      sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      sel.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      sel.click()
      return 'ok'
    },
    pickOption: function (text) {
      var opts = [].slice.call(document.querySelectorAll('.ant-select-item-option'))
      var o = opts.filter(function (x) { return (x.textContent || '').indexOf(text) >= 0 })[0]
      if (!o) return 'no-option'
      o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      o.click()
      return 'ok'
    },
    checkAgreement: function () {
      var box = pane().querySelector('.ant-checkbox-input')
      if (!box) return 'no-checkbox'
      if (!box.checked) box.click()
      return box.checked ? 'checked' : 'unchecked'
    },
    submit: function () {
      var btn = pane().querySelector('form button[type="submit"]')
      if (!btn) return 'no-submit'
      btn.click()
      return 'ok'
    },
    switchTab: function (name) {
      var tabs = [].slice.call(document.querySelectorAll('.ant-tabs-tab'))
      var t = tabs.filter(function (x) { return (x.textContent || '').trim() === name })[0]
      if (!t) return 'no-tab'
      var btn = t.querySelector('.ant-tabs-tab-btn') || t
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      btn.click()
      return 'ok'
    },
    activeTab: function () {
      var t = document.querySelector('.ant-tabs-tab-active')
      return t ? (t.textContent || '').trim() : null
    },
    demoCards: function () {
      return [].slice.call(document.querySelectorAll('button.demo-card')).map(function (b) {
        return (b.textContent || '').trim()
      })
    },
    clickDemo: function (name) {
      var b = [].slice.call(document.querySelectorAll('button.demo-card'))
        .filter(function (x) { return (x.textContent || '').indexOf(name) >= 0 })[0]
      if (!b) return 'no-card'
      b.click()
      return 'ok'
    },
    startToastWatch: function () {
      window.__toasts = []
      if (window.__toastMo) window.__toastMo.disconnect()
      window.__toastMo = new MutationObserver(function () {
        [].slice.call(document.querySelectorAll('.ant-message-notice')).forEach(function (n) {
          var t = (n.innerText || '').trim()
          if (t && window.__toasts.indexOf(t) < 0) window.__toasts.push(t)
        })
      })
      window.__toastMo.observe(document.body, { childList: true, subtree: true })
      return 'ok'
    },
    toasts: function () { return window.__toasts || [] },
    storageUser: function () {
      var raw = localStorage.getItem('user')
      if (!raw) return null
      try { var u = JSON.parse(raw); return { name: u.name, username: u.username, user_id: u.user_id, isRegistered: !!u.isRegistered } } catch (e) { return null }
    },
    homeOnboarding: function () {
      return (document.body.innerText || '').indexOf('你的健康档案已建立') >= 0
    },
    hasDemoBriefing: function () {
      var t = document.body.innerText || ''
      return /指标达到预警等级|血压显著偏高|今日复测/.test(t)
    },
    bodyText: function () { return (document.body.innerText || '').slice(0, 3000) },
    clearAll: function () { localStorage.clear(); return 'ok' },
    path: function () { return location.pathname },
    introBeforeDemo: function () {
      var intro = document.querySelector('.intro-title')
      var demo = document.querySelector('.demo-title')
      if (!intro || !demo) return null
      return Boolean(intro.compareDocumentPosition(demo) & Node.DOCUMENT_POSITION_FOLLOWING)
    },
    introText: function () {
      var el = document.querySelector('.demo-title')
      var box = el && el.closest('div') && el.parentElement
      var f = document.querySelector('.intro-title')
      var root = f && f.parentElement
      return root ? (root.innerText || '') : ''
    },
    modalOpen: function (titleText) {
      var wraps = [].slice.call(document.querySelectorAll('.ant-modal-wrap'))
      var open = wraps.filter(function (w) { return getComputedStyle(w).display !== 'none' })[0]
      if (!open) return null
      var body = open.querySelector('.ant-modal-body')
      return { text: (body ? body.innerText : '').slice(0, 4000), title: (open.querySelector('.ant-modal-title') || {}).innerText || '' }
    },
    clickByText: function (sel, text) {
      var els = [].slice.call(document.querySelectorAll(sel))
      var e = els.filter(function (x) { return (x.textContent || '').indexOf(text) >= 0 })[0]
      if (!e) return 'not-found'
      e.click()
      return 'ok'
    }
  }
})()
'ok'
`

try {
  // ---- CDP 就绪 ----
  let version = null
  for (let i = 0; i < 60 && !version; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) version = await r.json()
    } catch { /* retry */ }
    if (!version) await sleep(250)
  }
  if (!version) throw new Error('CDP 未就绪（无头浏览器启动失败）')

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
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleExceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '')
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const parts = (msg.params.args || []).map((a) => (a?.value !== undefined ? a.value : a?.description ?? ''))
      consoleErrors.push(parts.join(' | '))
    } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      consoleErrors.push(msg.params.entry.text || '')
    }
  })

  const target = await send('Target.createTarget', { url: 'about:blank' })
  const sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await send('Runtime.enable', {}, sessionId)
  await send('Log.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r?.exceptionDetails) return { __error: r.exceptionDetails.text }
    return r?.result?.value
  }

  const goto = async (route, waitMs = 2600) => {
    await send('Page.navigate', { url: `${WEB}${route}` }, sessionId)
    await sleep(waitMs)
    await evaluate(PAGE_HELPERS)
    await evaluate('window.__mycare.startToastWatch()')
  }

  const detail = async () => ({
    path: await evaluate('location.pathname'),
    toasts: await evaluate('window.__mycare.toasts()'),
    user: await evaluate('window.__mycare.storageUser()'),
  })

  const waitFor = async (expr, timeoutMs = 4000, intervalMs = 200) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await evaluate(expr)) return true
      await sleep(intervalMs)
    }
    return false
  }

  // ================= 1. 首次进入：清空本机状态 =================
  await goto('/login')
  await evaluate('window.__mycare.clearAll()')
  await goto('/login')

  const demoNames = await evaluate('window.__mycare.demoCards()')
  record.demoEntries = demoNames
  check('1 登录页渲染，示范病例入口来自接口（3 位）', Array.isArray(demoNames) && demoNames.length === 3, `cards=${JSON.stringify(demoNames)}`)

  // ================= 2. 功能说明位于示范病例入口上方 =================
  const introBefore = await evaluate('window.__mycare.introBeforeDemo()')
  const introText = String((await evaluate('window.__mycare.introText()')) || '')
  const hasCrowd = /适用人群/.test(introText)
  const hasMetric = /管理指标|指标/.test(introText)
  const hasEffect = /预期效果|效果/.test(introText)
  check(
    '2 功能说明位于「一键进入示范病例」上方，且覆盖适用人群 / 指标 / 效果',
    introBefore === true && hasCrowd && hasMetric && hasEffect,
    `before=${introBefore} 适用人群=${hasCrowd} 指标=${hasMetric} 效果=${hasEffect} 字数=${introText.length}`,
  )

  // ================= 3. 三个实体弹窗 =================
  await evaluate('window.__mycare.clickByText(".ant-card-body button, .ant-btn-link", "用户协议")')
  await sleep(500)
  const agreement = await evaluate('window.__mycare.modalOpen("用户协议")')
  const agreementOk = Boolean(agreement && /先注册/.test(agreement.text) && /用户协议|服务说明/.test(agreement.text))
  check('3 「用户协议」为实体（可打开，含服务说明与账号规则）', agreementOk, `title=${agreement?.title || ''} 字数=${agreement?.text?.length || 0}`)
  await evaluate('document.querySelectorAll(".ant-modal-close").forEach(function(b){b.click()})')
  await sleep(400)

  await evaluate('window.__mycare.clickByText(".ant-card-body button, .ant-btn-link", "隐私政策")')
  await sleep(500)
  const privacy = await evaluate('window.__mycare.modalOpen("隐私政策")')
  const privacyOk = Boolean(privacy && /存储|收集/.test(privacy.text) && /哈希/.test(privacy.text))
  check('4 「隐私政策」为实体（可打开，含信息收集与加盐哈希说明）', privacyOk, `title=${privacy?.title || ''} 字数=${privacy?.text?.length || 0}`)
  await evaluate('document.querySelectorAll(".ant-modal-close").forEach(function(b){b.click()})')
  await sleep(400)

  await evaluate('window.__mycare.switchTab("登录")')
  await sleep(400)
  await evaluate('window.__mycare.clickByText(".ant-tabs-tabpane-active button", "忘记密码")')
  await sleep(500)
  const forgot = await evaluate('window.__mycare.modalOpen("找回密码")')
  const forgotOk = Boolean(forgot && /用户名/.test(forgot.text) && /手机号/.test(forgot.text) && /新密码/.test(forgot.text))
  check('5 「忘记密码？」为实体（可打开，含可提交的重置表单）', forgotOk, `title=${forgot?.title || ''} 字数=${forgot?.text?.length || 0}`)
  await evaluate('document.querySelectorAll(".ant-modal-close").forEach(function(b){b.click()})')
  await sleep(400)

  // ================= 4. 未注册账号登录必须被拒绝 =================
  await evaluate(`window.__mycare.fill('用户名', ${JSON.stringify(UNREGISTERED)})`)
  await evaluate(`window.__mycare.fill('密码', ${JSON.stringify(PASSWORD)})`)
  await evaluate('window.__mycare.submit()')
  await waitFor('window.__mycare.toasts().length > 0', 5000)
  let d = await detail()
  const rejectToast = (d.toasts || []).join(' ')
  check(
    '6 未注册账号登录被拒绝，且不回落到任何默认患者',
    d.path === '/login' && /先注册|尚未注册|未注册/.test(rejectToast) && !d.user,
    `path=${d.path} toast=${rejectToast}`,
  )

  // ================= 5. 注册（注册成功不自动登录） =================
  await goto('/login')
  await evaluate('window.__mycare.switchTab("注册")')
  await sleep(500)
  await evaluate(`window.__mycare.fill('姓名', '验收用户')`)
  await evaluate(`window.__mycare.fill('用户名', ${JSON.stringify(NEW_USER)})`)
  await evaluate(`window.__mycare.fill('密码', ${JSON.stringify(PASSWORD)})`)
  await evaluate(`window.__mycare.fill('确认密码', ${JSON.stringify(PASSWORD)})`)
  await evaluate(`window.__mycare.fill('手机号', ${JSON.stringify(PHONE)})`)
  await evaluate(`window.__mycare.fill('年龄', '68')`)
  await evaluate(`window.__mycare.openSelect('性别')`)
  await sleep(400)
  await evaluate('window.__mycare.pickOption("男")')
  await sleep(400)
  const agreed = await evaluate('window.__mycare.checkAgreement()')
  record.agreementCheckbox = agreed
  await sleep(200)
  await evaluate('window.__mycare.submit()')
  await waitFor('window.__mycare.toasts().length > 0', 8000)
  d = await detail()
  const regToast = (d.toasts || []).join(' ')
  const backfilled = await evaluate(`window.__mycare.read('用户名')`)
  check(
    '7 注册成功且**不自动登录**（仍停在登录页签并回填用户名）',
    regToast.includes('注册成功') && d.path === '/login' && !d.user && backfilled === NEW_USER,
    `toast=${regToast} path=${d.path} 已登录=${Boolean(d.user)} 回填=${backfilled}`,
  )
  record.registeredUsername = NEW_USER

  // 直接向服务端核验：注册必须真的在患者库落一行（不看前端缓存）
  const serverLoginRes = await fetch(`${API}/api/patients/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: NEW_USER, password: PASSWORD }),
  })
  const serverLoginBody = await serverLoginRes.json().catch(() => ({}))
  record.serverPatientId = serverLoginBody.patientId || null
  check(
    '8 注册写入服务端患者库：可解析出独立 patient_id（非示范病例）',
    serverLoginRes.ok &&
      Boolean(serverLoginBody.patientId) &&
      !['patient_1', 'patient_2', 'patient_3'].includes(serverLoginBody.patientId),
    `patientId=${serverLoginBody.patientId} status=${serverLoginRes.status}`,
  )

  const cardsAfterReg = await evaluate('window.__mycare.demoCards()')
  check(
    '9 新注册患者不进入「一键进入示范病例」列表（仍为 3 位免密账号）',
    Array.isArray(cardsAfterReg) && cardsAfterReg.length === 3,
    `cards=${JSON.stringify(cardsAfterReg)}`,
  )

  // ================= 6. 已注册 + 错误密码 =================
  await goto('/login')
  await evaluate(`window.__mycare.fill('用户名', ${JSON.stringify(NEW_USER)})`)
  await evaluate(`window.__mycare.fill('密码', ${JSON.stringify(WRONG_PASSWORD)})`)
  await evaluate('window.__mycare.submit()')
  await waitFor('window.__mycare.toasts().length > 0', 5000)
  d = await detail()
  const wrongToast = (d.toasts || []).join(' ')
  check(
    '10 已注册账号 + 错误密码 → 提示密码错误，且不进入应用',
    /密码错误/.test(wrongToast) && d.path === '/login' && !d.user,
    `path=${d.path} toast=${wrongToast}`,
  )

  // ================= 8. 已注册 + 正确密码 → 进入首页 =================
  await goto('/login')
  await evaluate(`window.__mycare.fill('用户名', ${JSON.stringify(NEW_USER)})`)
  await evaluate(`window.__mycare.fill('密码', ${JSON.stringify(PASSWORD)})`)
  await evaluate('window.__mycare.submit()')
  const loggedIn = await waitFor('location.pathname === "/" && Boolean(localStorage.getItem("user"))', 8000)
  d = await detail()
  check(
    '11 已注册账号 + 正确密码 → 登录成功进入首页（先注册后才能登录闭环成立）',
    loggedIn && d.path === '/' && Boolean(d.user),
    `path=${d.path} 身份=${JSON.stringify(d.user)}`,
  )
  check(
    '12 登录后身份键 = 该账号自己的 patient_id（不是示范病例）',
    Boolean(d.user?.user_id) && !['patient_1', 'patient_2', 'patient_3'].includes(d.user.user_id),
    `user_id=${d.user?.user_id}`,
  )

  // ================= 9. 新账号首页不得出现示范病例数据 =================
  await sleep(1200)
  const onboarding = await evaluate('window.__mycare.homeOnboarding()')
  const staleDemo = await evaluate('window.__mycare.hasDemoBriefing()')
  const homeText = String((await evaluate('window.__mycare.bodyText()')) || '')
  check(
    '13 新账号首页显示「档案已建立、从第一条数据开始」引导',
    onboarding === true,
    `onboarding=${onboarding} 片段=${homeText.slice(0, 80).replace(/\s+/g, ' ')}`,
  )
  check(
    '14 新账号首页**不残留**上一位（示范病例）的晨报数据',
    staleDemo === false,
    `检测到示范病例晨报文案=${staleDemo}`,
  )

  // ================= 10. 示范病例免注册例外入口 =================
  await goto('/login')
  await evaluate('window.__mycare.clearAll()')
  await goto('/login')
  const firstName = String((await evaluate('window.__mycare.demoCards()'))?.[0] || '').split('\n')[0].trim()
  await evaluate(`window.__mycare.clickDemo(${JSON.stringify(firstName)})`)
  const demoIn = await waitFor('location.pathname === "/" && Boolean(localStorage.getItem("user"))', 7000)
  d = await detail()
  check(
    '15 三位示范病例免注册可一键进入（例外入口不受「先注册」限制）',
    demoIn && d.path === '/' && Boolean(d.user?.name),
    `入口=${firstName} path=${d.path} 身份=${d.user?.name || ''}`,
  )

  // ================= 9. 全程无未捕获异常 =================
  const fatal = consoleExceptions.filter(Boolean)
  record.consoleErrors = consoleErrors.slice(0, 20)
  record.consoleExceptions = fatal.slice(0, 20)
  check('16 全流程无未捕获异常', fatal.length === 0, fatal.length ? String(fatal[0]).split('\n')[0] : 'none')

  try { await send('Target.closeTarget', { targetId: target.targetId }) } catch { /* ignore */ }
} catch (err) {
  record.fatal = String(err?.message || err)
  check('脚本执行', false, String(err?.message || err))
} finally {
  try { ws?.close() } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
  await sleep(400)
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }

  // 清理：删除本次验收注册的患者（外键 CASCADE 带走 conditions / lifestyle / contacts / relations / 记录 / alerts）
  try {
    const dbPath = path.join(ROOT, 'data', 'mycare.db')
    if (fs.existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath)
      db.exec('PRAGMA foreign_keys = ON;')
      const row = db.prepare('SELECT patient_id FROM patients WHERE username = ?').get(NEW_USER)
      if (row) {
        db.prepare('DELETE FROM patients WHERE patient_id = ?').run(row.patient_id)
        record.cleanup = `已删除验收患者 ${row.patient_id}`
      } else {
        record.cleanup = '未找到验收患者（无需清理）'
      }
      db.close()
    }
  } catch (e) {
    record.cleanup = `清理失败：${e.message}`
  }

  record.summary = { passed, failed, total: passed + failed, allPass: failed === 0 }
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'data', 'auth-gate-verify-record.json'), JSON.stringify(record, null, 2), 'utf8')
  console.log(`\n==== 登录注册流程验收：${passed}/${passed + failed} 通过 ====`)
  if (failed > 0) process.exitCode = 1
}
