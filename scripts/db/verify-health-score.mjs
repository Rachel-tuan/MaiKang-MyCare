/**
 * 迈康 MyCare · 「健康评分」口径验收（纯函数 + 服务端一致性 + 真实浏览器）
 * ===========================================================================
 * 背景（2026-09-15 用户实测反馈）：
 *   张建国当天**血压 0/2 次（完全没测）**，首页却显示「今日健康评分 100 优秀」，
 *   而同屏晨报写着「风险等级：预警 · 血压连续异常」—— 自相矛盾。
 *
 * 根因：
 *   旧实现的**分母随当日数据漂移**：`if (有血压) maxScore += 25`。
 *   于是没测的维度既不进分子也不进分母，缺测 = 不扣分；
 *   极端情况（只走了步数、血压血糖全没测）分子分母同时缩水到 50/50 → 100 分。
 *   前端 HealthDataContext 与服务端 tools.computeHealthScore **各自实现了一遍**，
 *   阈值分档还不一致（80/60 两档 vs 85/70/55 四档），两处都错。
 *
 * 修订后的口径（唯一实现：src/utils/healthScore.js，前后端共用）：
 *   · 分母 = 该患者**适用维度**的权重之和，由疾病谱确定性决定，**不随数据漂移**；
 *   · 血压系疾病才计血压、血糖系疾病才计血糖；步数 / 运动为通用项恒计；
 *   · 已录入未达标 → 按阶梯拿部分分；**未录入 → 记 0 分并标记 missing**；
 *   · 分档统一为 85 / 70 / 55 四档。
 *
 * 用法：node scripts/db/verify-health-score.mjs
 *   环境变量：MYCARE_UI_PATIENT（默认 patient_1）、MYCARE_CDP_PORT、MYCARE_WEB_URL、MYCARE_API_URL
 * 前置：前端 3000、后端 3001 已在运行
 * 产出：data/health-score-verify-record.json
 * 说明：只读接口，不写入任何患者数据。
 *
 * Step 11 · Phase 3 修订：
 *   原「20 首页评分与同源实现一致」拆为两条 ——
 *     · 20 Rule Score **三层同源**（界面 = 本地实现 = 服务端晨报）
 *     · 26 AI 辅助分**不得成为主数字**（有则必须带 `[AI 辅助]` 标签 + 免责脚注）
 *   AI 辅助分自身的确定性约束（六条硬约束 / 守恒 / clamp / 缓存失效）由
 *   `verify-ai-score.mjs` 用 stub 模型确定性覆盖 —— 本脚本不重复实现，
 *   否则会变成「跑在真实模型上、结果随机」的假断言。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { computeDailyHealthScore, gradeOf, SCORE_WEIGHTS } from '../../src/utils/healthScore.js'

const ROOT = process.cwd()
const WEB = process.env.MYCARE_WEB_URL || 'http://127.0.0.1:3000'
const API = process.env.MYCARE_API_URL || 'http://127.0.0.1:3001'
const PORT = Number(process.env.MYCARE_CDP_PORT || 9361)
const PATIENT_ID = process.env.MYCARE_UI_PATIENT || 'patient_1'

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const BENIGN = [/^Warning: /, /React Router Future Flag/, /autocomplete attributes/]

/**
 * 东八区「今天」YYYY-MM-DD。
 * ---------------------------------------------------------------------------
 * ⚠️ 本脚本第二 / 三段的 `local` 是**服务端同源口径的镜像实现**，必须与
 *    `getTodayData()` / `tools.computeHealthScore()` / `aiScoreService.buildScoreSnapshot()`
 *    的**基准日**保持一致 —— 三者恒为「真实今天（CST）」。
 *
 * 镜像若停留在旧的「取记录窗口内日期最大的一行」，就会拿**旧口径**的本地分
 * 去比**新口径**的晨报分，那是**假失败**，不是回归。
 * （断言本身一条未改：14 / 20 / 24 / 26 比的一直是「本地镜像 == 服务端 == 界面」。）
 */
const cstToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())

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

const HBP = ['原发性高血压', '超重', '中心性肥胖']
const DM = ['2 型糖尿病', '超重', '血脂异常']
const BOTH = ['高血压', '2 型糖尿病']
const NONE = []

/* ========================================================================== *
 * 第一段：纯函数口径（不依赖服务，最快定位回归）
 * ========================================================================== */
console.log('—— 第一段：确定性口径（src/utils/healthScore.js）——')

const scoreOf = (today, diseases) => computeDailyHealthScore({ today, diseases })

