/**
 * 迈康 MyCare · 验收：智能体「弱记忆」（Step 13）
 * ===========================================================================
 * 背景（用户 2026-09-17 提问）：
 *   「用户与智能体的对话会记录下来产生记忆吗？」
 * 查证结论：此前**完全不落库、也不形成记忆** —— 前端 `chats` 是 React 内存态，
 *   后端把前端传来的最近 10 条原文拼进 messages 用完即丢；22 张 P0 表里没有任何
 *   消息表，`agent_runs` / `reminders` / `vision_records` 全项目零写操作。
 * 用户对修法的明确选择：**「弱记忆 · 回灌现有表」**
 *   —— 每轮把「该患者过往诉求 + 医生最近结论」注入系统提示词，
 *      复用既有 `prescriptions` / `doctor_notes`，**不新增表、不改 schema**。
 *
 * 被验收的行为：
 *   ① 无记录的患者 → 记忆为空串，**不注入**（不往提示词里塞噪声）；
 *   ② 患者提过申请后 → 能读出**原话**与审结状态（已同意 / 未通过 + 医生说明）；
 *   ③ 能读出**医生最近结论**（复用 doctorNoteService 读取口径）；
 *   ④ 有界：诉求 ≤3 条、结论 ≤2 条，单条截断，提示词块总长受控；
 *   ⑤ 提示词块声明「历史、可能过期、要当前值必须调工具」；
 *   ⑥ 只渲染日期不渲染时刻（两张表时间基不同，见 agentMemory.js 红线 7）；
 *   ⑦ 患者不存在 → 抛 `E_PATIENT_NOT_FOUND`，**绝不回落示范患者**，也不跨患者串数据；
 *   ⑧ 记忆**不参与**任何确定性判定（规则引擎入参里没有 memory）；
 *   ⑨ 本模块**纯读**：纯读批次前后全库 22 张表逐表内容逐字节一致。
 *
 * 运行方式（自起自停，使用**副本库**，真实库零改动）：
 *   node scripts/db/verify-agent-memory.mjs
 * ---------------------------------------------------------------------------
 * 说明：显式把 DEEPSEEK_API_KEY 置空 → 走**本地推理引擎**通道。
 *   提案通道与模型可用性**解耦**（确定性通道），因此断言在无 Key 环境下同样可复现。
 *   演示库是干净种子（0 提案 / 0 备注），故本脚本用注册接口**自造**记忆素材。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const SRC_DB = join(ROOT, 'data', 'mycare-demo.db')
const TMP_DB = join(ROOT, 'data', '_agent-memory-verify.db')
const PORT = 3994
const BASE = `http://127.0.0.1:${PORT}`
const DOCTOR_ID = 'doc_li'
/** 演示库里一位「既无提案也无医生备注」的示范患者 → 用于验「空记忆不注入」 */
const EMPTY_PATIENT = 'patient_3'

const lines = []
let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    lines.push(`  ✅ ${name}${detail ? `  [${detail}]` : ''}`)
  } else {
    fail++
    lines.push(`  ❌ ${name}${detail ? `  [${detail}]` : ''}`)
  }
}

function section(t) {
  lines.push('')
  lines.push(`【${t}】`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 逐表内容快照（按内容排序，不用 rowid —— 避免物理行序变化造成假阳性） */
function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
    const out = {}
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all()
      out[name] = rows.map((r) => JSON.stringify(r)).sort().join('\n')
    }
    return out
  } finally {
    db.close()
  }
}

/** 去掉注释后再做「是否含写操作」的静态判定（避免注释里的字样误报） */
const stripComments = (s) =>
  String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json }
}

/** 消费 SSE：读完整流并返回事件数组 */
async function sse(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const events = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    try {
      events.push(JSON.parse(t.slice(5).trim()))
    } catch {
      /* 忽略无法解析的分片 */
    }
  }
  return { status: res.status, events, text }
}

/* ---------------------------------------------------------------- *
 * 副本实例准备：先复制库，再设 env，最后**动态** import 读库模块
 * （db.js 的 DB_PATH 在模块加载时读取 env，静态 import 会抢在赋值之前）
 * ---------------------------------------------------------------- */
if (!existsSync(SRC_DB)) {
  console.error(`缺少演示库：${SRC_DB}`)
  process.exit(1)
}
copyFileSync(SRC_DB, TMP_DB)
/** 真实（演示）库基线快照：脚本全程**不得**改动它，收尾时逐表比对 */
const realBaseline = snapshot(SRC_DB)
process.env.MYCARE_DB_PATH = TMP_DB

