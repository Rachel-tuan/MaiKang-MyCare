/**
 * 迈康 MyCare · 前端页面可达性冒烟验收（真实浏览器）
 * ===========================================================================
 * 为什么需要它：
 *   Step 6 的后端验收 45/45 全过，但前端 `LoginPage` 因漏导入 useEffect
 *   在渲染期直接抛错 → #root 为空 → 整个应用白屏、登录页都进不去。
 *   纯后端验收无法发现这类问题，因此补一个「真实浏览器逐路由渲染」检查。
 *
 * 做法：
 *   · 用本机 Edge/Chrome 无头模式 + CDP（无需下载 Chromium）
 *   · 先访问 /login，确认登录页渲染且示范病例入口来自 API
 *   · 再通过 /api/patients/login 取患者视图写入 localStorage（模拟已登录）
 *   · 逐个路由「整页重载」，捕获未捕获异常 / 运行时错误 / #root 是否为空
 *
 * 用法：node scripts/db/verify-ui-routes.mjs
 * 产出：data/ui-routes-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const WEB = process.env.MYCARE_WEB_URL || 'http://127.0.0.1:3000'
const API = process.env.MYCARE_API_URL || 'http://127.0.0.1:3001'
const PORT = Number(process.env.MYCARE_CDP_PORT || 9334)
const PATIENT_ID = process.env.MYCARE_UI_PATIENT || 'patient_1'

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

/** 允许出现的控制台信息（非缺陷）：React 警告、antd 兼容性提示、React Router 未来标志 */
const BENIGN = [/^Warning: /, /React Router Future Flag/, /autocomplete attributes/]

/**
 * 已知缺陷类告警：虽被 BENIGN 放行（不影响渲染），但属于应收敛的噪声。
 * 这里显式断言「全站 0 命中」，避免清理后退化。
 */
const KNOWN_DEPRECATION = [
  /non-boolean attribute/i,
  /Tabs\.TabPane/,
  /bodyStyle/,
]
const deprecationHits = []

const ROUTES = [
  { path: '/login', label: '登录 / 注册', needAuth: false, expectText: /迈康 MyCare/ },
  { path: '/', label: '首页', needAuth: true, expectText: /./ },
  { path: '/agents', label: '智能体中心', needAuth: true, expectText: /./ },
  { path: '/prescription', label: '健康建议', needAuth: true, expectText: /./ },
  { path: '/data-record', label: '数据记录', needAuth: true, expectText: /./ },
  { path: '/badges', label: '勋章', needAuth: true, expectText: /./ },
  { path: '/doctor', label: '医生端', needAuth: true, expectText: /./ },
  { path: '/profile', label: '我的', needAuth: true, expectText: /./ },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const record = { generatedAt: new Date().toISOString(), web: WEB, api: API, routes: {}, checks: {}, summary: {} }
let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  record.checks[name] = { ok: Boolean(ok), detail }
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const exe = BROWSERS.find((p) => p && fs.existsSync(p))
if (!exe) {
  console.log('未找到本机 Edge/Chrome，跳过前端页面冒烟验收。')
  record.summary = { passed: 0, failed: 0, skipped: true, reason: 'no browser' }
  fs.writeFileSync(path.join(ROOT, 'data', 'ui-routes-verify-record.json'), JSON.stringify(record, null, 2))
  process.exit(0)
}
record.browser = exe

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-ui-'))
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
let bucket = null // 当前路由的收集桶

function send(method, params = {}, sessionId) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve) => pending.set(id, resolve))
}