// 1. 核心缺陷回归：缺测不得满分
const missingBp = scoreOf({ steps: 10333, exercise_minutes: 60 }, HBP)
check(
  '1 高血压患者未测血压时不得满分（缺陷回归）',
  missingBp.score < 100,
  `score=${missingBp.score} 分母=${missingBp.applicableWeight} 缺测=${missingBp.missing.join('、') || '无'}`,
)
check(
  '2 未录入的血压按 0 分计入分母',
  missingBp.breakdown.find((b) => b.key === 'bloodPressure')?.status === 'missing' &&
    missingBp.breakdown.find((b) => b.key === 'bloodPressure')?.earned === 0,
  `血压项=${JSON.stringify(missingBp.breakdown.find((b) => b.key === 'bloodPressure'))}`,
)
check(
  '3 缺测时仍如实反映已达标项（步数/运动拿满）',
  missingBp.breakdown.find((b) => b.key === 'steps')?.earned === SCORE_WEIGHTS.steps &&
    missingBp.breakdown.find((b) => b.key === 'exercise')?.earned === SCORE_WEIGHTS.exercise,
  `分子=${missingBp.earnedWeight}/${missingBp.applicableWeight}`,
)

// 4. 分母由疾病谱决定，不吃降糖药的人不因「本就不需要测血糖」被扣分
const hbpOnly = scoreOf({ steps: 12000, systolic_pressure: 126, diastolic_pressure: 80, exercise_minutes: 60 }, HBP)
const dmOnly = scoreOf({ steps: 12000, blood_sugar: 6.1, exercise_minutes: 60 }, DM)
const both = scoreOf(
  { steps: 12000, systolic_pressure: 126, diastolic_pressure: 80, blood_sugar: 6.1, exercise_minutes: 60 },
  BOTH,
)
const noDisease = scoreOf({ steps: 12000, exercise_minutes: 60 }, NONE)

check(
  '4 高血压患者分母只含 步数+血压+运动（不含血糖）',
  hbpOnly.applicableWeight === 30 + 25 + 20 && !hbpOnly.breakdown.some((b) => b.key === 'bloodGlucose'),
  `分母=${hbpOnly.applicableWeight} 维度=${hbpOnly.breakdown.map((b) => b.label).join('/')}`,
)
check(
  '5 糖尿病患者分母只含 步数+血糖+运动（不含血压）',
  dmOnly.applicableWeight === 30 + 25 + 20 && !dmOnly.breakdown.some((b) => b.key === 'bloodPressure'),
  `分母=${dmOnly.applicableWeight} 维度=${dmOnly.breakdown.map((b) => b.label).join('/')}`,
)
check(
  '6 高血压 + 糖尿病时四个维度都计入（满分 100）',
  both.applicableWeight === 100 && both.breakdown.length === 4,
  `分母=${both.applicableWeight}`,
)
check(
  '7 无疾病谱的账号只计通用项（步数 + 运动 = 50 分）',
  noDisease.applicableWeight === 50,
  `分母=${noDisease.applicableWeight}`,
)
check(
  '8 适用维度全部达标时满分仍为 100（归一化正确）',
  hbpOnly.score === 100 && dmOnly.score === 100 && both.score === 100 && noDisease.score === 100,
  `高血压=${hbpOnly.score} 糖尿病=${dmOnly.score} 双病=${both.score} 无病=${noDisease.score}`,
)

// 9. 未达标 / 未录入 都不白送
const badBp = scoreOf({ steps: 12000, systolic_pressure: 170, diastolic_pressure: 105, exercise_minutes: 60 }, HBP)
const noExercise = scoreOf({ steps: 12000, systolic_pressure: 126, diastolic_pressure: 80, exercise_minutes: 0 }, HBP)
check(
  '9 血压严重超标按阶梯拿部分分（0.2 × 25）',
  badBp.breakdown.find((b) => b.key === 'bloodPressure')?.earned === 5,
  `血压项得分=${badBp.breakdown.find((b) => b.key === 'bloodPressure')?.earned}`,
)
check(
  '10 运动 0 分钟记 0 分（不做「没记录也送保底分」）',
  noExercise.breakdown.find((b) => b.key === 'exercise')?.earned === 0,
  `运动项得分=${noExercise.breakdown.find((b) => b.key === 'exercise')?.earned}`,
)

// 11. 步数阶梯必须整条单调不减，且 < 4000 的线性段不得越过 4000 步档
//     （旧前端用 floor(steps/1000)*3，9999 步能拿 27 分 > 8000 步档的 25 分，属越档）
const stepsEarned = (n) =>
  scoreOf({ steps: n, exercise_minutes: 60 }, NONE).breakdown.find((b) => b.key === 'steps').earned