const { readPatientMemory, readRecentRequests, memoryPreamble, MEMORY_LIMITS } = await import(
  '../../server/data/agentMemory.js'
)
const { buildAgentContext, toRulePatient } = await import('../../server/data/agentContext.js')

const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    MYCARE_DB_PATH: TMP_DB,
    PORT: String(PORT),
    DEEPSEEK_API_KEY: '',
    ALLOW_MOCK_FALLBACK: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOut = ''
child.stdout.on('data', (d) => (serverOut += d.toString()))
child.stderr.on('data', (d) => (serverOut += d.toString()))

function cleanup() {
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${TMP_DB}${suffix}`, { force: true })
    } catch {
      /* ignore */
    }
  }
}

const stamp = String(Date.now()).slice(-6)
const PW = `Memory${stamp}`
const REJECT_REASON = '目前无糖尿病诊断，暂不纳入每日监测，继续随访观察血糖变化'
let pidApprove = null
let pidReject = null

try {
  let ready = false
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/status`)
      if (r.ok) {
        ready = true
        break
      }
    } catch {
      /* 尚未就绪 */
    }
    await sleep(250)
  }
  if (!ready) throw new Error('副本实例启动失败：\n' + serverOut)

  /* ================= 1. 空记忆：新注册患者还没有任何历史 ================= */
  section('1. 空记忆不注入（新患者 + 示范患者双重验证）')

  const regA = await api('/api/patients/register', {
    method: 'POST',
    body: {
      username: `verify_mem_a_${stamp}`,
      password: PW,
      name: '验收弱记忆甲',
      age: 70,
      gender: 'female',
      height: 158,
      weight: 60,
      phone: '13900004401',
      diseases: ['hypertension'],
    },
  })
  pidApprove = regA.json?.patientId
  check('注册患者甲成功（201）', regA.status === 201, `HTTP ${regA.status}`)
  check('返回 patientId', Boolean(pidApprove), String(pidApprove))

  const regB = await api('/api/patients/register', {
    method: 'POST',
    body: {
      username: `verify_mem_b_${stamp}`,
      password: PW,
      name: '验收弱记忆乙',
      age: 68,
      gender: 'male',
      height: 170,
      weight: 72,
      phone: '13900004402',
      diseases: ['hypertension'],
    },
  })
  pidReject = regB.json?.patientId
  check('注册患者乙成功（201）', regB.status === 201, `HTTP ${regB.status}`)

  const freshA = readPatientMemory(pidApprove)
  check('新患者甲记忆为空', !freshA.hasMemory)
  check('新患者甲提示词块为空串（不注入）', memoryPreamble(freshA) === '')
  const freshSeed = readPatientMemory(EMPTY_PATIENT)
  check(
    `示范患者 ${EMPTY_PATIENT} 无提案无备注 → 空串`,
    memoryPreamble(freshSeed) === '',
    `诉求 ${freshSeed.recentRequests.length} / 结论 ${freshSeed.recentDoctorNotes.length}`
  )
  check('memoryPreamble(null) 为空串', memoryPreamble(null) === '')
  check('memoryPreamble({}) 为空串', memoryPreamble({}) === '')
  check(
    'memoryPreamble(空数组) 为空串',
    memoryPreamble({ recentRequests: [], recentDoctorNotes: [] }) === ''
  )

  /* ================= 2. 造素材：对话提申请 → 医生审结 ================= */
  section('2. 造素材：患者对话提申请 → 医生审结')

  const chatA = await sse('/api/agent/chat', {
    agentId: 'planner',
    message: '我还想每天监测一下血糖，毕竟年纪老了',
    patientId: pidApprove,
  })
  check('患者甲对话返回 200', chatA.status === 200, `HTTP ${chatA.status}`)
  check('对话流正常收尾', chatA.events.some((e) => e.type === 'chat_done'))
  const pendA = await api(`/api/doctors/${DOCTOR_ID}/task-proposals?status=pending`)
  const propA = (pendA.json?.proposals || []).find((p) => p.patientId === pidApprove)
  check('生成待审「新增监测项」申请（甲）', Boolean(propA), String(propA?.proposalId))
  check('申请携带患者原话', String(propA?.utterance || '').includes('血糖'), propA?.utterance)

  const revA = await api(`/api/doctors/${DOCTOR_ID}/task-proposals/${propA?.proposalId}/review`, {
    method: 'POST',
    body: { decision: 'approve' },
  })
  check('医生同意（甲）', revA.status === 200 && revA.json?.status === 'approved', `HTTP ${revA.status} / ${revA.json?.status}`)

  const chatB = await sse('/api/agent/chat', {
    agentId: 'planner',
    message: '我想要每天再测量一下血糖，一次',
    patientId: pidReject,
  })
  check('患者乙对话返回 200', chatB.status === 200, `HTTP ${chatB.status}`)
  const pendB = await api(`/api/doctors/${DOCTOR_ID}/task-proposals?status=pending`)
  const propB = (pendB.json?.proposals || []).find((p) => p.patientId === pidReject)
  check('生成待审「新增监测项」申请（乙）', Boolean(propB), String(propB?.proposalId))

  const revB = await api(`/api/doctors/${DOCTOR_ID}/task-proposals/${propB?.proposalId}/review`, {
    method: 'POST',
    body: { decision: 'reject', reason: REJECT_REASON },
  })
  check('医生驳回（乙）', revB.status === 200 && revB.json?.status === 'rejected', `HTTP ${revB.status} / ${revB.json?.status}`)

  /* ================= 3. 读出的过往诉求 ================= */
  section('3. 过往诉求（prescriptions 提案行）')
  const memA = readPatientMemory(pidApprove)
  const memB = readPatientMemory(pidReject)
  check('患者甲 hasMemory = true', memA.hasMemory)
  check('患者甲读到 1 条诉求', memA.recentRequests.length === 1, String(memA.recentRequests.length))
  const reqA = memA.recentRequests[0]
  check('原话完整读出', reqA?.utterance === '我还想每天监测一下血糖，毕竟年纪老了', reqA?.utterance)
  check('申请描述正确（新增监测项）', reqA?.item === '申请新增「血糖」日常监测', reqA?.item)
  check('申请描述不含任何数值（不搬运 proposedValue）', !/\d/.test(String(reqA?.item || '')))
  check('审结状态 = 已同意', reqA?.status === 'approved' && reqA?.outcome === '医生已同意', `${reqA?.status} / ${reqA?.outcome}`)
  check('已同意时不带驳回理由', reqA?.doctorReason === null, String(reqA?.doctorReason))

  const reqB = memB.recentRequests[0]
  check('患者乙审结状态 = 未通过', reqB?.status === 'rejected' && reqB?.outcome === '医生未通过', `${reqB?.status} / ${reqB?.outcome}`)
  check('未通过时转述医生理由', reqB?.doctorReason === REJECT_REASON, reqB?.doctorReason)
  check(
    '诉求条数不超上限',
    memA.recentRequests.length <= MEMORY_LIMITS.requests,
    `${memA.recentRequests.length} ≤ ${MEMORY_LIMITS.requests}`
  )
  check(
    '单条原话已截断',
    memA.recentRequests.every((r) => r.utterance.length <= MEMORY_LIMITS.utteranceChars + 1),
    `上限 ${MEMORY_LIMITS.utteranceChars}`
  )
  check('不产生空原话条目', memA.recentRequests.every((r) => r.utterance && r.utterance.trim().length > 0))
  const reqDates = memA.recentRequests.map((r) => String(r.at || ''))
  check('诉求按时间倒序', reqDates.every((d, i) => i === 0 || reqDates[i - 1] >= d), reqDates.join(' > '))

  /* ================= 4. 读出的医生结论 ================= */
  section('4. 医生结论（doctor_notes）')
  const notesA = memA.recentDoctorNotes
  check('患者甲读到医生结论', notesA.length > 0, `${notesA.length} 条`)
  check('结论条数不超上限', notesA.length <= MEMORY_LIMITS.notes, `${notesA.length} ≤ ${MEMORY_LIMITS.notes}`)
  check('结论含医生姓名与类型', Boolean(notesA[0]?.doctorName) && Boolean(notesA[0]?.noteType), `${notesA[0]?.doctorName} / ${notesA[0]?.noteType}`)
  check(
    '结论单条已截断',
    notesA.every((n) => n.content.length <= MEMORY_LIMITS.noteChars + 1),
    `上限 ${MEMORY_LIMITS.noteChars}`
  )
  check('结论内容非空', notesA.every((n) => n.content && n.content.trim().length > 0))
  const noteDates = notesA.map((n) => String(n.at || ''))
  check('结论按时间倒序', noteDates.every((d, i) => i === 0 || noteDates[i - 1] >= d), noteDates.join(' > '))
  // 顺带锁住 Step 12 的医生备注口径（用户 2026-09-17 确认：启用 + 计入评分 + 记为随访关注项）。
  // ⚠️ 口径校验必须读**落库全文**：记忆视图里的 content 已按 80 字截断（有界红线），
  //    拿截断后的字符串去比全文会得到假失败。
  const fullNote = (() => {
    const db = new DatabaseSync(TMP_DB, { readOnly: true })
    try {
      return (
        db
          .prepare('SELECT content FROM doctor_notes WHERE patient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
          .get(pidApprove)?.content || ''
      )
    } finally {
      db.close()
    }
  })()
  check('医生备注（落库全文）含「记为随访关注项」', fullNote.includes('记为随访关注项'))
  check('医生备注（落库全文）含「已增加该项监测」', fullNote.includes('增加该项监测'))
  check('医生备注（落库全文）含「计入您的当日健康评分」', fullNote.includes('计入您的当日健康评分'))
  check('医生备注（落库全文）不含 Markdown 星号', !fullNote.includes('**'), fullNote.slice(0, 30))
  check('记忆视图中的备注已按上限截断', notesA[0]?.content.endsWith('…'), `长度 ${notesA[0]?.content.length}`)
  check('患者乙结论转述驳回', String(memB.recentDoctorNotes[0]?.content || '').includes('未获通过'))

  /* ================= 5. 提示词块：防呆 + 只到日期 + 不跨患者 ================= */
  section('5. 提示词块（注入系统提示词的内容）')
  const block = memoryPreamble(memA)
  check('提示词块非空', block.length > 0, `${block.length} 字符`)
  check('块内含「弱记忆」标识', block.includes('弱记忆'))
  check('声明这是历史、不是本次新信息', block.includes('过去') && block.includes('不是**本次新信息'))
  check('声明可能已过期', block.includes('可能已经过期'))
  check('要求当前值必须调工具', block.includes('必须调用工具') && block.includes('不得'))
  check('提示不要逐条复述', block.includes('不要') && block.includes('复述'))
  check('只渲染日期、不渲染时刻（两表时间基不同）', !/\d{4}-\d{2}-\d{2}T/.test(block))
  check('未泄漏任何具体 patient_id（不跨患者）', !/patient_\d+/.test(block))
  check('未出现 undefined / null 占位字样', !/\bundefined\b|\bnull\b/.test(block))
  check('提示词块总长受控（≤1200 字符）', block.length <= 1200, String(block.length))
  check('分段标题齐全', block.includes('患者过往诉求') && block.includes('医生最近结论'))
  check('引用了患者原话', block.includes('我还想每天监测一下血糖'))
  check('带上了审结口径', block.includes('医生已同意'))

  /* ================= 6. 患者不存在：不回落、不串数据 ================= */
  section('6. 患者不存在 → 不回落示范患者')
  let threw = null
  try {
    readPatientMemory('patient_nobody')
  } catch (e) {
    threw = e
  }
  check('readPatientMemory 抛错', Boolean(threw), threw ? threw.code || threw.name : '未抛错')
  check('错误码为 E_PATIENT_NOT_FOUND', threw?.code === 'E_PATIENT_NOT_FOUND', String(threw?.code))
  check('诉求读取不回落（返回空数组）', readRecentRequests('patient_nobody').length === 0)
  let ctxThrew = null
  try {
    await buildAgentContext('patient_nobody')
  } catch (e) {
    ctxThrew = e
  }
  check('buildAgentContext 抛 E_PATIENT_NOT_FOUND', ctxThrew?.code === 'E_PATIENT_NOT_FOUND', String(ctxThrew?.code))

  /* ================= 7. 记忆不参与确定性判定 ================= */
  section('7. 记忆不参与任何确定性判定')
  const ctxA = await buildAgentContext(pidApprove)
  check('上下文里确实挂了 memory', Boolean(ctxA.user?.memory?.hasMemory))
  check(
    '规则引擎入参中没有 memory（判定与记忆无关）',
    !Object.prototype.hasOwnProperty.call(toRulePatient(ctxA), 'memory')
  )
  const ctxEmpty = await buildAgentContext(EMPTY_PATIENT)
  const rpEmpty = toRulePatient(ctxEmpty)
  check(
    '无记忆患者的规则入参结构与有记忆者一致',
    JSON.stringify(Object.keys(rpEmpty).sort()) === JSON.stringify(Object.keys(toRulePatient(ctxA)).sort()),
    Object.keys(rpEmpty).join(',')
  )

  /* ================= 8. 接线检查（静态） ================= */
  section('8. 接线检查（静态）')
  const memCode = stripComments(readFileSync(join(ROOT, 'server', 'data', 'agentMemory.js'), 'utf8'))
  check('agentMemory.js 无任何写操作（无 .run( / INSERT / DELETE）', !memCode.includes('.run(') && !/INSERT\s+INTO|DELETE\s+FROM/i.test(memCode))
  check('agentMemory.js 只用 all() 查询', memCode.includes('all(') && !memCode.includes('openDb('))
  const idxSrc = readFileSync(join(ROOT, 'server', 'index.js'), 'utf8')
  check('index.js 已计算 memoryBlock', idxSrc.includes('memoryPreamble(context.user?.memory)'))
  check(
    'index.js 把 memoryBlock 拼进 system 且空块被丢弃',
    /runtimePreamble\(\), agent\.systemPrompt, memoryBlock, proposalReceiptForPrompt/.test(idxSrc) &&
      idxSrc.includes('.filter(Boolean)')
  )
  check(
    'agentContext.js 已装配 user.memory',
    readFileSync(join(ROOT, 'server', 'data', 'agentContext.js'), 'utf8').includes('user.memory = readPatientMemory(patientId)')
  )
  check('index.js 提示词区分「本轮申请」与「已审结历史」', idxSrc.includes('与弱记忆的分工'))

  /* ================= 9. 端到端：对话链路不被记忆注入打崩 ================= */
  section('9. 端到端对话（带记忆的患者）')
  const chat2 = await sse('/api/agent/chat', {
    agentId: 'companion',
    message: '我们随便聊两句',
    patientId: pidApprove,
  })
  check('带记忆患者对话 200', chat2.status === 200, `HTTP ${chat2.status}`)
  check('对话流正常收尾（chat_done）', chat2.events.some((e) => e.type === 'chat_done'))
  check('无 error 事件', !chat2.events.some((e) => e.type === 'error'), JSON.stringify(chat2.events.find((e) => e.type === 'error') || {}))
  const badChat = await sse('/api/agent/chat', { agentId: 'steward', message: '你好', patientId: 'patient_nobody' })
  check(
    '不存在的患者 → 404 且带 E_PATIENT_NOT_FOUND',
    badChat.status === 404 && badChat.text.includes('E_PATIENT_NOT_FOUND'),
    String(badChat.status)
  )

  /* ================= 10. 纯读：读取前后全库逐表内容一致 ================= */
  section('10. 纯读：读取前后全库逐表内容一致')
  const before = snapshot(TMP_DB)
  readPatientMemory(pidApprove)
  readPatientMemory(pidReject)
  readPatientMemory(EMPTY_PATIENT)
  readRecentRequests(pidApprove)
  await buildAgentContext(pidApprove)
  memoryPreamble(readPatientMemory(pidApprove))
  const after = snapshot(TMP_DB)
  const tableNames = Object.keys(before)
  check('表数量为 22（P0 冻结，未新增表）', tableNames.length === 22, String(tableNames.length))
  const diff = tableNames.filter((t) => before[t] !== after[t])
  check('逐表内容对称差为空（弱记忆零写入）', diff.length === 0, diff.length ? diff.join(',') : '22/22 一致')

  /* ================= 11. 隔离：真实库零改动 ================= */
  section('11. 隔离：真实库零改动')
  const realAfter = snapshot(SRC_DB)
  const realDiff = Object.keys(realBaseline).filter((t) => realBaseline[t] !== realAfter[t])
  check(
    '演示库逐表内容对称差为空',
    realDiff.length === 0,
    realDiff.length ? realDiff.join(',') : `${Object.keys(realBaseline).length}/${Object.keys(realBaseline).length} 一致`
  )
} catch (err) {
  fail++
  lines.push('')
  lines.push(`  ❌ 验收脚本异常：${err.message}`)
  lines.push(String(err.stack || '').split('\n').slice(0, 4).join('\n'))
} finally {
  cleanup()
}

console.log('')
console.log('=== 智能体「弱记忆」验收（Step 13）===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log(`失败 ${fail} 项`)
  process.exit(1)
}