try {
  // ---- 等待 CDP 就绪 ----
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

  /** 还原 console 参数：把 %s 等占位符按后续参数替换，避免记录里只剩格式串而丢失关键信息 */
  const FORMAT_RE = /%[sdifoOc]/g
  const renderConsoleArgs = (args = []) => {
    const parts = args.map((a) =>
      a?.value !== undefined ? a.value : a?.description !== undefined ? a.description : a?.type ?? '',
    )
    if (typeof parts[0] !== 'string') {
      return parts.filter((x) => x !== undefined && x !== null).join(' | ')
    }
    let i = 1
    const text = parts[0].replace(FORMAT_RE, () => (i < parts.length ? String(parts[i++]) : '%s'))
    const rest = parts.slice(i).filter((x) => x !== undefined && x !== null && x !== '')
    return rest.length ? `${text} | ${rest.join(' ')}` : text
  }

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result)
      pending.delete(msg.id)
      return
    }
    if (!bucket) return
    if (msg.method === 'Runtime.exceptionThrown') {
      bucket.exceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '')
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      bucket.consoleErrors.push(renderConsoleArgs(msg.params.args))
    } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      bucket.consoleErrors.push(msg.params.entry.text || '')
    }
  })

  const target = await send('Target.createTarget', { url: 'about:blank' })
  const sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await send('Runtime.enable', {}, sessionId)
  await send('Log.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    return r?.result?.value
  }

  /** 整页导航到某路由并收集渲染结果 */
  const visit = async (url, waitMs = 3000) => {
    bucket = { exceptions: [], consoleErrors: [] }
    await send('Page.navigate', { url }, sessionId)
    await sleep(waitMs)
    const rootLen = Number(await evaluate('(document.getElementById("root")||{innerHTML:""}).innerHTML.length')) || 0
    const text = String((await evaluate('document.body ? document.body.innerText : ""')) || '')
    const fatal = bucket.exceptions.concat(
      bucket.consoleErrors.filter((t) => !BENIGN.some((re) => re.test(t))),
    )
    // 收集「已知缺陷类告警」（non-boolean attribute / TabPane / bodyStyle），用于单独断言
    for (const entry of [...bucket.exceptions, ...bucket.consoleErrors]) {
      const hit = KNOWN_DEPRECATION.find((re) => re.test(String(entry)))
      if (hit) deprecationHits.push({ url, text: String(entry).split('\n')[0].slice(0, 200) })
    }
    return { rootLen, text, exceptions: bucket.exceptions, consoleErrors: bucket.consoleErrors, fatal }
  }

  // ---- 1. 后端可达 ----
  const loginRes = await fetch(`${API}/api/patients/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: PATIENT_ID }),
  })
  const loginJson = await loginRes.json().catch(() => null)
  check('0 后端登录接口可用（用于写入登录态）', loginRes.ok && Boolean(loginJson?.view?.name), `status=${loginRes.status} name=${loginJson?.view?.name}`)

  // ---- 2. 登录页 ----
  const loginRoute = ROUTES[0]
  const r0 = await visit(`${WEB}${loginRoute.path}`)
  record.routes[loginRoute.path] = { label: loginRoute.label, rootLen: r0.rootLen, fatal: r0.fatal, textHead: r0.text.slice(0, 300) }
  check('1 登录页渲染（#root 非空 + 无未捕获异常）', r0.rootLen > 0 && r0.exceptions.length === 0, `rootLen=${r0.rootLen} exceptions=${r0.exceptions.length}`)
  check('2 登录页文案正确', loginRoute.expectText.test(r0.text), `textHead=${r0.text.slice(0, 40).replace(/\n/g, ' ')}`)
  check('3 登录页示范病例入口来自 API（3 位患者）', /张建国/.test(r0.text) && /李秀英/.test(r0.text) && /王建军/.test(r0.text), `含三位示范患者=${/张建国/.test(r0.text) && /李秀英/.test(r0.text) && /王建军/.test(r0.text)}`)

  // ---- 3. 写入登录态（仅身份，不含健康数据） ----
  const view = loginJson?.view || null
  if (view) {
    await evaluate(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(view))})`)
    await evaluate(`localStorage.setItem('userSettings', JSON.stringify({elderlyMode:true, voiceEnabled:false}))`)
    const stored = await evaluate(`(localStorage.getItem('user')||'').length`)
    check('4 登录态写入 localStorage（仅身份）', Number(stored) > 0, `user 长度=${stored}`)
  } else {
    check('4 登录态写入 localStorage（仅身份）', false, '未取到患者视图')
  }

  // ---- 4. 逐路由整页重载 ----
  for (const route of ROUTES.slice(1)) {
    const r = await visit(`${WEB}${route.path}`, 3500)
    const landedOnLogin = /迈康 MyCare/.test(r.text) && /一键进入示范病例/.test(r.text)
    const warnings = r.consoleErrors
      .filter((t) => BENIGN.some((re) => re.test(t)))
      .map((t) => String(t).split('\n')[0].slice(0, 220))
    record.routes[route.path] = {
      label: route.label,
      rootLen: r.rootLen,
      landedOnLogin,
      exceptions: r.exceptions.map((t) => String(t).split('\n')[0]),
      fatalCount: r.fatal.length,
      warnings,
      textHead: r.text.slice(0, 200),
    }
    check(
      `${route.path} ${route.label} 渲染正常`,
      r.rootLen > 0 && r.fatal.length === 0 && !landedOnLogin,
      `rootLen=${r.rootLen} fatal=${r.fatal.length}${landedOnLogin ? ' 被重定向回登录页' : ''}${r.fatal.length ? ' :: ' + String(r.fatal[0]).split('\n')[0] : ''}`,
    )
  }

  // ---- 4b 首页模块顺序：今日任务 必须排在 智能体晨报 之前（产品约定的信息层级） ----
  const homeOrder = await visit(`${WEB}/`, 3500)
  const iTask = homeOrder.text.indexOf('今日任务')
  const iBrief = homeOrder.text.indexOf('迈康智能体晨报')
  check(
    '4b 首页模块顺序：今日任务 位于 迈康智能体晨报 之前',
    iTask >= 0 && iBrief >= 0 && iTask < iBrief,
    `今日任务@${iTask} 晨报@${iBrief}`,
  )

  // ---- 5. 前端源码健康度：React API 必须已导入 ----
  const HOOKS = ['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext', 'useReducer', 'useLayoutEffect']
  const missingImports = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|jsx)$/.test(e.name)) {
        const t = fs.readFileSync(p, 'utf8')
        const imp = (t.match(/import\s+([^;]*?)\s+from\s+['"]react['"]/) || [])[1]
        if (!imp) continue
        const brace = /\{([^}]*)\}/.exec(imp)
        const named = brace ? brace[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()) : []
        for (const h of HOOKS) {
          const used = new RegExp(`(^|[^\\w.])${h}\\s*\\(`).test(t)
          if (used && !named.includes(h)) missingImports.push(`${path.relative(ROOT, p)}:${h}`)
        }
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  record.missingReactImports = missingImports
  check('5 全部 src 文件使用的 React API 均已导入', missingImports.length === 0, missingImports.join(',') || 'none')

  // ---- 6. 已知缺陷类控制台告警必须为 0 ----
  record.deprecationHits = deprecationHits
  check(
    '6 全站无已知缺陷类告警（non-boolean attribute / Tabs.TabPane / Card bodyStyle）',
    deprecationHits.length === 0,
    deprecationHits.length
      ? deprecationHits.slice(0, 4).map((h) => `${h.url.replace(WEB, '')} :: ${h.text}`).join(' ;; ')
      : 'none',
  )

  try { await send('Target.closeTarget', { targetId: target.targetId }) } catch { /* ignore */ }
} catch (err) {
  record.fatal = String(err?.message || err)
  check('脚本执行', false, String(err?.message || err))
} finally {
  try { ws?.close() } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
  await sleep(400)
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }

  record.summary = { passed, failed, total: passed + failed, allPass: failed === 0 }
  fs.writeFileSync(path.join(ROOT, 'data', 'ui-routes-verify-record.json'), JSON.stringify(record, null, 2), 'utf8')
  console.log(`\n==== 前端页面冒烟验收：${passed}/${passed + failed} 通过 ====`)
  if (failed > 0) process.exitCode = 1
}