const ladder = [0, 1000, 2000, 3000, 3999, 4000, 5999, 6000, 7999, 8000, 9999, 10000]
const earnedList = ladder.map(stepsEarned)
check(
  '11 步数阶梯整条单调不减（线性段已封顶，9999 步不得越过 10000 步档）',
  earnedList.every((v, i) => i === 0 || v >= earnedList[i - 1]) &&
    stepsEarned(3999) <= stepsEarned(4000) &&
    earnedList[earnedList.length - 1] === SCORE_WEIGHTS.steps,
  ladder.map((n, i) => `${n}→${earnedList[i]}`).join(' '),
)

// 12. 分档阈值
check(
  '12 分档阈值统一为 85 / 70 / 55',
  gradeOf(100) === '优秀' && gradeOf(85) === '优秀' && gradeOf(84) === '良好' &&
    gradeOf(70) === '良好' && gradeOf(69) === '一般' && gradeOf(55) === '一般' && gradeOf(54) === '需干预',
  `85→${gradeOf(85)} 70→${gradeOf(70)} 55→${gradeOf(55)} 54→${gradeOf(54)}`,
)

// 13. 空数据不得报错、不得给满分
const empty = scoreOf({}, HBP)
check(
  '13 完全没有记录时得 0 分且不抛异常',
  empty.score === 0 && empty.breakdown.length === 3,
  `score=${empty.score} 分母=${empty.applicableWeight}`,
)

/* ========================================================================== *
 * 第二段：服务端一致性（晨报口播的分数必须与同一实现算出的一致）
 * ========================================================================== */
console.log('\n—— 第二段：前后端同口径 ——')

const PROFILE_URL = (pid) => `${API}/api/patients/${pid}/profile`
const RECORDS_URL = (pid) => `${API}/api/patients/${pid}/records`

