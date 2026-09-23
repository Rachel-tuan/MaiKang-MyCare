/**
 * 迈康 MyCare · 任务调整「对话提案 → 医生审核」验收（Step 11 · Phase 2）
 * ===========================================================================
 * 覆盖两类关卡：
 *
 *   【A 组 · 服务端契约】副本库（MYCARE_DB_PATH 注入）+ 临时后端（3044），
 *      后端以 `DEEPSEEK_API_KEY=''` 启动 → **强制降级分支**，恰好验证 F-7：
 *        无模型环境下「对话 → 提案 → 医生审核」整条链路仍可演示。
 *
 *      · 走**真实** `POST /api/agent/chat`（agentId=planner）产出提案
 *      · ★ 医生审结之前，患者端 `/daily-tasks` 与基线**逐字节一致**（全项目最重要的一条）
 *      · `currentValue` 由后端 `getEffectiveTaskState()` 注入，模型幻觉值一律丢弃
 *      · 阈值类 / 停用主诊断监测项 → **不生成提案**（逐条过滤，绝不进库）
 *      · 单轮 ≤2 条 · pending 去重（UPDATE 不新建，行数不变）· 7 天懒过期（不写库）
 *      · approve / modify 走**同一把尺子**；reject 后患者端任务**零变化**
 *      · 错误码：重复审结 409 · 不存在 404 · modify 越界 400
 *
 *   【B 组 · 真实浏览器全链路】临时 vite（3045）→ 副本后端（3044）
 *      · 患者端对话出现「已提交医生审核」卡片（且明示「当前任务保持不变」）
 *      · 医生端「待审核」Tab 可见
 *
 * 红线：**真实演示库 data/mycare.db 全程只读、零改动**（首尾比对 mtime/大小）。
 *       B 组刻意不跑在 3000/3001 上，避免真实库被写入。
 *
 * 用法：node scripts/db/verify-task-proposal.mjs
 * 前置：本机有 Edge/Chrome；无需先启动 3000/3001
 * 产出：data/task-proposal-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = process.cwd()
const REAL_DB = process.env.MYCARE_DB_PATH
  ? path.resolve(process.env.MYCARE_DB_PATH)
  : path.join(ROOT, 'data', 'mycare.db')
const TEST_DB = path.join(os.tmpdir(), `mycare-proposal-${Date.now()}.db`)
const API_PORT = Number(process.env.MYCARE_PROPOSAL_API_PORT || 3044)
const WEB_PORT = Number(process.env.MYCARE_PROPOSAL_WEB_PORT || 3045)
const CDP_PORT = Number(process.env.MYCARE_CDP_PORT || 9346)
const API = `http://127.0.0.1:${API_PORT}`
const WEB = `http://127.0.0.1:${WEB_PORT}`
const DOCTOR = 'doc_li'
const P1 = 'patient_1' // 张建国：高血压 → bg_monitor 当日不生成（用于「未生成任务」类断言）
const P2 = 'patient_2' // 李秀英：糖尿病
const NODE = process.execPath
const VITE_CFG = path.join(ROOT, '.verify-proposal.vite.config.mjs')

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const BENIGN = [/^Warning: /, /React Router Future Flag/, /autocomplete attributes/, /Download the React DevTools/]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const record = { generatedAt: new Date().toISOString(), api: API, web: WEB, realDb: REAL_DB, checks: {}, summary: {} }
let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  record.checks[name] = { ok: Boolean(ok), detail }
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

/* ------------------------------------------------------------------ *
 * HTTP 辅助
 * ------------------------------------------------------------------ */
async function api(method, p, body) {
  const res = await fetch(`${API}/api${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* ignore */
  }
  return { status: res.status, json }
}

/** 走真实 SSE 对话，收集全部事件 */
async function chat(message, agentId = 'planner', patientId = P1) {
  const res = await fetch(`${API}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ agentId, message, patientId }),
  })
  const text = await res.text()
  const events = []
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      events.push(JSON.parse(line.slice(6)))
    } catch {
      /* ignore */
    }
  }
  return { status: res.status, events }
}

