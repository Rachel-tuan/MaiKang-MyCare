#!/usr/bin/env node
/**
 * 迈康 MyCare · 本地服务管理器
 *
 * ── 为什么这些逻辑写在 Node 里，而不是直接写在 .bat 里 ──
 *
 * cmd.exe 的批处理解析器在「文件含非 ASCII 中文 + UTF-8」时会出现字节偏移漂移：
 * 读到某一行时会从字符中间切开，把后半截当成命令执行，报出
 *   '或重启电脑）后再运行本脚本。' is not recognized as an internal or external command
 * 已实测结论（2026-09-15）：
 *   1. 与行长无关 —— 单条长中文行单独跑完全正常，短行反而会炸；
 *   2. 与括号无关 —— 加 UTF-8 BOM 也无效；
 *   3. 与「累积的多字节内容」有关 —— 文件里中文越多，越容易在中途崩一次。
 * 因此 .bat 里一个非 ASCII 字符都不能留（纯 ASCII 实测稳定），
 * 全部中文文案与判断逻辑放在本 Node 文件里执行。
 *
 * ── 用法 ──
 *   node scripts/launch.mjs precheck    启动前检查；端口被占用 → 退出码 1
 *   node scripts/launch.mjs waitready   等待前端/后端就绪并打印访问地址
 *   node scripts/launch.mjs stop        关闭占用 3000/3001 的进程（需确认）
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 端口 → 用途。顺序即展示顺序，后端在前。 */
const PORTS = [
  { port: 3001, name: '后端智能体服务', url: 'http://127.0.0.1:3001/' },
  { port: 3000, name: '前端页面服务', url: 'http://127.0.0.1:3000/' },
]

/** 后端依赖 node:sqlite：v22.5.0 引入，v22.13.0 起免 --experimental-sqlite 标志 */
const MIN_NODE = { major: 22, minor: 13 }