const fetchJson = async (url, init) => {
  try {
    const r = await fetch(url, init)
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

const demoPatients = ['patient_1', 'patient_2', 'patient_3']
const consistency = []

for (const pid of demoPatients) {
  const prof = await fetchJson(PROFILE_URL(pid))
  const diseases = prof?.view?.disease_types || []
  const recRes = await fetchJson(RECORDS_URL(pid))
  const rows = Array.isArray(recRes?.records) ? recRes.records : Array.isArray(recRes) ? recRes : []
  const sorted = [...rows].filter((r) => r && r.record_date).sort((a, b) => new Date(a.record_date) - new Date(b.record_date))
  // 基准日 = 真实今天（东八区）—— 与界面 getTodayData() / 服务端 computeHealthScore
  // / buildScoreSnapshot 同源。今日无记录 → 空对象 → 适用维度全部 missing、按 0 分计。
  const today = sorted.find((r) => r.record_date === cstToday()) || {}
  const local = computeDailyHealthScore({ today, diseases })

  const brief = await fetchJson(`${API}/api/agent/briefing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: pid }),
  })

  consistency.push({
    patientId: pid,
    name: prof?.view?.name,
    diseases,
    localScore: local.score,
    briefScore: brief?.score,
    applicableWeight: local.applicableWeight,
    missing: local.missing,
  })

  check(
    `14 晨报分数与本地同源实现一致 · ${prof?.view?.name || pid}`,
    brief?.score === local.score,
    `晨报=${brief?.score} 本地=${local.score} 分母=${local.applicableWeight} 缺测=${local.missing.join('、') || '无'}`,
  )
  check(
    `15 晨报分数与风险等级不再自相矛盾 · ${prof?.view?.name || pid}`,
    !((brief?.score === 100 || brief?.score >= 95) && brief?.risk?.label === '预警'),
    `score=${brief?.score} 风险=${brief?.risk?.label}`,
  )
}
record.consistency = consistency

/* ========================================================================== *
 * 第三段：真实浏览器（首页评分卡必须展示分数与分项依据）
 * ========================================================================== */
console.log('\n—— 第三段：真实浏览器 ——')

const exe = BROWSERS.find((p) => p && fs.existsSync(p))
if (!exe) {
  console.log('未找到本机 Edge/Chrome，跳过浏览器段。')
  record.summary = { passed, failed }
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, 'data', 'health-score-verify-record.json'),
    JSON.stringify(record, null, 2),
  )
  console.log(`\n通过 ${passed} / ${passed + failed}`)
  process.exit(failed ? 1 : 0)
}
record.browser = exe

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-score-'))
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

  const visit = async (url, waitMs = 4000) => {
    bucket = { exceptions: [], consoleErrors: [] }
    await send('Page.navigate', { url }, sessionId)
    await sleep(waitMs)
    const rootLen = Number(await evaluate('(document.getElementById("root")||{innerHTML:""}).innerHTML.length')) || 0
    const text = String((await evaluate('document.body ? document.body.innerText : ""')) || '')
    const fatal = bucket.exceptions.concat(bucket.consoleErrors.filter((t) => !BENIGN.some((re) => re.test(t))))
    return { rootLen, text, fatal }
  }

  const loginPage = await visit(`${WEB}/login`)
  check(
    '16 登录 / 注册页渲染且无运行时错误',
    loginPage.rootLen > 0 && loginPage.fatal.length === 0,
    `fatal=${loginPage.fatal.length}`,
  )

  /**
   * ⚠️ 登录态注入必须在**已经访问过一次目标域**之后执行。
   * localStorage 是按 origin 隔离的：若在 about:blank 上注入，写的是 about:blank 的存储，
   * 127.0.0.1:3000 读不到 → 首页回落登录页 → 后面所有针对首页的断言**集体假失败**
   * （且「不该出现的文案确实没出现」这类反向断言还会**假通过**）。
   */
  const loginRes = await fetch(`${API}/api/patients/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: PATIENT_ID }),
  })
  const view = (await loginRes.json().catch(() => null))?.view || null
  if (view) {
    await evaluate(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(view))})`)
    await evaluate(`localStorage.setItem('userSettings', JSON.stringify({elderlyMode:true, voiceEnabled:false}))`)
  }
  check('17 登录态注入成功（仅身份键）', Boolean(view), `name=${view?.name}`)

  const home = await visit(`${WEB}/`)
  check('18 首页渲染且无运行时错误', home.rootLen > 0 && home.fatal.length === 0, `fatal=${home.fatal.length}`)

  // 页面守卫：确认真的进了首页而不是被弹回登录页 —— 否则后续断言全是假结果
  const onHome = /今日健康评分/.test(home.text) && !/一键进入示范病例/.test(home.text)
  check(
    '19 确实进入了首页（未被回落登录页，挡住假失败/假通过）',
    onHome,
    `含「今日健康评分」=${/今日健康评分/.test(home.text)} 含登录入口=${/一键进入示范病例/.test(home.text)}`,
  )
  if (!onHome) {
    console.log(`  ↳ 页面首段：${home.text.slice(0, 120).replace(/\n/g, ' | ')}`)
  }

  // 评分卡取值
  const uiScore = Number(
    await evaluate(
      `(() => { const el = document.querySelector('.health-score'); return el ? String(el.innerText).replace(/\\D/g,'') : '' })()`,
    ),
  )
  const uiGrade = String(
    (await evaluate(
      `(() => { const el = document.querySelector('.score-description'); return el ? el.innerText.trim() : '' })()`,
    )) || '',
  )
  const expected = consistency.find((c) => c.patientId === PATIENT_ID)
  /**
   * Step 11 · Phase 3 拆分（原方案要求）：
   *   原「20 首页评分与同源实现一致」一条同时承担了两件事 —— 「Rule Score 同源」与
   *   「界面分数就是那个数」。引入 AI 辅助分后必须拆开，否则 AI 区块一旦上屏，
   *   这条断言将无法区分「主数字被夺权」与「同源被破坏」。
   *
   *   · 20  → **Rule Score 三层同源**：界面 = 本地实现 = 服务端晨报（唯一正式分）
   *   · 26  → **AI 辅助分不得成为主数字**：有 AI 区块则必须带 `[AI 辅助]` 标签 + 免责脚注
   *   · AI 辅助分自身的确定性约束（六条硬约束 / 守恒 / clamp 边界 / 缓存失效）
   *     由 `verify-ai-score.mjs` 用 stub 模型确定性覆盖，本脚本不重复实现
   */
  check(
    '20 Rule Score 三层同源（界面 = 本地实现 = 服务端晨报）',
    Number.isFinite(uiScore) &&
      uiScore > 0 &&
      uiScore === expected?.localScore &&
      uiScore === expected?.briefScore,
    `界面=${uiScore} 本地=${expected?.localScore} 晨报=${expected?.briefScore}`,
  )
  check(
    '21 首页档位文案来自统一分档（不再是旧的「需要改善」）',
    /^(优秀|良好|一般|需干预)$/.test(uiGrade),
    `档位=${uiGrade}`,
  )
  check(
    '22 界面已不再出现旧分档文案「需要改善」',
    onHome && !/需要改善/.test(home.text),
    `含旧文案=${/需要改善/.test(home.text)}`,
  )

  // 分项依据
  const breakdownRows = JSON.parse(
    (await evaluate(
      `JSON.stringify([...document.querySelectorAll('.score-breakdown-row')].map((el) => el.innerText.replace(/\\n/g,' ')))`,
    )) || '[]',
  )
  const missingRows = JSON.parse(
    (await evaluate(
      `JSON.stringify([...document.querySelectorAll('.score-breakdown-row.is-missing')].map((el) => el.innerText.replace(/\\n/g,' ')))`,
    )) || '[]',
  )
  record.ui = { score: uiScore, grade: uiGrade, breakdownRows, missingRows }

  check(
    '23 评分卡展示分项依据（每项 得分/满分）',
    breakdownRows.length >= 2 && breakdownRows.every((t) => /\d+(\.\d+)?\s*\/\s*\d+/.test(t)),
    `行数=${breakdownRows.length} 示例=${breakdownRows[0] || '无'}`,
  )
  check(
    '24 未录入维度在界面上被明确标出',
    (expected?.missing?.length || 0) === missingRows.length && breakdownRows.length > 0,
    `本地缺测=${(expected?.missing || []).join('、') || '无'} 界面高亮行=${missingRows.length}`,
  )

  /**
   * 26（Step 11 · Phase 3 新增，原「20」拆分出来的第二半）
   * ---------------------------------------------------------------------------
   * 编号 26 排在 25 之前：它**必须在首页 DOM 上求值**（25 会导航到 `/profile`）。
   *
   * ⚠️ **一条断言里的所有证据必须来自同一次导航**。首版把这段放在 `visit('/profile')`
   *    之后，于是 `document.querySelector('.ai-score-value')` 查的是**个人中心**，
   *    恒为 null —— 而 `home.text` 仍是首页快照（含免责脚注），结果断言拿到一个
   *    **假通过**（详情里 `免责脚注=true` 但 `AI 数字元素=false`，自相矛盾即证据）。
   *
   * AI 辅助分是**次级显示项**，任何时候都不得取代 Rule Score 成为主数字。
   *   · 页面**有** AI 区块 → 必须同时具备 `[AI 辅助]` 标签 + 免责脚注，
   *     且主数字仍等于 Rule Score；
   *   · 页面**没有** AI 区块（未生成 / 模型不可用 / 建议被拒）→ 主数字仍为 Rule Score，
   *     且不得出现孤零零的 AI 数字。
   * AI 辅助分自身的六条约束 / 守恒 / clamp 由 `verify-ai-score.mjs` 覆盖。
   */
  const aiNumber = await evaluate(`document.querySelector('.ai-score-value') !== null`)
  const aiBadge = await evaluate(`document.querySelector('.ai-score-badge') !== null`)
  const homeDisclaimer = /不是临床判据/.test(home.text) && /不参与预警分级/.test(home.text)
  check(
    '26 AI 辅助分不得成为主数字（主数字仍为 Rule Score；出现 AI 区块则必须带标签 + 免责脚注）',
    uiScore === expected?.localScore &&
      (aiNumber === false || (aiBadge === true && homeDisclaimer)),
    `主数字=${uiScore}(Rule=${expected?.localScore}) AI 数字元素=${aiNumber} AI 标签=${aiBadge} 免责脚注=${homeDisclaimer}`,
  )
  record.ui26 = { mainScore: uiScore, aiNumberEl: aiNumber, aiBadgeEl: aiBadge, homeDisclaimer }

  // 个人中心沿用同一口径
  const profile = await visit(`${WEB}/profile`, 3500)
  check('25 个人中心渲染且无运行时错误', profile.rootLen > 0 && profile.fatal.length === 0, `fatal=${profile.fatal.length}`)

  record.summary = { passed, failed }
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, 'data', 'health-score-verify-record.json'),
    JSON.stringify(record, null, 2),
  )
  console.log(`\n通过 ${passed} / ${passed + failed}`)
} catch (err) {
  console.log(`\n[EXCEPTION] ${err.message}`)
  record.summary = { passed, failed, exception: err.message }
  try {
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
    fs.writeFileSync(
      path.join(ROOT, 'data', 'health-score-verify-record.json'),
      JSON.stringify(record, null, 2),
    )
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
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
process.exit(failed ? 1 : 0)
