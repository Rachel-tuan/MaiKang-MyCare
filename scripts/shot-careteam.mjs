/**
 * 临时脚本（用完即删）：用 CDP 真机渲染验证「我的医疗团队」页，并出图。
 * 关键：注入 localStorage 前必须先访问过一次目标域（按 origin 隔离）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const WEB = 'http://127.0.0.1:3000'
const API = 'http://127.0.0.1:3001'
const PORT = 9336
const W = 1280
const H = 1000
const OUT = path.join(ROOT, '迈康MyCare答辩PPT', 'assets')

fs.mkdirSync(OUT, { recursive: true })

const exe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))
if (!exe) { console.log('no browser'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-ct-'))
const child = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-extensions', '--no-proxy-server', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' })

let ws
let seq = 0
const pending = new Map()
const consoleErrors = []
const exceptions = []

function send(method, params = {}, sessionId) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve) => pending.set(id, resolve))
}

async function main() {
  let version = null
  for (let i = 0; i < 60 && !version; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) version = await r.json() } catch {}
    if (!version) await sleep(250)
  }
  if (!version) throw new Error('CDP 未就绪')

  ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws fail'))) })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'unknown')
    }
  })

  const target = await send('Target.createTarget', { url: 'about:blank' })
  const sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false }, sessionId)

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text + ' | ' + (r.exceptionDetails.exception?.description || ''))
    return r?.result?.value
  }

  // 1) 先访问目标域（localStorage 按 origin 隔离，必须先落在该 origin 上）
  await send('Page.navigate', { url: `${WEB}/login` }, sessionId)
  await sleep(3000)

  // 2) 写入登录态（patient_1 张建国，免密示范病例）
  const loginRes = await fetch(`${API}/api/patients/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: 'patient_1' }),
  })
  const view = (await loginRes.json()).view
  if (!view) throw new Error('登录态获取失败')
  await evaluate(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(view))})`)
  await evaluate(`localStorage.setItem('userSettings', JSON.stringify({elderlyMode:true, voiceEnabled:false}))`)

  // 3) 打开授权页
  await send('Page.navigate', { url: `${WEB}/care-team` }, sessionId)
  await sleep(4000)

  const text = String((await evaluate('document.body ? document.body.innerText : ""')) || '')
  const onCareTeam = text.includes('我的医疗团队') && text.includes('李医生')
  const onLogin = text.includes('一键进入示范病例') || text.includes('忘记密码')

  console.log('=== 页面守卫 ===')
  console.log('  含「我的医疗团队」+「李医生」:', onCareTeam)
  console.log('  仍停留在登录页:', onLogin, onLogin ? '← ⚠️ 假通过风险' : '(正常)')
  console.log('=== 文案核验 ===')
  for (const k of ['我的医疗团队', '李医生', '主任医师', '已允许查看', '停止授权', '关于您的隐私', '未授权']) {
    console.log(`  ${text.includes(k) ? '✅' : '—'} ${k}`)
  }
  console.log('=== 按钮 ===')
  const btns = (await evaluate(
    `JSON.stringify(Array.from(document.querySelectorAll('button')).map(b=>b.innerText.trim()).filter(Boolean))`
  )) || '[]'
  console.log('  ' + btns)

  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId)
  const buf = Buffer.from(r.data, 'base64')
  const p = path.join(OUT, 'care_team.png')
  fs.writeFileSync(p, buf)
  console.log(`=== 截图 ===\n  ${p}  (${buf.length} 字节)`)

  console.log('=== 控制台错误 ===')
  console.log('  console.error:', consoleErrors.length ? consoleErrors.slice(0, 6) : '无')
  console.log('  未捕获异常:', exceptions.length ? exceptions.slice(0, 6) : '无')

  try { await send('Target.closeTarget', { targetId: target.targetId }) } catch {}
}

main().catch((e) => { console.error('ERR', e.message) })
  .finally(async () => {
    try { ws?.close() } catch {}
    try { child.kill() } catch {}
    await sleep(400)
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
    console.log('done')
    process.exit(0)
  })
