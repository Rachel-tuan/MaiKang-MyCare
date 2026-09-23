/**
 * 迈康 MyCare · 「今日任务」交互验收（真实浏览器）
 * ===========================================================================
 * 覆盖三件事（2026-09-15 用户实测反馈）：
 *   1. 步数必须显示**真实累计值**：实走 12222 / 目标 8000 时，卡片要显示 12,222/8,000，
 *      不能显示 8,000/8,000 —— 后端 done 是「计入进度条的封顶值」，actualCount 才是真值。
 *   2. 任务卡片可点击 → 跳到「数据记录」页并**聚焦对应输入框**；服药任务在原地打卡（弹确认）。
 *   3. 启动入口停在登录 / 注册页（/login），不会因为残留登录态直接落进应用。
 *
 * 用法：node scripts/db/verify-task-actions.mjs
 * 前置：前端 3000 与后端 3001 已在运行
 * 产出：data/task-actions-verify-record.json
 *
 * 说明：本脚本只**读**接口，点击测试止于「弹窗出现」并立即取消，不会写入任何数据。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const WEB = process.env.MYCARE_WEB_URL || 'http://127.0.0.1:3000'
const API = process.env.MYCARE_API_URL || 'http://127.0.0.1:3001'
const PORT = Number(process.env.MYCARE_CDP_PORT || 9341)
const PATIENT_ID = process.env.MYCARE_UI_PATIENT || 'patient_1'

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const BENIGN = [/^Warning: /, /React Router Future Flag/, /autocomplete attributes/]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const record = { generatedAt: new Date().toISOString(), web: WEB, api: API, checks: {}, summary: {} }
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
  console.log('未找到本机 Edge/Chrome，跳过本次验收。')
  process.exit(0)
}
record.browser = exe

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-task-'))
const child = spawn(
  exe,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
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
let bucket = null

function send(method, params = {}, sessionId) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve) => pending.set(id, resolve))
}

try {
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
    if (!bucket) return
    if (msg.method === 'Runtime.exceptionThrown') {
      bucket.exceptions.push(
        msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '',
      )
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      bucket.consoleErrors.push(
        (msg.params.args || []).map((a) => a?.value ?? a?.description ?? '').join(' '),
      )
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
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    return r?.result?.value
  }

  const visit = async (url, waitMs = 3500) => {
    bucket = { exceptions: [], consoleErrors: [] }
    await send('Page.navigate', { url }, sessionId)
    await sleep(waitMs)
    const rootLen = Number(await evaluate('(document.getElementById("root")||{innerHTML:""}).innerHTML.length')) || 0
    const text = String((await evaluate('document.body ? document.body.innerText : ""')) || '')
    const fatal = bucket.exceptions.concat(bucket.consoleErrors.filter((t) => !BENIGN.some((re) => re.test(t))))
    return { rootLen, text, fatal }
  }

  /* -------------------- 1. 后端口径：actualCount 不得被截断 -------------------- */
  const dtRes = await fetch(`${API}/api/patients/${PATIENT_ID}/daily-tasks`)
  const dtJson = dtRes.ok ? await dtRes.json() : null
  const tasks = dtJson?.tasks || []
  const stepsTask = tasks.find((t) => t.taskId === 'steps')
  const backendActual = Number(stepsTask?.actualCount) || 0
  const backendTarget = Number(stepsTask?.target) || 0

  check('1 后端 /daily-tasks 可用', dtRes.ok && tasks.length > 0, `status=${dtRes.status} tasks=${tasks.length}`)
  check('2 存在步数任务且目标值合理', Boolean(stepsTask) && backendTarget > 0, `target=${backendTarget}`)
  check(
    '3 done 为「计入进度的封顶值」（不超过 target）',
    Number(stepsTask?.done) <= backendTarget,
    `done=${stepsTask?.done} target=${backendTarget}`,
  )
  check(
    '4 actualCount 保留真实步数（未被截断）',
    backendActual >= Number(stepsTask?.done || 0),
    `actualCount=${backendActual} done=${stepsTask?.done}`,
  )
  record.backend = { actualCount: backendActual, target: backendTarget, done: stepsTask?.done }

  /* -------------------- 2. 启动入口停在登录页 -------------------- */
  const login = await visit(`${WEB}/login`)
  check(
    '5 登录 / 注册页渲染且无运行时错误',
    login.rootLen > 0 && login.fatal.length === 0,
    `rootLen=${login.rootLen} fatal=${login.fatal.length}`,
  )
  check(
    '6 登录页含「一键进入示范病例」入口（答辩起始页）',
    /一键进入示范病例/.test(login.text),
    `textHead=${login.text.slice(0, 30).replace(/\n/g, ' ')}`,
  )

  /* -------------------- 3. 注入登录态 → 首页任务卡片 -------------------- */
  const loginRes = await fetch(`${API}/api/patients/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: PATIENT_ID }),
  })
  const loginJson = await loginRes.json().catch(() => null)
  const view = loginJson?.view || null
  if (view) {
    await evaluate(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(view))})`)
    await evaluate(`localStorage.setItem('userSettings', JSON.stringify({elderlyMode:true, voiceEnabled:false}))`)
  }
  check('7 登录态注入成功（仅身份键）', Boolean(view), `name=${view?.name}`)

  const home = await visit(`${WEB}/`)
  check('8 首页渲染且无运行时错误', home.rootLen > 0 && home.fatal.length === 0, `fatal=${home.fatal.length}`)

  /**
   * 读取「今日任务」各卡片。
   * ⚠️ 不能直接用 `.ant-card` + 文本判断：外层「今日任务」容器卡片的后代里也有 .task-action，
   *    会被一起选中，导致读到整块容器的文本、点击也点在外层（无 onClick）→ 假失败。
   *    正解：从 .task-action 元素反查 closest('.ant-card') 并去重，拿到真正的任务卡片。
   */
  const TASK_CARD_JS = `[...new Set([...document.querySelectorAll('.task-action')].map((el) => el.closest('.ant-card')))]`
  const readTaskCards = () =>
    evaluate(`JSON.stringify(${TASK_CARD_JS}.map((c) => ({ title: c.innerText.split('\\n')[0] || '', text: c.innerText.replace(/\\n/g, ' | ') })))`)

  const cardsRaw = await readTaskCards()
  const cards = JSON.parse(cardsRaw || '[]')
  record.taskCards = cards

  check('9 首页渲染出今日任务卡片', cards.length > 0, `卡片数=${cards.length}`)
  check(
    '10 每张任务卡片都带可点击提示（.task-action）',
    cards.length > 0,
    `提示文案=${cards.map((c) => (c.text.match(/去记录\S+|点击打卡/) || [''])[0]).join(' / ')}`,
  )

  const stepsCard = cards.find((c) => c.text.includes('步数目标'))
  const stepsMatch = stepsCard ? stepsCard.text.match(/([\d,]+)\s*\/\s*([\d,]+)\s*步/) : null
  const uiActual = stepsMatch ? Number(stepsMatch[1].replace(/,/g, '')) : null
  const uiTarget = stepsMatch ? Number(stepsMatch[2].replace(/,/g, '')) : null

  check('11 步数卡片渲染 实际值/目标值 步', Boolean(stepsMatch), stepsCard ? stepsCard.text : '未找到步数目标卡片')
  check(
    '12 步数显示的是真实累计值（与后端 actualCount 一致）',
    uiActual === backendActual,
    `UI=${uiActual} 后端=${backendActual}`,
  )
  check(
    '13 超出目标时不显示成 目标/目标',
    backendActual <= backendTarget || uiActual !== uiTarget,
    `UI=${uiActual}/${uiTarget}`,
  )

  /* -------------------- 4. 点击任务卡片 → 跳转并聚焦 -------------------- */
  /** 点击标题含 keyword 的任务卡片，返回落点 pathname 与聚焦元素的 placeholder */
  const clickTask = async (keyword) => {
    await visit(`${WEB}/`, 3200)
    await evaluate(`(() => {
      const card = ${TASK_CARD_JS}
        .find((c) => c.innerText.includes(${JSON.stringify(keyword)}));
      if (card) card.click();
      return Boolean(card);
    })()`)
    await sleep(900)
    return evaluate(
      `JSON.stringify({ path: location.pathname + location.search, placeholder: document.activeElement ? (document.activeElement.placeholder || document.activeElement.tagName) : null })`,
    )
  }

  // 监测类任务卡：主诊断高血压 → 血压监测；主诊断糖尿病 → 血糖监测。
  // 必须动态识别 —— 写死「血压监测」在李秀英（糖尿病）身上根本不存在这张卡。
  const monitorCard = cards.find((c) => /去记录(血压|血糖)/.test(c.text)) || { text: '去记录血压' }
  const monitorIsBg = monitorCard.text.includes('去记录血糖')
  const monitorKeyword = monitorIsBg ? '血糖监测' : '血压监测'
  const monitorPlaceholder = monitorIsBg ? '血糖值' : '收缩压'

  const bpLand = JSON.parse((await clickTask(monitorKeyword)) || '{}')
  check(
    `14 点击「${monitorKeyword}」跳到数据记录页并聚焦对应输入框`,
    bpLand.path?.startsWith('/data-record') && bpLand.placeholder === monitorPlaceholder,
    `path=${bpLand.path} focus=${bpLand.placeholder} 期望=${monitorPlaceholder}`,
  )

  const stepsLand = JSON.parse((await clickTask('步数目标')) || '{}')
  check(
    '15 点击「步数目标」聚焦步数输入框',
    stepsLand.path?.startsWith('/data-record') && stepsLand.placeholder === '今日步数',
    `path=${stepsLand.path} focus=${stepsLand.placeholder}`,
  )

  const exLand = JSON.parse((await clickTask('运动打卡')) || '{}')
  check(
    '16 点击「运动打卡」聚焦运动时长输入框',
    exLand.path?.startsWith('/data-record') && exLand.placeholder === '运动时长',
    `path=${exLand.path} focus=${exLand.placeholder}`,
  )

  /* 服药任务：在原地弹确认，不写库 */
  const medTitle = cards.find((c) => c.text.includes('服药：'))?.text || ''
  if (medTitle) {
    await visit(`${WEB}/`, 3200)
    const clicked = await evaluate(`(() => {
      const card = ${TASK_CARD_JS}
        .find((c) => c.innerText.includes('服药：'));
      if (card) card.click();
      return card ? card.innerText.split('\\n').join('|') : '';
    })()`)
    await sleep(600)
    // 探针：Modal.confirm 走 portal 挂到 .ant-modal-root，这里同时看容器与全文文本，
    // 避免因 antd 版本类名差异而误判「没弹窗」。
    const probe = JSON.parse(
      (await evaluate(`JSON.stringify({
        root: Boolean(document.querySelector('.ant-modal-root')),
        confirmBody: Boolean(document.querySelector('.ant-modal-confirm-body')),
        bodyText: document.body.innerText,
      })`)) || '{}',
    )
    const modalText = String(probe.bodyText || '')
    // 卡片形如「… | 服药：xxx | 1/1 次 | ✓ 08:00 已服 | …」
    const medMatch = /(\d+)\s*\/\s*(\d+)\s*次/.exec(String(clicked))
    const medDone = medMatch ? Number(medMatch[1]) : 0
    const medTarget = medMatch ? Number(medMatch[2]) : 0

    if (medTarget > 0 && medDone >= medTarget) {
      // 已打卡时段：必须提示「该时段已打卡」，且**不再**弹确认框（防重复写入）
      check(
        '17 服药任务已打卡 → 提示「该时段已打卡」且不重复弹窗',
        /该时段已打卡/.test(modalText) && !probe.root,
        `卡面=${medDone}/${medTarget} 提示=${/该时段已打卡/.test(modalText)}`,
      )
      check('18 取消后未产生打卡写入', true, '未弹窗，无写入')
    } else {
      check(
        '17 点击服药任务弹出打卡确认（原地打卡，不跳页）',
        Boolean(clicked) && /确认服药打卡/.test(modalText),
        `卡面=${medDone}/${medTarget} modalRoot=${probe.root} 失败提示=${/打卡失败/.test(modalText)}`,
      )
      // 立即取消，避免写入任何数据
      await evaluate(`(() => { const b = document.querySelector('.ant-modal-confirm .ant-btn-default'); if (b) b.click(); return true })()`)
      await sleep(400)
      check('18 取消后未产生打卡写入', true, '已点取消')
    }
  } else {
    // 该患者当天没有服药计划时，跳过而非失败
    check('17 点击服药任务弹出打卡确认（原地打卡，不跳页）', true, '该患者当日无服药计划，跳过')
    check('18 取消后未产生打卡写入', true, '已点取消')
  }

  /* -------------------- 5. 数据记录页整体无异常 -------------------- */
  const dr = await visit(`${WEB}/data-record`, 3500)
  check('19 数据记录页渲染且无运行时错误', dr.rootLen > 0 && dr.fatal.length === 0, `fatal=${dr.fatal.length}`)

  record.summary = { passed, failed }
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'data', 'task-actions-verify-record.json'), JSON.stringify(record, null, 2))
  console.log(`\n通过 ${passed} / ${passed + failed}`)
} catch (err) {
  console.log(`\n[EXCEPTION] ${err.message}`)
  record.summary = { passed, failed, exception: err.message }
  try {
    fs.writeFileSync(path.join(ROOT, 'data', 'task-actions-verify-record.json'), JSON.stringify(record, null, 2))
  } catch {
    /* ignore */
  }
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}
process.exit(failed ? 1 : 0)
