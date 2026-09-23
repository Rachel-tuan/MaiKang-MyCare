/**
 * 迈康 MyCare · 医生调整「今日任务」验收（Step 11 · Phase 1）
 * ===========================================================================
 * 覆盖两类关卡：
 *
 *   【A 组 · 服务端契约】跑在**副本库**上（MYCARE_DB_PATH 注入，临时端口 3042）
 *     · 规则仍是唯一生成者：只能改「当日规则已生成任务」的参数
 *     · 只能改 target / slots；医学阈值与白名单外字段一律拒绝
 *     · 第一版整体不接受 enabled=false（主诊断 → E_PRIMARY_TASK_DISABLE_FORBIDDEN；
 *       其余 → E_DISABLE_NOT_SUPPORTED_IN_V1）
 *     · 校验原子性：一合法 + 一非法 → 整包拒绝且库零变化
 *     · F-1 `patient_targets` 排序加固：二次覆盖必须读到**新值**（旧语句会读到旧值且不报错）
 *     · F-2 `patient_targets.basis` 不得被写（登录页把它当 JSON 消费）
 *     · 撤销：回落规则值；整包清空时步数目标还原为**覆盖前原始值**
 *     · 患者端 `/daily-tasks` 下传覆盖（override 回显 + 顶层 taskOverrides）
 *     · 医生建议真落库 + 标记已读
 *
 *   【B 组 · 真实浏览器全链路】临时 vite（3043）→ 副本后端（3042）
 *     · 医生端抽屉可开、下发契约字典、负向输入被后端拦下
 *     · 改值 → 医生端「医生已调整」→ 患者端首页徽标 + 依据
 *     · 撤销 → 两端徽标消失
 *
 * 红线：**真实演示库 data/mycare.db 全程只读、零改动**（脚本首尾比对 mtime/大小）。
 *       B 组刻意不跑在 3000/3001 上，避免真实库被写入。
 *
 * 用法：node scripts/db/verify-doctor-task-override.mjs
 * 前置：本机有 Edge/Chrome；无需先启动 3000/3001
 * 产出：data/doctor-task-override-verify-record.json
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
const TEST_DB = path.join(os.tmpdir(), `mycare-override-${Date.now()}.db`)
const API_PORT = Number(process.env.MYCARE_OVERRIDE_API_PORT || 3042)
const WEB_PORT = Number(process.env.MYCARE_OVERRIDE_WEB_PORT || 3043)
const CDP_PORT = Number(process.env.MYCARE_CDP_PORT || 9345)
const API = `http://127.0.0.1:${API_PORT}`
const WEB = `http://127.0.0.1:${WEB_PORT}`
const DOCTOR = 'doc_li'
const P1 = 'patient_1' // 张建国（高血压 → bp_monitor 为主诊断监测项）
const P1_NAME = '张建国'
const P2 = 'patient_2' // 李秀英（糖尿病 → 当日**不生成** bp_monitor）
const NODE = process.execPath
const VITE_CFG = path.join(ROOT, '.verify-override.vite.config.mjs')

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

/** 只读打开副本库（与后端进程并存，纯读） */
function queryDb(fn) {
  const db = new DatabaseSync(TEST_DB, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ *
 * 子进程：副本后端 + 临时 vite
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

// 1. 复制真实库 → 副本库
for (const ext of ['', '-wal', '-shm']) {
  const src = REAL_DB + ext
  if (fs.existsSync(src)) fs.copyFileSync(src, TEST_DB + ext)
}
console.log(`副本库：${TEST_DB}\n`)

/* =================== A 组 · 服务端契约 =================== */
try {
  apiChild = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(API_PORT), MYCARE_DB_PATH: TEST_DB },
    stdio: 'ignore',
  })

  const up = await waitFor(`${API}/api/status`)
  check('A1 副本后端就绪（独立端口 + 副本库）', up, up ? `listening ${API_PORT}` : '启动超时')
  if (!up) throw new Error('副本后端未就绪')

  // —— 读取基线 ——
  const base = await api('GET', `/doctors/${DOCTOR}/patients/${P1}/tasks`)
  const baseTasks = base.json?.tasks || []
  const baseSteps = baseTasks.find((t) => t.taskId === 'steps')
  const baseBp = baseTasks.find((t) => t.taskId === 'bp_monitor')
  const baseStepsTarget = Number(baseSteps?.target) || 0
  const baseBpTarget = Number(baseBp?.target) || 0

  check(
    'A2 医生端任务接口下发覆盖契约字典',
    base.status === 200 &&
      base.json?.overrideContract?.contractVersion === 1 &&
      Array.isArray(base.json.overrideContract.taskIds) &&
      base.json.overrideContract.taskIds.length === 4,
    `status=${base.status} taskIds=${(base.json?.overrideContract?.taskIds || []).join(',')}`
  )
  check('A3 张建国当日已生成步数任务且目标来自规则兜底', Boolean(baseSteps) && baseStepsTarget > 0, `target=${baseStepsTarget}`)
  check('A4 张建国当日已生成血压监测主任务', Boolean(baseBp), `taskIds=${baseTasks.map((t) => t.taskId).join(',')}`)
  check('A5 写入前无生效覆盖包', base.json?.overridePackage === null, `pkg=${JSON.stringify(base.json?.overridePackage)}`)

  // —— F-2 基线：patient_targets.basis ——
  const basisBefore = queryDb(
    (db) => db.prepare('SELECT basis FROM patient_targets WHERE patient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(P1)?.basis ?? null
  )

  // —— 正向：覆盖步数目标 ——
  const put1 = await api('PUT', `/doctors/${DOCTOR}/patients/${P1}/task-overrides`, {
    overrides: { steps: { target: 12000 } },
    basis: '膝关节疼痛康复期，遵医嘱上调每日步数上限',
  })
  const put1Steps = (put1.json?.tasks || []).find((t) => t.taskId === 'steps')
  check(
    'A6 覆盖步数目标 12000 写入成功并即时生效',
    put1.status === 200 && put1.json?.ok === true && Number(put1Steps?.target) === 12000,
    `status=${put1.status} target=${put1Steps?.target}`
  )

  const after1 = await api('GET', `/patients/${P1}/daily-tasks`)
  const after1Steps = (after1.json?.tasks || []).find((t) => t.taskId === 'steps')
  check(
    'A7 患者端 /daily-tasks 同步下发覆盖（override 回显 + fields）',
    after1Steps?.override?.applied === true && Array.isArray(after1Steps?.override?.fields) && after1Steps.override.fields.includes('target'),
    `override=${JSON.stringify(after1Steps?.override)}`
  )
  check(
    'A8 覆盖依据随任务下传（患者可见）',
    String(after1Steps?.override?.basis || '').length >= 4 && after1.json?.taskOverrides?.steps?.target === 12000,
    `basis=${after1Steps?.override?.basis}`
  )

  // —— F-1：patient_targets 同步 + 排序加固 ——
  const row1 = queryDb(
    (db) => db.prepare('SELECT target_id, steps_target, basis FROM patient_targets WHERE patient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(P1) ?? null
  )
  check('A9 F-1 patient_targets.steps_target 已同步为 12000', Number(row1?.steps_target) === 12000, `steps_target=${row1?.steps_target} id=${row1?.target_id}`)
  check('A10 F-2 patient_targets.basis 未被覆盖层改写', (row1?.basis ?? null) === basisBefore, `before=${basisBefore} after=${row1?.basis}`)

  const put2 = await api('PUT', `/doctors/${DOCTOR}/patients/${P1}/task-overrides`, {
    overrides: { steps: { target: 6000 } },
    basis: '复评后下调，先降到 6000 观察一周',
  })
  const readBack = await api('GET', `/doctors/${DOCTOR}/patients/${P1}/tasks`)
  const readBackSteps = (readBack.json?.tasks || []).find((t) => t.taskId === 'steps')
  check(
    'A11 F-1 二次覆盖读回新值（旧排序语句会读到旧值且不报错）',
    put2.status === 200 && Number(readBackSteps?.target) === 6000,
    `target=${readBackSteps?.target}`
  )

  const rev1 = await api('DELETE', `/doctors/${DOCTOR}/patients/${P1}/task-overrides/steps`)
  const afterRev = await api('GET', `/patients/${P1}/daily-tasks`)
  const revSteps = (afterRev.json?.tasks || []).find((t) => t.taskId === 'steps')
  const rowAfterRev = queryDb(
    (db) => db.prepare('SELECT steps_target FROM patient_targets WHERE patient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(P1) ?? null
  )
  check(
    'A12 撤销覆盖 → 回落规则值且覆盖态清除',
    rev1.status === 200 && rev1.json?.ok === true && Number(revSteps?.target) === baseStepsTarget && !revSteps?.override,
    `target=${revSteps?.target} base=${baseStepsTarget} override=${JSON.stringify(revSteps?.override)}`
  )
  check(
    'A13 撤销后 patient_targets.steps_target 还原为覆盖前原始值',
    (rowAfterRev?.steps_target ?? null) === (queryDb((db) => db.prepare('SELECT steps_target FROM patient_targets WHERE patient_id = ?').get(P1)?.steps_target ?? null) ?? null) &&
      rowAfterRev?.steps_target === null,
    `steps_target=${rowAfterRev?.steps_target}`
  )

  // —— 时段型：改 slots = 改频次 ——
  const put3 = await api('PUT', `/doctors/${DOCTOR}/patients/${P1}/task-overrides`, {
    overrides: { bp_monitor: { slots: ['晨起', '睡前'] } },
    basis: '患者白天不在家，改为晨起与睡前自测',
  })
  const put3Bp = (put3.json?.tasks || []).find((t) => t.taskId === 'bp_monitor')
  check(
    'A14 血压监测改时段 → 频次（target）同步为 2',
    put3.status === 200 && Number(put3Bp?.target) === 2 && (put3Bp?.slots || []).length === 2,
    `target=${put3Bp?.target} slots=${(put3Bp?.slots || []).map((s) => s.slot).join('/')}`
  )
  check(
    'A15 时段展示用「午后」、落库用「下午」（覆盖后仍遵守映射）',
    (put3Bp?.slots || []).every((s) => ['晨起', '上午', '下午', '睡前'].includes(s.slot)),
    `slots=${JSON.stringify((put3Bp?.slots || []).map((s) => ({ slot: s.slot, label: s.label })))}`
  )

  const rev2 = await api('DELETE', `/doctors/${DOCTOR}/patients/${P1}/task-overrides/bp_monitor`)
  const afterRev2 = await api('GET', `/doctors/${DOCTOR}/patients/${P1}/tasks`)
  const revBp = (afterRev2.json?.tasks || []).find((t) => t.taskId === 'bp_monitor')
  check(
    'A16 撤销时段覆盖 → 频次回落规则值',
    rev2.status === 200 && Number(revBp?.target) === baseBpTarget,
    `target=${revBp?.target} base=${baseBpTarget}`
  )

  // —— 错误码组（全部必须被后端拒绝）——
  const negCases = [
    ['A17 未知任务域 → E_UNKNOWN_TASK_ID', { overrides: { not_a_task: { target: 5000 } }, basis: '非法任务域测试' }, 400, 'E_UNKNOWN_TASK_ID'],
    ['A18 白名单内但不可覆盖（weight_record）→ E_TASK_NOT_OVERRIDABLE', { overrides: { weight_record: { target: 3 } }, basis: '不可覆盖任务测试' }, 400, 'E_TASK_NOT_OVERRIDABLE'],
    ['A19 该患者当日未生成该任务 → E_TASK_NOT_GENERATED_FOR_PATIENT', null, 400, 'E_TASK_NOT_GENERATED_FOR_PATIENT'],
    ['A20 医学阈值字段 → E_THRESHOLD_FIELD_FORBIDDEN', { overrides: { bp_monitor: { systolic_target: 160 } }, basis: '阈值字段必须被拒' }, 400, 'E_THRESHOLD_FIELD_FORBIDDEN'],
    ['A21 白名单外普通字段 → E_UNKNOWN_FIELD', { overrides: { steps: { foo: 1 } }, basis: '未知字段必须被拒' }, 400, 'E_UNKNOWN_FIELD'],
    ['A22 步数非 500 整数倍 → E_TARGET_NOT_MULTIPLE_OF_500', { overrides: { steps: { target: 12345 } }, basis: '步数必须为 500 的倍数' }, 400, 'E_TARGET_NOT_MULTIPLE_OF_500'],
    ['A23 目标越界 → E_TARGET_OUT_OF_RANGE', { overrides: { steps: { target: 99999 } }, basis: '越界目标必须被拒' }, 400, 'E_TARGET_OUT_OF_RANGE'],
    ['A24 时段为空数组 → E_SLOTS_INVALID', { overrides: { bp_monitor: { slots: [] } }, basis: '空时段必须被拒' }, 400, 'E_SLOTS_INVALID'],
    ['A25 时段重复项 → E_SLOTS_INVALID', { overrides: { bp_monitor: { slots: ['晨起', '晨起'] } }, basis: '重复时段必须被拒' }, 400, 'E_SLOTS_INVALID'],
    ['A26 停用主诊断监测项 → E_PRIMARY_TASK_DISABLE_FORBIDDEN', { overrides: { bp_monitor: { enabled: false } }, basis: '第一版不允许停用主诊断监测项' }, 400, 'E_PRIMARY_TASK_DISABLE_FORBIDDEN'],
    ['A27 停用非主诊断任务 → E_DISABLE_NOT_SUPPORTED_IN_V1', { overrides: { exercise: { enabled: false } }, basis: '第一版整体不支持停用' }, 400, 'E_DISABLE_NOT_SUPPORTED_IN_V1'],
    ['A28 依据缺失 → E_BASIS_REQUIRED', { overrides: { steps: { target: 9000 } }, basis: '' }, 400, 'E_BASIS_REQUIRED'],
    ['A29 覆盖包为空 → E_OVERRIDES_EMPTY', { overrides: {}, basis: '空覆盖包必须被拒' }, 400, 'E_OVERRIDES_EMPTY'],
    ['A30 契约版本不支持 → E_CONTRACT_VERSION_UNSUPPORTED', { overrides: { steps: { target: 9000 } }, basis: '契约版本测试', contractVersion: 99 }, 409, 'E_CONTRACT_VERSION_UNSUPPORTED'],
  ]

  // A19 需要「规则当日未为该患者生成」的任务：李秀英（糖尿病）当日无 bp_monitor
  const p2Tasks = await api('GET', `/doctors/${DOCTOR}/patients/${P2}/tasks`)
  const p2HasBp = (p2Tasks.json?.tasks || []).some((t) => t.taskId === 'bp_monitor')

  for (const [name, payload, expectStatus, expectCode] of negCases) {
    let body = payload
    let target = P1
    if (payload === null) {
      target = P2
      body = { overrides: { bp_monitor: { slots: ['晨起', '睡前'] } }, basis: '该患者当日未生成血压任务' }
    }
    const r = await api('PUT', `/doctors/${DOCTOR}/patients/${target}/task-overrides`, body)
    const codeOk = r.json?.code === expectCode
    const statusOk = r.status === expectStatus
    const extra = payload === null ? ` (P2 当日 bp_monitor 应缺席：${!p2HasBp})` : ''
    check(name, statusOk && codeOk, `status=${r.status}/${expectStatus} code=${r.json?.code}/${expectCode}${extra}`)
  }

  // —— 原子性：一合法 + 一非法 → 整包拒绝，库零变化 ——
  const beforeAtomic = await api('GET', `/doctors/${DOCTOR}/patients/${P1}/tasks`)
  const atomic = await api('PUT', `/doctors/${DOCTOR}/patients/${P1}/task-overrides`, {
    overrides: { steps: { target: 15000 }, bp_monitor: { systolic_target: 150 } },
    basis: '原子性验证：一半合法一半非法',
  })
  const afterAtomic = await api('GET', `/doctors/${DOCTOR}/patients/${P1}/tasks`)
  check(
    'A31 校验原子性：一合法一非法 → 整包拒绝且库零变化',
    atomic.status === 400 &&
      atomic.json?.code === 'E_THRESHOLD_FIELD_FORBIDDEN' &&
      JSON.stringify(afterAtomic.json?.tasks) === JSON.stringify(beforeAtomic.json?.tasks) &&
      afterAtomic.json?.overridePackage === null,
    `status=${atomic.status} code=${atomic.json?.code} pkg=${JSON.stringify(afterAtomic.json?.overridePackage)}`
  )

  // —— 医生建议：真落库 + 已读 ——
  const note = await api('POST', `/doctors/${DOCTOR}/patients/${P1}/notes`, {
    content: '本次任务调整后请按新目标执行，下周复诊带上血压记录。',
    noteType: '处方调整',
    priority: '高',
  })
  const notesList = await api('GET', `/patients/${P1}/doctor-notes?unread=1&limit=20`)
  const noteId = note.json?.noteId || note.json?.note_id || note.json?.id
  const foundUnread = (notesList.json?.notes || []).some((n) => (n.noteId || n.note_id) === noteId)
  check(
    'A32 医生建议真落库（201 + 患者端可见）',
    note.status === 201 && Boolean(noteId) && foundUnread,
    `status=${note.status} noteId=${noteId} unread=${foundUnread}`
  )

  const markRead = await api('POST', `/patients/${P1}/doctor-notes/${noteId}/read`)
  const unreadAfter = await api('GET', `/patients/${P1}/doctor-notes?unread=1&limit=20`)
  const stillUnread = (unreadAfter.json?.notes || []).some((n) => (n.noteId || n.note_id) === noteId)
  check(
    'A33 标记已读后不再出现在未读列表',
    markRead.status === 200 && !stillUnread,
    `status=${markRead.status} stillUnread=${stillUnread}`
  )

  const badDoctor = await api('GET', `/doctors/no_such_doctor/patients`)
  check('A34 不存在的医生被拒绝', badDoctor.status >= 400, `status=${badDoctor.status} code=${badDoctor.json?.code}`)

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

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycare-override-'))
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
    const pending = new Map()
    let bucket = null

    const send = (method, params = {}, sessionId) => {
      const id = ++seq
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      return new Promise((resolve) => pending.set(id, resolve))
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
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result)
        pending.delete(msg.id)
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
      const rootLen = Number(await evaluate('(document.getElementById("root")||{innerHTML:""}).innerHTML.length')) || 0
      const text = String((await evaluate('document.body ? document.body.innerText : ""')) || '')
      const fatal = bucket.exceptions.concat(bucket.consoleErrors.filter((t) => !BENIGN.some((re) => re.test(t))))
      return { rootLen, text, fatal }
    }

    /** 注入登录态（仅身份键） */
    const loginRes = await fetch(`${API}/api/patients/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId: P1 }),
    })
    const view = (await loginRes.json().catch(() => null))?.view || null

    // ⚠️ localStorage 必须写进目标 origin：先导航过去再写，写完 reload
    await visit(`${WEB}/login`, 2000)
    await evaluate(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(view))})`)
    await evaluate(`localStorage.setItem('userSettings', JSON.stringify({elderlyMode:true, voiceEnabled:false}))`)
    check('B2 登录态注入成功（仅身份键）', Boolean(view), `name=${view?.name}`)

    // —— 医生端 ——
    const doctorPage = await visit(`${WEB}/doctor`, 4000)
    check('B3 医生端页面渲染且无运行时错误', doctorPage.rootLen > 0 && doctorPage.fatal.length === 0, `fatal=${doctorPage.fatal.length} ${doctorPage.fatal[0] || ''}`)

    // 打开张建国的「今日任务」抽屉
    const openDrawer = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.ant-card')].find((c) => (c.innerText || '').includes(${JSON.stringify(P1_NAME)}));
      if (!card) return 'NO_CARD';
      const btn = [...card.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '今日任务');
      if (!btn) return 'NO_BUTTON';
      btn.click();
      return 'CLICKED';
    })()`)
    await sleep(2200)
    const drawerText = String((await evaluate(`(() => { const d = document.querySelector('.ant-drawer-content'); return d ? d.innerText : '' })()`)) || '')
    check('B4 抽屉可打开（点「今日任务」）', openDrawer === 'CLICKED' && drawerText.length > 0, `action=${openDrawer} len=${drawerText.length}`)
    check(
      'B5 抽屉明示「规则是今日任务的唯一生成者」边界',
      /规则是今日任务的唯一生成者/.test(drawerText) && /不允许停用主诊断监测项|不支持停用任务/.test(drawerText),
      `head=${drawerText.slice(0, 40).replace(/\n/g, ' ')}`
    )

    /**
     * 抽屉内的「步数目标」输入框定位片段（复用）。
     * ⚠️ 必须精确定位：抽屉里数值型任务不止一个（运动打卡 range 5–180），
     *    取 `.ant-input-number-input` 的第一个会张冠李戴 → 假失败。
     * ⚠️ 也不用「越界文本」做负向用例：antd InputNumber 对超出 max 的输入
     *    不触发 onChange，草稿不变 → 保存按钮恒禁用 → 点到的是禁用按钮。
     */
    const STEP_NUM_JS = `
      const title = [...drawer.querySelectorAll('.task-title')].find((t) => /步数/.test(t.innerText || ''));
      if (!title) return { step: 'NO_STEPS_ROW' };
      let host = title;
      while (host && !host.querySelector('.ant-input-number-input')) host = host.parentElement;
      const num = host ? host.querySelector('.ant-input-number-input') : null;
      if (!num) return { step: 'NO_INPUT' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(num, '12000');
      num.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const save = [...drawer.querySelectorAll('button')].find((b) => (b.innerText || '').includes('保存调整'));
      if (!save) return { step: 'NO_SAVE' };
      if (save.disabled) return { step: 'SAVE_DISABLED' };
    `

    // —— 预校验 1：未填调整依据 → 前端拦下（不发请求、不弹二次确认）——
    const guard1 = await evaluate(`(async () => {
      const drawer = document.querySelector('.ant-drawer-content');
      if (!drawer) return { step: 'NO_DRAWER' };
      ${STEP_NUM_JS}
      save.click();
      const seen = new Set();
      for (let i = 0; i < 10; i += 1) {
        document.querySelectorAll('.ant-message-notice-content').forEach((n) => seen.add((n.innerText || '').trim()));
        await new Promise((r) => setTimeout(r, 150));
      }
      return { step: 'DONE', toasts: [...seen], modal: Boolean(document.querySelector('.ant-modal-content')) };
    })()`)
    const toastsG1 = guard1?.toasts || []
    check(
      'B6 未填调整依据 → 前端拦下（无二次确认弹窗、不落库）',
      guard1?.step === 'DONE' && toastsG1.some((t) => /调整依据/.test(t)) && guard1.modal === false,
      `step=${guard1?.step} modal=${guard1?.modal} toasts=${JSON.stringify(toastsG1).slice(0, 140)}`
    )

    // —— 预校验 2 + 二次确认「再想想」取消路径：同样不得落库 ——
    const guard2 = await evaluate(`(async () => {
      const drawer = document.querySelector('.ant-drawer-content');
      if (!drawer) return { step: 'NO_DRAWER' };
      const ta = drawer.querySelector('textarea');
      if (!ta) return { step: 'NO_TEXTAREA' };
      const tsetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      tsetter.call(ta, '二次确认取消路径验证');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const save = [...drawer.querySelectorAll('button')].find((b) => (b.innerText || '').includes('保存调整'));
      if (!save) return { step: 'NO_SAVE' };
      save.click();
      await new Promise((r) => setTimeout(r, 900));
      const modal = document.querySelector('.ant-modal-content');
      if (!modal) return { step: 'NO_CONFIRM' };
      const cancel = [...modal.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '再想想');
      if (!cancel) return { step: 'NO_CANCEL' };
      cancel.click();
      await new Promise((r) => setTimeout(r, 800));
      const d = document.querySelector('.ant-drawer-content');
      return { step: 'DONE', hasOverrideTag: /医生已调整/.test(d ? d.innerText : '') };
    })()`)
    const noOverrideAfterCancel = await api('GET', `/doctors/${DOCTOR}/patients/${P1}/tasks`)
    check(
      'B7 二次确认「再想想」取消后不落库',
      guard2?.step === 'DONE' &&
        guard2.hasOverrideTag === false &&
        noOverrideAfterCancel.json?.overridePackage === null,
      `step=${guard2?.step} hasTag=${guard2?.hasOverrideTag} pkg=${JSON.stringify(noOverrideAfterCancel.json?.overridePackage)}`
    )

    // 只关掉可能残留的二次确认弹窗；**抽屉必须保持打开**（正向流程要复用，关掉后 innerText 为空）
    await evaluate(`(() => {
      document.querySelectorAll('.ant-modal-close').forEach((b) => b.click());
      return true;
    })()`)
    await sleep(800)

    // —— 正向：改值 → 医生端「医生已调整」——
    const posResult = await evaluate(`(async () => {
      const drawer = document.querySelector('.ant-drawer-content');
      if (!drawer) return { step: 'NO_DRAWER' };
      ${STEP_NUM_JS}
      const ta = drawer.querySelector('textarea');
      const tsetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      tsetter.call(ta, '康复期由医生上调至每日 12000 步');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      // save 已由上方片段声明（同作用域内不得重复 const）
      save.click();
      await new Promise((r) => setTimeout(r, 900));
      // ⚠️ 只认**可见**弹窗：取消过一次后，旧 Modal 的 DOM 仍在页面上，
      //    直接 querySelector 会点到隐藏按钮 → 提交根本没发生 → 假失败。
      const ok = [...document.querySelectorAll('.ant-modal-content')]
        .filter((m) => m.offsetParent !== null)
        .flatMap((m) => [...m.querySelectorAll('button')])
        .find((b) => (b.innerText || '').trim() === '确认调整');
      if (!ok) return { step: 'NO_CONFIRM' };
      ok.click();
      const seen = new Set();
      for (let i = 0; i < 16; i += 1) {
        document.querySelectorAll('.ant-message-notice-content').forEach((n) => seen.add((n.innerText || '').trim()));
        await new Promise((r) => setTimeout(r, 200));
      }
      const d2 = document.querySelector('.ant-drawer-content');
      return { step: 'DONE', toasts: [...seen], drawer: d2 ? d2.innerText : '' };
    })()`)
    const toastsPos = posResult?.toasts || []
    check(
      'B8 正向提交成功（患者端已同步生效）',
      posResult?.step === 'DONE' && toastsPos.some((t) => /已保存/.test(t)),
      `step=${posResult?.step} toasts=${JSON.stringify(toastsPos).slice(0, 160)}`
    )

    const afterPosApi = await api('GET', `/doctors/${DOCTOR}/patients/${P1}/tasks`)
    const posSteps = (afterPosApi.json?.tasks || []).find((t) => t.taskId === 'steps')
    check('B9 覆盖包落库并在医生端读回 12000', Number(posSteps?.target) === 12000, `target=${posSteps?.target}`)
    check(
      'B10 医生端抽屉显示「医生已调整」与调整依据',
      /医生已调整/.test(posResult?.drawer || '') && /康复期由医生上调/.test(posResult?.drawer || ''),
      `hasTag=${/医生已调整/.test(posResult?.drawer || '')}`
    )

    // —— 患者端首页徽标 ——
    const home = await visit(`${WEB}/`, 4500)
    check(
      'B11 患者端首页出现「医生已调整」徽标与依据',
      /医生已调整/.test(home.text) && /康复期由医生上调/.test(home.text),
      `fatal=${home.fatal.length} len=${home.text.length}`
    )

    // —— 撤销 → 两端徽标消失 ——
    await visit(`${WEB}/doctor`, 4000)
    const revokeResult = await evaluate(`(async () => {
      const card = [...document.querySelectorAll('.ant-card')].find((c) => (c.innerText || '').includes(${JSON.stringify(P1_NAME)}));
      if (!card) return { step: 'NO_CARD' };
      const btn = [...card.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '今日任务');
      btn.click();
      await new Promise((r) => setTimeout(r, 2200));
      const drawer = document.querySelector('.ant-drawer-content');
      const rev = drawer ? [...drawer.querySelectorAll('button')].find((b) => (b.innerText || '').includes('撤销调整')) : null;
      if (!rev) return { step: 'NO_REVOKE' };
      rev.click();
      await new Promise((r) => setTimeout(r, 900));
      const ok = [...document.querySelectorAll('.ant-modal-content button')].find((b) => (b.innerText || '').trim() === '确认撤销');
      if (!ok) return { step: 'NO_CONFIRM' };
      ok.click();
      await new Promise((r) => setTimeout(r, 2200));
      const d2 = document.querySelector('.ant-drawer-content');
      return { step: 'DONE', drawer: d2 ? d2.innerText : '' };
    })()`)
    check(
      'B12 撤销调整后抽屉不再显示「医生已调整」',
      revokeResult?.step === 'DONE' && !/医生已调整/.test(revokeResult?.drawer || ''),
      `step=${revokeResult?.step}`
    )

    const afterRevokeApi = await api('GET', `/doctors/${DOCTOR}/patients/${P1}/tasks`)
    const revSteps2 = (afterRevokeApi.json?.tasks || []).find((t) => t.taskId === 'steps')
    check(
      'B13 撤销后覆盖包失效且目标回落规则值',
      afterRevokeApi.json?.overridePackage === null && Number(revSteps2?.target) === baseStepsTarget,
      `target=${revSteps2?.target} base=${baseStepsTarget}`
    )

    const homeAfter = await visit(`${WEB}/`, 4500)
    check(
      'B14 患者端首页徽标随之消失',
      !/医生已调整/.test(homeAfter.text) && homeAfter.fatal.length === 0,
      `fatal=${homeAfter.fatal.length}`
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
  path.join(ROOT, 'data', 'doctor-task-override-verify-record.json'),
  JSON.stringify(record, null, 2)
)

console.log(`\n合计：${passed}/${passed + failed} 通过${failed ? `，${failed} 项失败` : ''}`)
console.log('记录：data/doctor-task-override-verify-record.json')
process.exit(failed ? 1 : 0)