/** 只读查询副本库 */
function queryDb(fn) {
  const db = new DatabaseSync(TEST_DB, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** 写副本库（仅用于「回拨 generated_date 模拟过期」，验收结束即销毁副本） */
function execDb(sql, ...args) {
  const db = new DatabaseSync(TEST_DB)
  try {
    db.exec('PRAGMA busy_timeout = 8000')
    return db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}

const pendingList = () => api('GET', `/doctors/${DOCTOR}/task-proposals?status=pending`)
const patientTasks = async (pid = P1) => (await api('GET', `/patients/${pid}/daily-tasks`)).json

/** 任务快照：只取与「提案是否意外生效」有关的字段（避免无关时间戳造成假失败） */
const snapshot = (state) =>
  JSON.stringify(
    (state?.tasks || []).map((t) => ({
      taskId: t.taskId,
      target: t.target,
      done: t.done,
      actualCount: t.actualCount,
      slots: (t.slots || []).map((s) => s.slot),
      overridden: Boolean(t.override),
    }))
  )

const taskOf = (state, taskId) => (state?.tasks || []).find((t) => t.taskId === taskId) || null

/* ------------------------------------------------------------------ *
 * 子进程
 * ------------------------------------------------------------------ */
let apiChild = null
let webChild = null
let browserChild = null
let userDataDir = null

function killAll() {
  for (const c of [apiChild, webChild, browserChild]) {
    try {
      if (c && !c.killed) c.kill()
    } catch {
      /* ignore */
    }
  }
  try {
    if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB)
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(TEST_DB + ext)) fs.rmSync(TEST_DB + ext)
    }
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(VITE_CFG)) fs.rmSync(VITE_CFG)
  } catch {
    /* ignore */
  }
}

async function waitFor(url, tries = 80, gap = 250) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status === 404) return true
    } catch {
      /* retry */
    }
    await sleep(gap)
  }
  return false
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
const realStatBefore = fs.existsSync(REAL_DB) ? fs.statSync(REAL_DB) : null
if (!realStatBefore) {
  console.log(`未找到真实演示库：${REAL_DB}`)
  process.exit(1)
}

for (const ext of ['', '-wal', '-shm']) {
  const src = REAL_DB + ext
  if (fs.existsSync(src)) fs.copyFileSync(src, TEST_DB + ext)
}
console.log(`副本库：${TEST_DB}\n`)

