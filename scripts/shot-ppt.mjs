/**
 * 迈康 MyCare · 答辩 PPT 截图脚本
 * 用本机 Edge 无头 + CDP 访问关键页面，截图保存到 assets/
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const WEB = 'http://127.0.0.1:3000'
const API = 'http://127.0.0.1:3001'
const PORT = 9335
const PATIENT_ID = 'patient_1'
const OUT = path.join(ROOT, '迈康MyCare答辩PPT', 'assets')
const W = 1280
const H = 720

fs.mkdirSync(OUT, { recursive: true })

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const exe = BROWSERS.find((p) => p && fs.existsSync(p))
if (!exe) { console.log('no browser'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-shot-'))
const child = spawn(exe, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-extensions', '--no-proxy-server',
  '--window-size=1280,720',
  'about:blank',
], { stdio: 'ignore' })

let ws
let seq = 0
const pending = new Map()
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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) }
  })

  const target = await send('Target.createTarget', { url: 'about:blank' })
  const sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false }, sessionId)

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    return r?.result?.value
  }

  async function shot(url, filename, waitMs = 3500) {
    await send('Page.navigate', { url }, sessionId)
    await sleep(waitMs)
    // 截图前格式化页面上的小数百分比（仅截图进程内生效，不改源码）
    await evaluate(`(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const n of nodes) {
        const t = n.nodeValue;
        if (/\\d+\\.\\d{4,}%/.test(t)) n.nodeValue = t.replace(/(\\d+\\.\\d+)%/g, (_, x) => Math.round(Number(x)) + '%');
      }
    })()`)
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId)
    const buf = Buffer.from(r.data, 'base64')
    const p = path.join(OUT, filename)
    fs.writeFileSync(p, buf)
    const text = String(await evaluate('document.body ? document.body.innerText : ""') || '')
    console.log(`SHOT ${filename}  bytes=${buf.length}  textLen=${text.length}  head=${text.slice(0,50).replace(/\n/g,' ')}`)
  }

  // 1. 登录页
  await shot(`${WEB}/login`, '01_login.png', 3500)

  // 2. 写入登录态
  const loginRes = await fetch(`${API}/api/patients/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: PATIENT_ID }),
  })
  const view = (await loginRes.json()).view
  if (view) {
    await evaluate(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(view))})`)
    await evaluate(`localStorage.setItem('userSettings', JSON.stringify({elderlyMode:true, voiceEnabled:false}))`)
  }

  // 3. 首页
  await shot(`${WEB}/`, '02_home.png', 4000)
  // 4. 智能体对话
  await shot(`${WEB}/agents`, '03_agents.png', 3500)
  // 5. 数据记录
  await shot(`${WEB}/data-record`, '04_data_record.png', 3500)
  // 6. 健康建议
  await shot(`${WEB}/prescription`, '05_prescription.png', 3500)
  // 7. 医生端
  await shot(`${WEB}/doctor`, '06_doctor.png', 4000)
  // 8. 勋章
  await shot(`${WEB}/badges`, '07_badges.png', 3500)

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