const say = (s = '') => process.stdout.write(`${s}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 中文字符按 2 列宽计算，用于控制台对齐 */
function visualWidth(s) {
  let w = 0
  for (const ch of s) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1
  return w
}

function padCjk(s, width) {
  return s + ' '.repeat(Math.max(0, width - visualWidth(s)))
}

function banner(title) {
  say('================================================================')
  say('  迈康 MyCare · 老年慢病多智能体健康管理平台')
  say(`  ${title}`)
  say('================================================================')
  say()
}

/* --------------------------- 检测工具 --------------------------- */

/** 读取 netstat，返回 { 端口: PID }。失败返回 ok=false。 */
function listListeners() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve({ ok: false, byPort: new Map() })
      const byPort = new Map()
      for (const raw of String(stdout).split(/\r?\n/)) {
        if (!/LISTENING/i.test(raw)) continue
        const cols = raw.trim().split(/\s+/)
        if (cols.length < 5) continue
        const local = cols[1]
        const pid = Number(cols[cols.length - 1])
        for (const { port } of PORTS) {
          if (!byPort.has(port) && new RegExp(`:${port}$`).test(local)) byPort.set(port, pid)
        }
      }
      resolve({ ok: true, byPort })
    })
  })
}

/** node:sqlite 版本门禁。解析不出数字时放行，避免误拦。 */
function checkNodeVersion() {
  const raw = process.versions.node
  const [major, minor] = raw.split('.').map(Number)
  if (!Number.isFinite(major)) return { ok: true, raw }
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)
  return { ok, raw }
}

/** 单次 HTTP 探活 */
function probe(url, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

/** 取 JSON，失败返回 null */
function getJson(url, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return resolve(null)
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    let done = false
    // ⚠️ rl.close() 会**同步**触发下面的 'close' 事件。
    // 必须先置 done、再 close，否则 'close' 会抢先用 '' 解析掉 Promise，
    // 用户明确输入的 y 也会被判成「取消」（2026-09-15 实测踩坑，别改回去）。
    const finish = (answer) => {
      if (done) return
      done = true
      rl.close()
      resolve(answer)
    }
    rl.question(question, (a) => finish(a))
    // 输入被管道或 EOF 直接关闭时按「取消」处理，绝不误杀进程
    rl.on('close', () => finish(''))
  })
}

/** 取进程映像名（node.exe / chrome.exe ...），查不到返回空串 */
function imageName(pid) {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve('')
        const m = String(stdout).match(/"([^"]+)"/)
        resolve(m && m[1] !== 'INFO:' ? m[1] : '')
      },
    )
  })
}

function killPid(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }, (err) => resolve(!err))
  })
}

/**
 * 用系统默认浏览器打开地址（答辩演示时直接落到登录 / 注册页）。
 * · `cmd /c start` 的第一个参数是窗口标题，必须给空标题占位，否则 URL 会被当成标题。
 * · 失败时回落 explorer.exe（对 http 地址走 ShellExecute，同样交给默认浏览器）。
 * · 设 MYCARE_NO_OPEN=1 可完全跳过 —— 验收脚本、无头环境用。
 */
function openBrowser(url) {
  if (process.env.MYCARE_NO_OPEN === '1') return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('cmd', ['/c', 'start', '""', url], { windowsHide: true }, (err) => {
      if (!err) return resolve(true)
      execFile('explorer.exe', [url], { windowsHide: true }, () => resolve(true))
    })
  })
}

/** 演示入口：前端登录 / 注册页（**不是**根路径，根路径会按登录态直接进应用） */
const DEMO_URL = 'http://127.0.0.1:3000/login'

/* --------------------------- precheck --------------------------- */

async function cmdPrecheck() {
  banner('启动前检查')

  const node = checkNodeVersion()
  if (!node.ok) {
    say(`  [!!]   Node.js 版本过低：当前 v${node.raw}，需要 ${MIN_NODE.major}.${MIN_NODE.minor} 及以上。`)
    say('         原因：后端使用 Node 内置数据库 node:sqlite，')
    say(`         该模块 v22.5.0 引入、v${MIN_NODE.major}.${MIN_NODE.minor}.0 起才免 --experimental-sqlite 标志。`)
    say('         请升级 Node.js：https://nodejs.org/')
    say()
    say('  按任意键关闭本窗口。')
    return 1
  }
  say(`  [OK]   Node.js v${node.raw}（需要 >= ${MIN_NODE.major}.${MIN_NODE.minor}）`)

  if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
    say('  [OK]   项目依赖 node_modules')
  } else {
    say('  [!!]   缺少 node_modules，请先执行 npm install')
    say()
    say('  按任意键关闭本窗口。')
    return 1
  }

  const dbPath = path.join(ROOT, 'data', 'mycare.db')
  if (fs.existsSync(dbPath)) {
    say('  [OK]   数据库 data/mycare.db')
  } else {
    say('  [!!]   缺少数据库 data/mycare.db，请先执行：')
    say('           node scripts/db/build-sqlite.mjs')
    say('           node scripts/db/seed-sqlite.mjs')
    say()
    say('  按任意键关闭本窗口。')
    return 1
  }

  say()
  const { ok, byPort } = await listListeners()
  const busy = PORTS.filter((p) => byPort.has(p.port))

  if (!ok) {
    say('  [!!]   无法读取端口占用情况（netstat 执行失败），将直接尝试启动。')
    say()
    return 0
  }

  if (!busy.length) {
    say('  [OK]   端口 3000 / 3001 均空闲')
    say()
    say('  即将打开两个服务窗口 ...')
    say()
    return 0
  }

  for (const item of PORTS) {
    const pid = byPort.get(item.port)
    if (pid) {
      const name = await imageName(pid)
      say(`  [!!]   端口 ${item.port} 已被 PID ${pid} ${name || '(未知进程)'} 占用（${item.name}）`)
    } else {
      say(`  [OK]   端口 ${item.port} 空闲（${item.name}）`)
    }
  }
  say()
  say(`  服务可能已经在运行。可以先直接访问 ${DEMO_URL} 看看。`)
  say('  若占用者是 node.exe，通常就是本项目残留的前后端服务，关掉再启动即可。')
  say()

  const ans = await ask('  按 y 关闭上述进程并继续启动；直接回车只退出本窗口： ')
  if (ans.trim().toLowerCase() !== 'y') {
    say()
    say('  已退出，未做任何改动。')
    say()
    say('  按任意键关闭本窗口。')
    return 1
  }

  say()
  let allKilled = true
  for (const item of busy) {
    const pid = byPort.get(item.port)
    const killed = await killPid(pid)
    say(
      killed
        ? `  [OK]   已结束 PID ${pid}（端口 ${item.port}）`
        : `  [!!]   结束 PID ${pid} 失败，请用任务管理器按 PID 处理`,
    )
    if (!killed) allKilled = false
  }

  await sleep(1500)
  const after = await listListeners()
  const left = after.ok ? PORTS.filter((p) => after.byPort.has(p.port)) : []
  say()
  if (left.length || !allKilled) {
    say('  [!!]   仍有端口未释放，为避免启动失败，本次已停止。')
    say('         可手动排查： netstat -ano | findstr ":300"')
    say()
    say('  按任意键关闭本窗口。')
    return 1
  }
  say('  [OK]   端口已释放，继续启动 ...')
  say()
  return 0
}

/* --------------------------- waitready --------------------------- */

async function cmdWaitready() {
  banner('正在等待服务就绪')
  const deadline = Date.now() + 40000
  const ready = new Set()

  while (Date.now() < deadline) {
    for (const item of PORTS) {
      if (ready.has(item.port)) continue
      if (await probe(item.url)) ready.add(item.port)
    }
    if (ready.size === PORTS.length) break
    await sleep(1000)
  }

  const status = await getJson('http://127.0.0.1:3001/api/status')
  let modelText = ''
  if (status) {
    modelText = status.modelConfigured
      ? `模型：${status.model}`
      : '模型：未配置 Key，本地推理降级模式'
  }

  for (const item of PORTS) {
    const mark = ready.has(item.port) ? '[OK]' : '[!!]'
    const tail = ready.has(item.port) ? '' : '未就绪'
    say(`  ${mark}   ${padCjk(item.name, 15)}${item.url}   ${tail}`.trimEnd())
  }
  if (modelText) {
    say()
    say(`         ${modelText}`)
  }
  say()

  if (ready.size !== PORTS.length) {
    say('  等待超时：请查看刚弹出的两个黑色窗口里的错误信息。')
    say('  常见原因：数据库被占用、依赖缺失、或端口被其他程序抢占。')
    say()
    say('  按任意键关闭本窗口。')
    return 1
  }

  say('================================================================')
  say('  启动完成')
  say('================================================================')
  say(`  演示首页:  ${DEMO_URL}`)
  say('             （登录 / 注册页 —— 启动后固定落在这里）')
  say('  后端服务:  http://127.0.0.1:3001/')
  say('  服务状态:  http://127.0.0.1:3001/api/status')
  say()
  say('  * 刚弹出的两个黑色窗口请勿关闭，关闭即停止服务')
  say('  * 登录方式：点击「一键进入示范病例」，或自行注册新账号')
  say('  * 主页任务卡片可直接点击，跳转到对应录入项')
  say('  * 停止服务：运行本目录下的「关闭服务.bat」')
  say()
  const opened = await openBrowser(DEMO_URL)
  say(
    opened
      ? '  已用默认浏览器打开登录页（若未弹出窗口，请手动访问上面的地址）。'
      : '  请手动用浏览器访问上面的地址。',
  )
  say()
  say('  按任意键关闭本窗口（不会停止服务）')
  return 0
}

/* --------------------------- stop --------------------------- */

async function cmdStop() {
  banner('关闭本地服务')

  const { ok, byPort } = await listListeners()
  if (!ok) {
    say('  [!!]   无法读取端口占用情况（netstat 执行失败）。')
    say()
    say('  按任意键关闭本窗口。')
    return 1
  }

  const busy = PORTS.filter((p) => byPort.has(p.port))
  if (!busy.length) {
    say('  [OK]   端口 3000 / 3001 都没有被占用，无需关闭。')
    say()
    say('  按任意键关闭本窗口。')
    return 0
  }

  say('  检测到以下进程占用了本项目端口：')
  say()
  for (const item of busy) {
    const pid = byPort.get(item.port)
    const name = await imageName(pid)
    say(`    端口 ${item.port}  →  PID ${pid}   ${padCjk(name || '(未知进程)', 14)}（${item.name}）`)
  }
  say()
  say('  正常情况下应为 node.exe —— 即本项目由「启动项目.bat」拉起的')
  say('  vite 前端与智能体服务，可以放心关闭。')
  say('  若显示的是其它程序（浏览器、编辑器等），请直接回车取消，')
  say('  那两个端口是被别的软件占用了，改用任务管理器按 PID 查看。')
  say()

  const ans = await ask('  确认关闭请输入 y 后回车，其他任意输入取消： ')
  if (ans.trim().toLowerCase() !== 'y') {
    say()
    say('  已取消，未做任何改动。')
    say()
    say('  按任意键关闭本窗口。')
    return 0
  }

  say()
  for (const item of busy) {
    const pid = byPort.get(item.port)
    const killed = await killPid(pid)
    say(killed ? `  [OK]   已结束 PID ${pid}（端口 ${item.port}）` : `  [!!]   结束 PID ${pid} 失败，可能已退出或无权限`)
  }

  await sleep(2000)

  const after = await listListeners()
  const left = after.ok ? PORTS.filter((p) => after.byPort.has(p.port)) : []
  say()
  if (after.ok && !left.length) {
    say('  [OK]   端口 3000 / 3001 已释放。')
  } else {
    say('  [!!]   仍有端口被占用，请手动检查：')
    say('           netstat -ano | findstr ":300"')
  }
  say()
  say('  提示：若还有单独的黑色 cmd 窗口在跑 npm 命令，请一并关闭。')
  say()
  say('  按任意键关闭本窗口。')
  return 0
}

/* --------------------------- main --------------------------- */

const command = (process.argv[2] || '').toLowerCase()

const handlers = {
  precheck: cmdPrecheck,
  waitready: cmdWaitready,
  stop: cmdStop,
}

if (!handlers[command]) {
  say('用法：node scripts/launch.mjs <precheck|waitready|stop>')
  process.exit(2)
}

process.exit(await handlers[command]())