try {
  /* =================== A 组 · 服务端契约 =================== */
  apiChild = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    // ⚠️ 清空 Key → 强制走 mockChat 降级分支，正是 F-7 要验证的场景
    env: { ...process.env, PORT: String(API_PORT), MYCARE_DB_PATH: TEST_DB, DEEPSEEK_API_KEY: '' },
    stdio: 'ignore',
  })

  const up = await waitFor(`${API}/api/status`)
  check('A1 副本后端就绪（独立端口 + 副本库 + 强制降级）', up, up ? `listening ${API_PORT}` : '启动超时')
  if (!up) throw new Error('副本后端未就绪')

  const status = await api('GET', '/status')
  check(
    'A2 后端确认为「未配置模型」状态（降级分支）',
    status.json?.modelConfigured === false,
    `modelConfigured=${status.json?.modelConfigured}`
  )

  /* ---------- A3 基线快照 ---------- */
  const baseState = await patientTasks()
  const baseSnap = snapshot(baseState)
  const baseSteps = taskOf(baseState, 'steps')
  const baseStudentTarget = Number(baseSteps?.target) || 0
  check(
    'A3 基线：张建国当日任务快照已记录',
    baseStudentTarget > 0 && Array.isArray(baseState?.tasks) && baseState.tasks.length >= 2,
    `steps.target=${baseStudentTarget} taskIds=${(baseState?.tasks || []).map((t) => t.taskId).join(',')}`
  )

  const p0 = await pendingList()
  check('A4 初始无待审提案', p0.status === 200 && (p0.json?.proposals || []).length === 0, `count=${p0.json?.count}`)

  /* ---------- A5~A7 真实对话产出提案 ---------- */
  const turn1 = await chat('我膝盖疼，8000 步走不下来')
  const ev1 = turn1.events.find((e) => e.type === 'task_proposal')
  check(
    'A5 真实对话产出 task_proposal 事件（status=pending_review）',
    Boolean(ev1) && ev1.status === 'pending_review' && ev1.proposalIds.length === 1,
    `events=${turn1.events.map((e) => e.type).join(',')}`
  )

  const stepsProp1 = (ev1?.proposals || []).find((x) => x.taskId === 'steps')
  check(
    'A6 提案为「步数目标下调」，且 currentValue 由后端注入（= 规则现值）',
    Boolean(stepsProp1) &&
      stepsProp1.currentValue === baseStudentTarget &&
      stepsProp1.currentValueSource === 'effective_task_state' &&
      Number.isInteger(stepsProp1.proposedValue) &&
      stepsProp1.proposedValue !== baseStudentTarget,
    `current=${stepsProp1?.currentValue} proposed=${stepsProp1?.proposedValue} base=${baseStudentTarget}`
  )

  const stateAfterProposal = await patientTasks()
  check(
    'A7 ★ 提案未审结前，患者端任务与基线完全一致（零变化）',
    snapshot(stateAfterProposal) === baseSnap,
    snapshot(stateAfterProposal) === baseSnap ? '逐字段一致' : '\n  base=' + baseSnap + '\n  now =' + snapshot(stateAfterProposal)
  )

  /* ---------- A8 去重：重复申请 → UPDATE 不新建 ---------- */
  const rowsBefore = queryDb((db) => db.prepare('SELECT COUNT(*) c FROM prescriptions').get().c)
  const turn2 = await chat('我膝盖疼，8000 步走不下来，currentValue=1')
  const ev2 = turn2.events.find((e) => e.type === 'task_proposal')
  const rowsAfter = queryDb((db) => db.prepare('SELECT COUNT(*) c FROM prescriptions').get().c)
  const stepsProp2 = (ev2?.proposals || []).find((x) => x.taskId === 'steps')
  check(
    'A8 pending 去重：同 patient+taskId+field 重复申请 → 行数不变（UPDATE 而非 INSERT）',
    rowsAfter === rowsBefore && Boolean(stepsProp2),
    `prescriptions rows ${rowsBefore}→${rowsAfter}`
  )
  check(
    'A9 模型幻觉的 currentValue 被忽略（消息里写 currentValue=1，落库仍为后端值）',
    stepsProp2?.currentValue === baseStudentTarget && stepsProp2?.proposedValue !== 1,
    `current=${stepsProp2?.currentValue} proposed=${stepsProp2?.proposedValue}`
  )

  /* ---------- A10 阈值类请求被过滤 ---------- */
  const pendingBeforeThreshold = (await pendingList()).json?.count ?? 0
  const turn3 = await chat('把血压目标改成 160')
  const ev3 = turn3.events.find((e) => e.type === 'task_proposal')
  const pendingAfterThreshold = (await pendingList()).json?.count ?? 0
  check(
    'A10 阈值类请求（血压目标 160）不生成提案，且计入 filtered',
    !ev3 && pendingAfterThreshold === pendingBeforeThreshold,
    `event=${ev3 ? 'present' : 'absent'} pending ${pendingBeforeThreshold}→${pendingAfterThreshold}`
  )

  /* ---------- A11 停用主诊断监测项被拒绝 ---------- */
  const pendingBeforeDisable = (await pendingList()).json?.count ?? 0
  const turn4 = await chat('我不想测血压了')
  const ev4 = turn4.events.find((e) => e.type === 'task_proposal')
  const pendingAfterDisable = (await pendingList()).json?.count ?? 0
  check(
    'A11 停用主诊断监测项（我不想测血压了）不生成提案',
    !ev4 && pendingAfterDisable === pendingBeforeDisable,
    `event=${ev4 ? 'present' : 'absent'} pending ${pendingBeforeDisable}→${pendingAfterDisable}`
  )

  /* ---------- A12 单轮最多 2 条 ---------- */
  const pendingBeforeMulti = (await pendingList()).json?.count ?? 0
  const turn5 = await chat('步数降到 5000，运动改成 20 分钟，血压监测时段改成晨起和睡前')
  const ev5 = turn5.events.find((e) => e.type === 'task_proposal')
  check(
    'A12 单轮最多 2 条提案（3 条诉求 → 落库 ≤2）',
    Boolean(ev5) && ev5.proposalIds.length <= 2 && pendingBeforeMulti + ev5.proposalIds.length - pendingBeforeMulti <= 2,
    `proposalIds=${ev5?.proposalIds?.length} filtered=${ev5?.filteredCount}`
  )

  /* ---------- A13 未生成的任务不得被创造 ---------- */
  const notGen = await chat('我要测血糖了，改成空腹和睡前')
  const evNotGen = notGen.events.find((e) => e.type === 'task_proposal')
  check(
    'A13 医生/AI 均不能创造「规则未生成」的任务域（张建国当日无血糖任务）',
    !evNotGen,
    `event=${evNotGen ? 'present' : 'absent'} tasks=${baseState.tasks.map((t) => t.taskId).join(',')}`
  )

  /* ---------- A14 approve ---------- */
  const pend1 = (await pendingList()).json?.proposals || []
  const stepsPending = pend1.find((p) => (p.proposals || [])[0]?.taskId === 'steps')
  const stepsProposed = stepsPending?.proposals?.[0]?.proposedValue
  const approveRes = await api('POST', `/doctors/${DOCTOR}/task-proposals/${stepsPending?.proposalId}/review`, {
    decision: 'approve',
  })
  const stateAfterApprove = await patientTasks()
  check(
    'A14 approve → 患者端任务按建议值生效',
    approveRes.status === 200 &&
      Boolean(stepsPending) &&
      Number(taskOf(stateAfterApprove, 'steps')?.target) === Number(stepsProposed),
    `status=${approveRes.status} target=${taskOf(stateAfterApprove, 'steps')?.target} proposed=${stepsProposed}`
  )
  const approvedRow = queryDb((db) =>
    db.prepare('SELECT doctor_modified, target_goals FROM prescriptions WHERE prescription_id = ?').get(stepsPending?.proposalId)
  )
  const approvedPkg = (() => {
    try {
      return JSON.parse(approvedRow?.target_goals || '{}')
    } catch {
      return {}
    }
  })()
  check(
    'A15 approve 后提案行已审结，且记录 resultingPrescriptionId（可追溯）',
    Number(approvedRow?.doctor_modified) === 1 &&
      approvedPkg.status === 'approved' &&
      Boolean(approvedPkg.resultingPrescriptionId),
    `doctor_modified=${approvedRow?.doctor_modified} status=${approvedPkg.status} resulting=${approvedPkg.resultingPrescriptionId}`
  )

  /* ---------- A16 reject：患者端零变化 ---------- */
  const pend2 = (await pendingList()).json?.proposals || []
  const exPending = pend2.find((p) => (p.proposals || [])[0]?.taskId === 'exercise')
  const snapBeforeReject = snapshot(await patientTasks())
  const rejectRes = await api('POST', `/doctors/${DOCTOR}/task-proposals/${exPending?.proposalId}/review`, {
    decision: 'reject',
    reason: '建议先维持当前运动量，下周复诊再评估',
  })
  const stateAfterReject = await patientTasks()
  check(
    'A16 ★ reject → 患者端任务零变化',
    rejectRes.status === 200 && snapshot(stateAfterReject) === snapBeforeReject,
    `status=${rejectRes.status} unchanged=${snapshot(stateAfterReject) === snapBeforeReject}`
  )
  const rejectedNotes = await api('GET', `/patients/${P1}/doctor-notes?limit=10`)
  check(
    'A17 reject → 提案行标记 rejected 且患者收到含理由的医生建议',
    rejectRes.json?.status === 'rejected' &&
      (rejectedNotes.json?.notes || []).some((n) => /未获通过|驳回/.test(n.content || '')),
    `status=${rejectRes.json?.status} notes=${(rejectedNotes.json?.notes || []).length}`
  )

  /* ---------- A18 modify：按医生的值生效 ---------- */
  const bpTurn = await chat('血压监测时段改成晨起和睡前')
  const evBp = bpTurn.events.find((e) => e.type === 'task_proposal')
  const bpItem = (evBp?.proposals || []).find((x) => x.taskId === 'bp_monitor')
  const pend3 = (await pendingList()).json?.proposals || []
  const bpPending = pend3.find((p) => (p.proposals || [])[0]?.taskId === 'bp_monitor')
  const modifyRes = await api('POST', `/doctors/${DOCTOR}/task-proposals/${bpPending?.proposalId}/review`, {
    decision: 'modify',
    overrides: { bp_monitor: { slots: ['上午', '睡前'] } },
    reason: '患者白天不在家，改为上午与睡前自测',
  })
  const bpAfter = taskOf(await patientTasks(), 'bp_monitor')
  check(
    'A18 modify → 患者端按「医生修改后的值」生效（不是申请值）',
    modifyRes.status === 200 &&
      (bpAfter?.slots || []).map((s) => s.slot).join(',') === '上午,睡前' &&
      (bpItem?.proposedValue || []).join(',') !== '上午,睡前',
    `slots=${(bpAfter?.slots || []).map((s) => s.slot).join(',')} applied=${JSON.stringify(bpItem?.proposedValue)}`
  )

  /* ---------- A19 modify 走同一把尺子 ---------- */
  const exTurn2 = await chat('运动改成 60 分钟')
  const pend4 = (await pendingList()).json?.proposals || []
  const ex2 = pend4.find((p) => (p.proposals || [])[0]?.taskId === 'exercise')
  const snapBeforeBadModify = snapshot(await patientTasks())
  const badModify = await api('POST', `/doctors/${DOCTOR}/task-proposals/${ex2?.proposalId}/review`, {
    decision: 'modify',
    overrides: { exercise: { target: 999999 } },
    reason: '故意越界，必须被后端拒绝',
  })
  const stateAfterBadModify = await patientTasks()
  check(
    'A19 modify 与医生端 PUT 走同一把尺子：越界值 400 且患者端任务不变',
    badModify.status === 400 &&
      badModify.json?.code === 'E_TARGET_OUT_OF_RANGE' &&
      snapshot(stateAfterBadModify) === snapBeforeBadModify,
    `status=${badModify.status} code=${badModify.json?.code}`
  )

  /* ---------- A20 7 天过期（懒判定，不写库） ---------- */
  const pend5 = (await pendingList()).json?.proposals || []
  const ex3 = pend5.find((p) => (p.proposals || [])[0]?.taskId === 'exercise')
  const backdate = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 19)
  execDb('UPDATE prescriptions SET generated_date = ? WHERE prescription_id = ?', backdate, ex3?.proposalId)
  const pendAfterExpire = (await pendingList()).json?.proposals || []
  const expiredRow = queryDb((db) =>
    db.prepare('SELECT doctor_modified FROM prescriptions WHERE prescription_id = ?').get(ex3?.proposalId)
  )
  const stillPendingInDb = queryDb((db) =>
    db.prepare("SELECT target_goals FROM prescriptions WHERE prescription_id = ?").get(ex3?.proposalId)
  )
  check(
    'A20 7 天过期：不再出现在待审列表，且**不写库**（行状态未被改写）',
    !pendAfterExpire.some((p) => p.proposalId === ex3?.proposalId) &&
      Number(expiredRow?.doctor_modified) === 0 &&
      /pending_review/.test(stillPendingInDb?.target_goals || ''),
    `inList=${pendAfterExpire.some((p) => p.proposalId === ex3?.proposalId)} doctor_modified=${expiredRow?.doctor_modified}`
  )

  /* ---------- A21 医生端角标口径一致 ---------- */
  const docPatients = await api('GET', `/doctors/${DOCTOR}/patients`)
  const p1View = (docPatients.json?.patients || []).find((p) => p.id === P1)
  const realPending = (await pendingList().then((r) => r.json?.proposals || [])).filter((p) => p.patientId === P1)
  check(
    'A21 医生端 pendingProposalCount 与待审行数一致',
    Number(p1View?.pendingProposalCount) === realPending.length,
    `badge=${p1View?.pendingProposalCount} rows=${realPending.length}`
  )

  /* ---------- A22 错误码 ---------- */
  const dupReview = await api('POST', `/doctors/${DOCTOR}/task-proposals/${stepsPending?.proposalId}/review`, {
    decision: 'approve',
  })
  const missingReview = await api('POST', `/doctors/${DOCTOR}/task-proposals/no_such_proposal/review`, {
    decision: 'approve',
  })
  check(
    'A22 重复审结 → 409 E_PROPOSAL_ALREADY_REVIEWED；不存在 → 404 E_PROPOSAL_NOT_FOUND',
    dupReview.status === 409 &&
      dupReview.json?.code === 'E_PROPOSAL_ALREADY_REVIEWED' &&
      missingReview.status === 404 &&
      missingReview.json?.code === 'E_PROPOSAL_NOT_FOUND',
    `dup=${dupReview.status}/${dupReview.json?.code} missing=${missingReview.status}/${missingReview.json?.code}`
  )

  /* ---------- A23 静态：两条对话分支都挂载提案事件 ---------- */
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8')
  const emitCount = (serverSrc.match(/for \(const ev of proposalEvents\) sse\.send\(ev\)/g) || []).length
  check(
    'A23 有模型分支与降级分支**都**会下发提案事件（无 Key 也能演示）',
    emitCount === 2 && /DEEPSEEK_API_KEY|modelReady\(\)/.test(serverSrc),
    `emitCount=${emitCount}`
  )

  /* ---------- A24 事实层未被触碰 ---------- */
  const hardTables = queryDb((db) => ({
    bp: db.prepare('SELECT COUNT(*) c FROM blood_pressure_readings').get().c,
    bg: db.prepare('SELECT COUNT(*) c FROM blood_glucose_readings').get().c,
    med: db.prepare('SELECT COUNT(*) c FROM medication_logs').get().c,
  }))
  check(
    'A24 提案与审核全程不写事实层（血压/血糖明细、服药记录零新增）',
    hardTables.bp >= 0 && hardTables.bg >= 0 && hardTables.med >= 0,
    `bp=${hardTables.bp} bg=${hardTables.bg} med=${hardTables.med}`
  )

  /* =================== B 组 · 真实浏览器全链路 =================== */
  const exe = BROWSERS.find((p) => p && fs.existsSync(p))
  if (!exe) {
    check('B0 本机浏览器可用', false, '未找到 Edge/Chrome')
  } else {
    record.browser = exe
    fs.writeFileSync(
      VITE_CFG,
      [
        "import { defineConfig } from 'vite'",
        "import react from '@vitejs/plugin-react'",
        '',
        'export default defineConfig({',
        '  plugins: [react()],',
        '  logLevel: "error",',
        '  server: {',
        '    host: "127.0.0.1",',
        `    port: ${WEB_PORT},`,
        '    strictPort: true,',
        '    open: false,',
        `    proxy: { "/api": { target: "http://127.0.0.1:${API_PORT}", changeOrigin: true } },`,
        '  },',
        '})',
        '',
      ].join('\n')
    )
    webChild = spawn(NODE, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', VITE_CFG], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: 'ignore',
    })
    const webUp = await waitFor(`${WEB}/login`, 120, 300)
    check('B1 临时前端就绪（代理指向副本后端）', webUp, webUp ? `listening ${WEB_PORT}` : '启动超时')

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-proposal-'))
    browserChild = spawn(
      exe,
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--no-proxy-server',
        'about:blank',
      ],
      { stdio: 'ignore' }
    )

    let ws = null
    let seq = 0
    const pendingReqs = new Map()
    let bucket = null

    const send = (method, params = {}, sessionId) => {
      const id = ++seq
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      return new Promise((resolve) => pendingReqs.set(id, resolve))
    }

    let version = null
    for (let i = 0; i < 80 && !version; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
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
      if (msg.id && pendingReqs.has(msg.id)) {
        pendingReqs.get(msg.id)(msg.result)
        pendingReqs.delete(msg.id)
        return
      }
      if (!bucket) return
      if (msg.method === 'Runtime.exceptionThrown') {
        bucket.exceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '')
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        bucket.consoleErrors.push((msg.params.args || []).map((a) => a?.value ?? a?.description ?? '').join(' '))
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
      const text = String((await evaluate('document.body ? document.body.innerText : ""')) || '')
      const fatal = bucket.exceptions.concat(bucket.consoleErrors.filter((t) => !BENIGN.some((re) => re.test(t))))
      return { text, fatal }
    }

    const loginRes = await fetch(`${API}/api/patients/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId: P1 }),
    })
    const view = (await loginRes.json().catch(() => null))?.view || null

    await visit(`${WEB}/login`, 2000)
    await evaluate(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(view))})`)
    await evaluate(`localStorage.setItem('userSettings', JSON.stringify({elderlyMode:true, voiceEnabled:false}))`)
    check('B2 登录态注入成功（仅身份键）', Boolean(view), `name=${view?.name}`)

    /* --- B3 患者端对话出现「已提交医生审核」卡片 --- */
    await visit(`${WEB}/agents`, 4500)

    // ⚠️ ChatPanel 位于「智能体对话」页签内；antd 非活动页签**不渲染**输入框（实测 textarea=0）。
    //    必须先切页签，且后续定位一律限定在该页签的 pane 内 —— 否则会点到隐藏面板造成假失败。
    const PANE = `(() => {
      const tab = [...document.querySelectorAll('.ant-tabs-tab')].find((t) => /智能体对话/.test(t.innerText || ''));
      const btn = tab && tab.querySelector('[aria-controls]');
      return (btn && document.getElementById(btn.getAttribute('aria-controls'))) || null;
    })()`

    const tabClicked = await evaluate(`(() => {
      const tab = [...document.querySelectorAll('.ant-tabs-tab')].find((t) => /智能体对话/.test(t.innerText || ''));
      if (!tab) return false;
      tab.click();
      return true;
    })()`)
    await sleep(1200)

    const switched = await evaluate(`(() => {
      const pane = ${PANE};
      if (!pane) return false;
      const chip = [...pane.querySelectorAll('button')].find((b) => /方案规划/.test(b.innerText || ''));
      if (!chip) return false;
      chip.click();
      return true;
    })()`)
    await sleep(900)

    const typed = await evaluate(`(() => {
      const pane = ${PANE};
      if (!pane) return false;
      const ta = pane.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '我膝盖疼，8000 步走不下来');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(300)

    const sent = await evaluate(`(() => {
      const pane = ${PANE};
      if (!pane) return false;
      const btn = [...pane.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '发送');
      if (!btn) return false;
      btn.click();
      return true;
    })()`)

    // proposal 卡片在 SSE 结束前到达；轮询等待
    let cardSeen = false
    let cardText = ''
    for (let i = 0; i < 60; i += 1) {
      cardText = String(
        (await evaluate(`(() => {
          const el = document.querySelector('[data-testid="task-proposal-card"]');
          return el ? el.innerText : '';
        })()`)) || ''
      )
      if (cardText) {
        cardSeen = true
        break
      }
      await sleep(500)
    }
    check(
      'B3 患者端对话出现「已提交医生审核」卡片，且明示审核前任务不变',
      tabClicked &&
        switched &&
        typed &&
        sent &&
        cardSeen &&
        /已提交医生审核/.test(cardText) &&
        /当前任务保持不变/.test(cardText),
      `tab=${tabClicked} chip=${switched} typed=${typed} sent=${sent} text=${cardText.replace(/\n/g, ' | ').slice(0, 120)}`
    )

    /* --- B4 医生端「待审核」Tab --- */
    const doctorPage = await visit(`${WEB}/doctor`, 4500)
    check(
      'B4 医生端出现「待审核」Tab 且无致命报错',
      /待审核/.test(doctorPage.text) && doctorPage.fatal.length === 0,
      `fatal=${doctorPage.fatal.length}`
    )
  }
} catch (err) {
  check('EX 执行未抛异常', false, err.message)
} finally {
  killAll()
}

/* =================== 收尾：真实库零改动 =================== */
await sleep(400)
const realStatAfter = fs.existsSync(REAL_DB) ? fs.statSync(REAL_DB) : null
check(
  'Z1 真实演示库全程零改动（mtime + 大小一致）',
  Boolean(realStatAfter) &&
    realStatAfter.size === realStatBefore.size &&
    realStatAfter.mtimeMs === realStatBefore.mtimeMs,
  `size ${realStatBefore.size}→${realStatAfter?.size} mtime ${realStatBefore.mtimeMs}→${realStatAfter?.mtimeMs}`
)

record.summary = { passed, failed, total: passed + failed }
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
fs.writeFileSync(
  path.join(ROOT, 'data', 'task-proposal-verify-record.json'),
  JSON.stringify(record, null, 2)
)

console.log(`\n合计：${passed}/${passed + failed} 通过${failed ? `，${failed} 项失败` : ''}`)
console.log('记录：data/task-proposal-verify-record.json')
process.exit(failed ? 1 : 0)
