/**
 * 迈康 MyCare · 验收：智能体「媒介」能力 —— 新增监测项申请（Step 12 语义版）
 * ===========================================================================
 * 用户诉求（2026-09-17 报障）：
 *   「我刚刚明明让医生审核了血糖监测的任务，已经通过了，但是用户的每日任务
 *     并没有显示血糖监测的任务」
 * 用户对修法的明确选择：**「同意即启用并计入评分」**。
 *
 * 被验收的行为：
 *   ① 患者在对话里说「我还想每天监测一下血糖」时，系统必须把它变成一条**待审申请**
 *      推到医生端（而不是只回一句空话，也不能当场在患者端造任务）；
 *   ② 该申请**不伪造参数**（没有「当前值 → 建议值」）；
 *   ③ **医生审结前**，患者端今日任务与评分一个字都不变；
 *   ④ 医生「同意」→ 该监测域**真正启用**：患者端今日任务立即出现该项（addedByDoctor=true），
 *      且该维度**同时计入当日评分的适用维度（分母）** → `tasksUnchanged` 为假；
 *   ⑤ 医生「修改后生效」→ 时段由医生指定；
 *   ⑥ 新增不可越界：白名单外（体重）不生成申请；已派生域不误判为「新增」；
 *   ⑦ 跨版本继承：医生后续调整步数目标时，已启用的血糖监测**不能凭空消失**；
 *   ⑧ 撤销新增 = 该域回落为「未启用」，其余覆盖不受影响；
 *   ⑨ 回归保护：参数类调整（步数降到 3000）仍走覆盖型提案，不被申请型抢走。
 *
 * 运行方式（自起自停，使用**副本库**，真实库零改动）：
 *   node scripts/db/verify-monitor-request.mjs
 * ---------------------------------------------------------------------------
 * 说明：显式把 DEEPSEEK_API_KEY 置空 → 走**本地推理引擎**通道。
 *   提案通道本身与模型可用性**解耦**（确定性通道），因此断言在无 Key 环境下同样可复现。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { ADDABLE_TASK_IDS, OVERRIDE_ERRORS, validateOverridePackage } from '../../src/utils/taskOverride.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const SRC_DB = join(ROOT, 'data', 'mycare-demo.db')
const TMP_DB = join(ROOT, 'data', '_monitor-req-verify.db')
const PORT = 3993
const BASE = `http://127.0.0.1:${PORT}`
const DOCTOR_ID = 'doc_li'

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
  return events
}

/** 只读查询副本库（不经过服务端，用于结构断言） */
function queryDb(sql, ...params) {
  const db = new DatabaseSync(TMP_DB, { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

const taskIdsOf = (json) => (json?.tasks || []).map((t) => t.taskId)
const taskOf = (json, id) => (json?.tasks || []).find((t) => t.taskId === id) || null

/* ---------------------------------------------------------------- *
 * 启动副本实例
 * ---------------------------------------------------------------- */
if (!existsSync(SRC_DB)) {
  console.error(`缺少演示库：${SRC_DB}`)
  process.exit(1)
}
copyFileSync(SRC_DB, TMP_DB)

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
if (!ready) {
  console.error('服务启动失败：\n' + serverOut)
  cleanup()
  process.exit(1)
}

const stamp = String(Date.now()).slice(-6)
const PW = `Monitor${stamp}`
let patientId = null
let patientId2 = null

try {
  /* ================= 1. 注册 + 建档（高血压，无糖尿病） ================= */
  section('1. 注册并建档：主诊断高血压（**无**糖尿病）')
  const reg = await api('/api/patients/register', {
    method: 'POST',
    body: {
      username: `verify_mon_${stamp}`,
      password: PW,
      name: '验收监测申请',
      age: 70,
      gender: 'female',
      height: 158,
      weight: 60,
      phone: '13900004321',
      diseases: ['hypertension'],
    },
  })
  check('注册成功（201）', reg.status === 201, `HTTP ${reg.status}`)
  patientId = reg.json?.patientId
  check('返回 patientId', Boolean(patientId), String(patientId))

  const put = await api(`/api/patients/${patientId}/profile`, {
    method: 'PUT',
    body: {
      identity: { name: '验收监测申请', gender: 'female', age: 70, height: 158, phone: '13900004321' },
      emergencyContact: { name: '王强', relation: '儿子', phone: '13800004321', authorized: false },
      conditions: [
        { diseaseName: '高血压', diseaseGrade: '2 级', durationText: '6 年', riskStratification: '中危', riskBasis: '年龄 + 血脂异常' },
      ],
      lifestyle: {
        diet: '口味偏咸',
        exercise: '每天散步 30 分钟',
        sleep: '约 7 小时',
        biggestDifficulty: '记不住测血压',
        aiStyle: '温和提醒',
      },
      targets: { systolic: 140, diastolic: 90, steps: 9000 },
    },
  })
  check('建档成功（200）', put.status === 200, `HTTP ${put.status}`)

  const dt0 = await api(`/api/patients/${patientId}/daily-tasks`)
  const ids0 = taskIdsOf(dt0.json)
  check('今日任务已按疾病谱派生', ids0.length > 0, ids0.join('/'))
  check('含血压监测任务（主诊断高血压）', ids0.includes('bp_monitor'))
  check('**不含**血糖监测任务（未确诊糖尿病）', !ids0.includes('bg_monitor'), ids0.join('/'))

  // 录一条今日血压（正常范围）→ 让 Rule Score 不为 0，后面才能看出「分母变大→分下降」
  const bpAppend = await api(`/api/patients/${patientId}/readings`, {
    method: 'POST',
    body: { kind: 'blood_pressure', systolic: 130, diastolic: 80, slot: '晨起' },
  })
  check('录入今日血压读数（130/80）', bpAppend.status === 201, `HTTP ${bpAppend.status}`)

  const sc0 = await api(`/api/patients/${patientId}/score`)
  const dims0 = sc0.json?.applicableDimensions || []
  const appW0 = sc0.json?.ruleBreakdown?.reduce((n, d) => n + d.weight, 0)
  const score0 = sc0.json?.rule
  check('基线适用维度 = 步数 / 血压 / 运动', JSON.stringify(dims0) === JSON.stringify(['steps', 'bloodPressure', 'exercise']), dims0.join('/'))
  check('基线**不含**血糖维度（未确诊糖尿病）', !dims0.includes('bloodGlucose'))
  check('基线分母 = 30+25+20 = 75', appW0 === 75, String(appW0))
  check('基线 Rule Score > 0（血压已录入）', Number(score0) > 0, String(score0))

  /* ================= 2. 对话提出「新增血糖监测」 ================= */
  section('2. 对话提出「我还想每天监测一下血糖」→ 必须生成待审申请')
  const UTTERANCE = '我还想每天监测一下血糖，毕竟年纪老了'
  const events = await sse('/api/agent/chat', { agentId: 'planner', message: UTTERANCE, patientId })
  check('SSE 返回了事件流', events.length > 0, `${events.length} 个事件`)

  const proposalEv = events.find((e) => e.type === 'task_proposal')
  check('收到 task_proposal 事件（申请已推送）', Boolean(proposalEv))
  const pItems = proposalEv?.proposals || []
  check('申请条目数为 1', pItems.length === 1, JSON.stringify(pItems.map((p) => p.taskId)))
  check('类型为 monitor_request', pItems[0]?.type === 'monitor_request', String(pItems[0]?.type))
  check('申请对象为血糖监测', pItems[0]?.taskId === 'bg_monitor', String(pItems[0]?.taskId))
  check('不伪造「建议值」（申请型不携带目标值）', pItems[0]?.proposedValue === null, JSON.stringify(pItems[0]?.proposedValue))
  check('不伪造「当前值」', pItems[0]?.currentValue === null, JSON.stringify(pItems[0]?.currentValue))

  /* ================= 3. 落库结构 ================= */
  section('3. 提案行落库结构（is_active = 0，天然不参与覆盖读取）')
  const rows = queryDb(
    "SELECT prescription_id, is_active, doctor_modified, created_by, target_goals FROM prescriptions WHERE patient_id = ? AND target_goals LIKE '%task_proposal%'",
    patientId
  )
  check('库中出现 1 条提案行', rows.length === 1, `${rows.length} 行`)
  const pkg = rows[0] ? JSON.parse(rows[0].target_goals) : {}
  check('提案行 is_active = 0', Number(rows[0]?.is_active) === 0, String(rows[0]?.is_active))
  check('提案行 doctor_modified = 0（未审结）', Number(rows[0]?.doctor_modified) === 0)
  check('created_by = agent', rows[0]?.created_by === 'agent')
  check('kind = task_proposal', pkg.kind === 'task_proposal', String(pkg.kind))
  check('status = pending_review', pkg.status === 'pending_review', String(pkg.status))
  check('条目 type = monitor_request', pkg.proposals?.[0]?.type === 'monitor_request')
  check('保留患者原话作为依据', String(pkg.utterance || '').includes('血糖'), String(pkg.utterance || '').slice(0, 40))

  /* ================= 4. 医生端可见 ================= */
  section('4. 医生端待审列表可见（注册用户即便未授权也要能认出）')
  const pend = await api(`/api/doctors/${DOCTOR_ID}/task-proposals?status=pending`)
  const mine = (pend.json?.proposals || []).find((p) => p.patientId === patientId)
  check('待审列表含该申请', Boolean(mine))
  check('条目带患者姓名', mine?.patientName === '验收监测申请', String(mine?.patientName))
  check('条目带授权状态字段（未授权 → false）', mine?.patientAuthorized === false, String(mine?.patientAuthorized))
  check('医生端能读到「申请新增」类型', mine?.proposals?.[0]?.type === 'monitor_request')
  const dtDoc = await api(`/api/doctors/${DOCTOR_ID}/patients/${patientId}/tasks`)
  const addable = dtDoc.json?.overrideContract?.addableMonitorTasks
  check(
    '医生端契约下发可启用监测域白名单',
    JSON.stringify(Object.keys(addable || {})) === JSON.stringify(ADDABLE_TASK_IDS),
    Object.keys(addable || {}).join('/')
  )

  /* ================= 5. 医生审结**之前**：患者端零变化 ================= */
  section('5. 医生审结前：任务与评分都一个字不变')
  const dtBefore = await api(`/api/patients/${patientId}/daily-tasks`)
  const idsBefore = taskIdsOf(dtBefore.json)
  check('审核前仍无血糖监测任务', !idsBefore.includes('bg_monitor'), idsBefore.join('/'))
  check('审核前无生效覆盖包', dtBefore.json?.overridePackage == null, JSON.stringify(dtBefore.json?.overridePackage))
  const scBefore = await api(`/api/patients/${patientId}/score`)
  check(
    '审核前评分适用维度不含血糖',
    !(scBefore.json?.applicableDimensions || []).includes('bloodGlucose'),
    (scBefore.json?.applicableDimensions || []).join('/')
  )
  check('审核前 Rule Score 与基线一致', scBefore.json?.rule === score0, `${score0} → ${scBefore.json?.rule}`)

  /* ================= 6. 医生同意 → 真正启用并计入评分 ================= */
  section('6. 医生「同意」→ 该监测域真正启用（新增任务 + 计入评分分母）')
  const review = await api(`/api/doctors/${DOCTOR_ID}/task-proposals/${mine?.proposalId}/review`, {
    method: 'POST',
    body: { decision: 'approve' },
  })
  check('审结成功（200）', review.status === 200, `HTTP ${review.status}`)
  check('明确返回 tasksUnchanged = false（患者端任务确实变了）', review.json?.tasksUnchanged === false, String(review.json?.tasksUnchanged))
  check('明确返回 requiresFollowUp = false（不再是「仅记为随访项」）', review.json?.requiresFollowUp === false, String(review.json?.requiresFollowUp))
  check('返回被启用的监测项 = bg_monitor', review.json?.addedTasks?.[0]?.taskId === 'bg_monitor', JSON.stringify(review.json?.addedTasks))
  check('已写入生效覆盖包（resultingPrescriptionId 非空）', Boolean(review.json?.resultingPrescriptionId), String(review.json?.resultingPrescriptionId))

  const dtAfter = await api(`/api/patients/${patientId}/daily-tasks`)
  const idsAfter = taskIdsOf(dtAfter.json)
  const bgTask = taskOf(dtAfter.json, 'bg_monitor')
  check('★ 审结后患者端**出现**血糖监测任务', idsAfter.includes('bg_monitor'), idsAfter.join('/'))
  check('该任务标记为「医生新增」（addedByDoctor）', bgTask?.addedByDoctor === true, String(bgTask?.addedByDoctor))
  check('任务来源仍是确定性规则（source = rule，非 AI 自造）', bgTask?.source === 'rule', String(bgTask?.source))
  check('任务默认时段 = 空腹 / 餐后2h（规则库默认值）', JSON.stringify(bgTask?.slots?.map((s) => s.slot)) === JSON.stringify(['空腹', '餐后2h']), JSON.stringify(bgTask?.slots?.map((s) => s.slot)))
  check('任务频次 = 时段数 = 2', bgTask?.target === 2, String(bgTask?.target))
  check('任务说明含「医生审结同意新增」', String(bgTask?.reason || '').includes('医生审结同意新增'), String(bgTask?.reason || '').slice(0, 40))
  check('原任务集合未丢失（血压监测仍在）', idsAfter.includes('bp_monitor'))
  check('覆盖包 addedTasks 已落库', (dtAfter.json?.overridePackage?.addedTasks || []).some((a) => a.taskId === 'bg_monitor'))
  check('覆盖包归一化视图不含 kind（结构由库里 JSON 判别）', dtAfter.json?.overridePackage?.kind === undefined)

  const scAfter = await api(`/api/patients/${patientId}/score`)
  const dimsAfter = scAfter.json?.applicableDimensions || []
  const bd = scAfter.json?.ruleBreakdown || []
  const appWAfter = bd.reduce((n, d) => n + d.weight, 0)
  const bgDim = bd.find((d) => d.key === 'bloodGlucose')
  check('★ 评分适用维度**新增** bloodGlucose', dimsAfter.includes('bloodGlucose'), dimsAfter.join('/'))
  check('★ 评分分母 75 → 100（血糖维度 25 分计入）', appWAfter === 100, String(appWAfter))
  check('血糖维度来源标记为 doctorOrder', bgDim?.source === 'doctorOrder', String(bgDim?.source))
  check('血糖维度状态为 missing（今日未测）', bgDim?.status === 'missing', String(bgDim?.status))
  check('血糖维度说明区分「医生已要求监测」', String(bgDim?.detail || '').includes('医生已要求监测'), String(bgDim?.detail || ''))
  check(
    '★ 同一份数据下分数下降（分母变大，未测项被如实扣分）',
    Number(scAfter.json?.rule) < Number(score0),
    `${score0} → ${scAfter.json?.rule}`
  )

  const rowsAfter = queryDb('SELECT prescription_id, is_active, doctor_modified, created_by, target_goals FROM prescriptions WHERE patient_id = ?', patientId)
  const proposalRow = rowsAfter.find((r) => String(r.target_goals).includes('task_proposal'))
  const activeRows = rowsAfter.filter((r) => String(r.target_goals).includes('task_override_package'))
  check('提案行 is_active 仍为 0（申请行不参与覆盖读取）', Number(proposalRow?.is_active) === 0, String(proposalRow?.is_active))
  check('提案行 doctor_modified = 1（已审结）', Number(proposalRow?.doctor_modified) === 1)
  check('已写入 1 条生效覆盖包行（is_active = 1）', activeRows.length === 1 && Number(activeRows[0].is_active) === 1, `${activeRows.length} 行`)
  check('生效覆盖包行的 kind = task_override_package', String(activeRows[0]?.target_goals || '').includes('"kind":"task_override_package"'))
  check('生效覆盖包行 created_by = doctor（唯一写库出口）', activeRows[0]?.created_by === 'doctor', String(activeRows[0]?.created_by))
  check('提案行记录了它产生的覆盖包 id', Boolean(JSON.parse(proposalRow?.target_goals || '{}').resultingPrescriptionId))

  const pendAfter = await api(`/api/doctors/${DOCTOR_ID}/task-proposals?status=pending`)
  check('已审结后不再出现在待审列表', !(pendAfter.json?.proposals || []).some((p) => p.patientId === patientId))

  const reviewed = await api(`/api/doctors/${DOCTOR_ID}/task-proposals?status=reviewed`)
  const reviewedMine = (reviewed.json?.proposals || []).find((p) => p.patientId === patientId)
  check('已审结列表状态为 approved', reviewedMine?.status === 'approved', String(reviewedMine?.status))

  const notes = await api(`/api/patients/${patientId}/doctor-notes?limit=20`)
  const noteHit = (notes.json?.notes || []).find((n) => String(n.content || '').includes('血糖'))
  check('已写一条含「血糖」的医生回执', Boolean(noteHit), String(noteHit?.content || '').slice(0, 50))
  check('回执明确告知「已计入当日健康评分」', String(noteHit?.content || '').includes('计入'), String(noteHit?.content || '').slice(0, 60))

  /* ================= 7. 对称场景：糖尿病患者申请**血压**监测，医生改时段 ================= */
  section('7. 对称场景：糖尿病（已有血糖任务）申请新增血压监测 → 医生「修改后生效」')
  const reg2 = await api('/api/patients/register', {
    method: 'POST',
    body: {
      username: `verify_mon2_${stamp}`,
      password: PW,
      name: '验收监测申请乙',
      age: 68,
      gender: 'male',
      height: 170,
      weight: 72,
      phone: '13900004322',
      diseases: ['diabetes'],
    },
  })
  patientId2 = reg2.json?.patientId
  check('第二个患者注册成功（主诊断糖尿病）', reg2.status === 201 && Boolean(patientId2), `${reg2.status}/${patientId2}`)
  const put2 = await api(`/api/patients/${patientId2}/profile`, {
    method: 'PUT',
    body: {
      identity: { name: '验收监测申请乙', gender: 'male', age: 68, height: 170, phone: '13900004322' },
      emergencyContact: { name: '李梅', relation: '女儿', phone: '13800004322', authorized: false },
      conditions: [{ diseaseName: '糖尿病', diseaseGrade: '2 型', durationText: '8 年', riskStratification: '中危', riskBasis: '病程 + 年龄' }],
      lifestyle: { diet: '控制主食', exercise: '每周游泳两次', sleep: '约 6.5 小时', biggestDifficulty: '手指疼不爱扎', aiStyle: '直接说明' },
      targets: { systolic: 130, diastolic: 80, fastingGlucose: 7, steps: 8000 },
    },
  })
  check('第二个患者建档成功', put2.status === 200, `HTTP ${put2.status}`)

  const dtB0 = await api(`/api/patients/${patientId2}/daily-tasks`)
  const idsB0 = taskIdsOf(dtB0.json)
  check('糖尿病主诊断 → 已有血糖监测任务', idsB0.includes('bg_monitor'), idsB0.join('/'))
  check('未确诊高血压 → **无**血压监测任务', !idsB0.includes('bp_monitor'), idsB0.join('/'))

  const evB = await sse('/api/agent/chat', { agentId: 'planner', message: '我还想每天量一下血压，家里有血压计', patientId: patientId2 })
  const evBp = evB.find((e) => e.type === 'task_proposal')
  const itB = evBp?.proposals?.[0]
  check('生成血压新增申请', itB?.type === 'monitor_request' && itB?.taskId === 'bp_monitor', `${itB?.type}/${itB?.taskId}`)

  const pendB = await api(`/api/doctors/${DOCTOR_ID}/task-proposals?status=pending`)
  const mineB = (pendB.json?.proposals || []).find((p) => p.patientId === patientId2)
  check('医生端可见该申请', Boolean(mineB))

  const revB = await api(`/api/doctors/${DOCTOR_ID}/task-proposals/${mineB?.proposalId}/review`, {
    method: 'POST',
    body: { decision: 'modify', overrides: { bp_monitor: { slots: ['晨起', '下午', '睡前'] } }, reason: '同意，但要求覆盖晨起与睡前，并加测下午' },
  })
  check('「修改后生效」成功（200）', revB.status === 200, `HTTP ${revB.status}`)
  check('生效时段 = 医生指定的 3 个', JSON.stringify(revB.json?.addedTasks?.[0]?.slots) === JSON.stringify(['晨起', '下午', '睡前']), JSON.stringify(revB.json?.addedTasks?.[0]?.slots))
  check('tasksUnchanged = false', revB.json?.tasksUnchanged === false)

  const dtB1 = await api(`/api/patients/${patientId2}/daily-tasks`)
  const bpTask = taskOf(dtB1.json, 'bp_monitor')
  check('★ 患者端出现血压监测任务', Boolean(bpTask), taskIdsOf(dtB1.json).join('/'))
  check('时段 = 医生指定的 3 个', JSON.stringify(bpTask?.slots?.map((s) => s.slot)) === JSON.stringify(['晨起', '下午', '睡前']), JSON.stringify(bpTask?.slots?.map((s) => s.slot)))
  check('频次 = 3', bpTask?.target === 3, String(bpTask?.target))
  check('原有的血糖任务未受影响', taskIdsOf(dtB1.json).includes('bg_monitor'))
  check('回执记录了「医生调整时段后生效」', String(JSON.parse(queryDb("SELECT target_goals FROM prescriptions WHERE patient_id = ? AND target_goals LIKE '%task_proposal%'", patientId2)[0]?.target_goals || '{}').reviewReason || '').includes('医生调整时段后生效'))

  /* ================= 8. 跨版本继承：调整步数不得挤掉已启用的监测项 ================= */
  section('8. 跨版本继承：医生后续调整步数 → 已启用的血糖监测不能消失')
  const evSteps = await sse('/api/agent/chat', { agentId: 'planner', message: '步子迈不动了，步数降到3000吧', patientId })
  const itSteps = evSteps.find((e) => e.type === 'task_proposal')?.proposals?.[0]
  check('参数类诉求仍产出提案（未被申请型抢走）', Boolean(itSteps), JSON.stringify(itSteps || null))
  check('类型为 override（非 monitor_request）', itSteps?.type === 'override', String(itSteps?.type))
  check('taskId = steps 且目标 = 3000', itSteps?.taskId === 'steps' && itSteps?.proposedValue === 3000, `${itSteps?.taskId}/${itSteps?.proposedValue}`)

  const pendS = await api(`/api/doctors/${DOCTOR_ID}/task-proposals?status=pending`)
  const mineS = (pendS.json?.proposals || []).find((p) => p.patientId === patientId && p.proposals?.[0]?.taskId === 'steps')
  const revS = await api(`/api/doctors/${DOCTOR_ID}/task-proposals/${mineS?.proposalId}/review`, {
    method: 'POST',
    body: { decision: 'approve' },
  })
  check('步数提案审结成功', revS.status === 200, `HTTP ${revS.status}`)

  const dtAfterSteps = await api(`/api/patients/${patientId}/daily-tasks`)
  check('步数目标已生效为 3000', taskOf(dtAfterSteps.json, 'steps')?.target === 3000, String(taskOf(dtAfterSteps.json, 'steps')?.target))
  check('★ 血糖监测任务被**继承**保留（医生新增项不丢）', taskIdsOf(dtAfterSteps.json).includes('bg_monitor'), taskIdsOf(dtAfterSteps.json).join('/'))
  check(
    '覆盖包同时含参数覆盖与新增监测域',
    Object.keys(dtAfterSteps.json?.overridePackage?.overrides || {}).includes('steps') &&
      (dtAfterSteps.json?.overridePackage?.addedTasks || []).some((a) => a.taskId === 'bg_monitor'),
    JSON.stringify(Object.keys(dtAfterSteps.json?.overridePackage?.overrides || {}))
  )

  /* ================= 9. 撤销「新增」= 该域回落未启用，其余覆盖保留 ================= */
  section('9. 医生撤销「新增血糖监测」→ 回落未启用，步数覆盖不受影响')
  const revoke = await api(`/api/doctors/${DOCTOR_ID}/patients/${patientId}/task-overrides/bg_monitor`, { method: 'DELETE' })
  check('撤销成功（200）', revoke.status === 200, `HTTP ${revoke.status}`)
  const dtAfterRevoke = await api(`/api/patients/${patientId}/daily-tasks`)
  const idsRevoked = taskIdsOf(dtAfterRevoke.json)
  check('★ 血糖监测任务已从今日任务消失', !idsRevoked.includes('bg_monitor'), idsRevoked.join('/'))
  check('步数覆盖仍然生效（3000）', taskOf(dtAfterRevoke.json, 'steps')?.target === 3000, String(taskOf(dtAfterRevoke.json, 'steps')?.target))
  const scRevoked = await api(`/api/patients/${patientId}/score`)
  const dimsRevoked = scRevoked.json?.applicableDimensions || []
  check('★ 评分适用维度回落（不含血糖）', !dimsRevoked.includes('bloodGlucose'), dimsRevoked.join('/'))
  check('评分分母回落到 75', (scRevoked.json?.ruleBreakdown || []).reduce((n, d) => n + d.weight, 0) === 75)
  check('Rule Score 回到基线值', scRevoked.json?.rule === score0, `${score0} → ${scRevoked.json?.rule}`)

  /* ================= 10. 反向保护 ================= */
  section('10. 反向保护：已派生域不误判为「新增」；白名单外域不生成申请')
  const diabetic = queryDb(
    "SELECT patient_id FROM patient_conditions WHERE disease_name LIKE '%糖尿病%' AND is_primary = 1 LIMIT 1"
  )[0]?.patient_id
  if (diabetic) {
    const dtD = await api(`/api/patients/${diabetic}/daily-tasks`)
    const hasBg = taskIdsOf(dtD.json).includes('bg_monitor')
    check(`糖尿病示范病例 ${diabetic} 已有血糖任务`, hasBg, taskIdsOf(dtD.json).join('/'))
    const evD = await sse('/api/agent/chat', {
      agentId: 'planner',
      message: '我想每天监测一下血糖',
      patientId: diabetic,
    })
    const items = evD.find((e) => e.type === 'task_proposal')?.proposals || []
    check(
      '已生成血糖任务时不产出 monitor_request',
      !items.some((p) => p.type === 'monitor_request'),
      JSON.stringify(items.map((p) => `${p.type}:${p.taskId}`))
    )
  } else {
    check('找到一个糖尿病示范病例（前置条件）', false, '未找到，本段跳过')
  }

  // 白名单之外（体重）→ 不生成申请单，避免推一张医生无法处理的单子
  const evW = await sse('/api/agent/chat', { agentId: 'planner', message: '我还想每天称一下体重', patientId })
  const itemsW = evW.find((e) => e.type === 'task_proposal')?.proposals || []
  check(
    '白名单外的监测域（体重）不产出 monitor_request',
    !itemsW.some((p) => p.type === 'monitor_request'),
    JSON.stringify(itemsW.map((p) => `${p.type}:${p.taskId}`))
  )
  const dtW = await api(`/api/patients/${patientId}/daily-tasks`)
  check('患者端未凭空多出体重记录任务', !taskIdsOf(dtW.json).includes('weight_record'), taskIdsOf(dtW.json).join('/'))

  /* ================= 11. 契约层单元断言（直接调用同一把尺子） ================= */
  section('11. 契约层：addedTasks 白名单与错误码（确定性纯函数）')
  const CTX = { generatedTaskIds: ['bp_monitor', 'steps', 'exercise'], primaryDisease: '高血压', diseases: ['高血压'] }
  const BASIS = '医生审结同意新增监测项'

  const okCase = validateOverridePackage({ overrides: {}, addedTasks: [{ taskId: 'bg_monitor' }], basis: BASIS }, CTX)
  check('合法新增（仅 addedTasks、overrides 为空）通过', okCase.ok === true, okCase.code || '')
  check('自动补齐规则库默认时段', JSON.stringify(okCase.normalized?.addedTasks?.[0]?.slots) === JSON.stringify(['空腹', '餐后2h']), JSON.stringify(okCase.normalized?.addedTasks?.[0]?.slots))
  check('归一化只保留白名单字段（domain/title/unit/ruleId/slots）', JSON.stringify(Object.keys(okCase.normalized?.addedTasks?.[0] || {}).sort()) === JSON.stringify(['domain', 'ruleId', 'slots', 'taskId', 'title', 'unit']), JSON.stringify(Object.keys(okCase.normalized?.addedTasks?.[0] || {})))

  const unknownCase = validateOverridePackage({ overrides: {}, addedTasks: [{ taskId: 'weight_record' }], basis: BASIS }, CTX)
  check('白名单外的域被拒（E_ADDED_TASK_UNKNOWN）', unknownCase.errors?.[0]?.code === OVERRIDE_ERRORS.E_ADDED_TASK_UNKNOWN, String(unknownCase.errors?.[0]?.code))

  const dupCase = validateOverridePackage({ overrides: {}, addedTasks: [{ taskId: 'bg_monitor' }, { taskId: 'bg_monitor' }], basis: BASIS }, CTX)
  check('重复项被拒（E_ADDED_TASK_DUPLICATE）', dupCase.errors?.[0]?.code === OVERRIDE_ERRORS.E_ADDED_TASK_DUPLICATE, String(dupCase.errors?.[0]?.code))

  const alreadyCase = validateOverridePackage({ overrides: {}, addedTasks: [{ taskId: 'bp_monitor' }], basis: BASIS }, CTX)
  check('已派生域被拒（E_ADDED_TASK_ALREADY_GENERATED）', alreadyCase.errors?.[0]?.code === OVERRIDE_ERRORS.E_ADDED_TASK_ALREADY_GENERATED, String(alreadyCase.errors?.[0]?.code))

  const slotCase = validateOverridePackage({ overrides: {}, addedTasks: [{ taskId: 'bg_monitor', slots: ['半夜'] }], basis: BASIS }, CTX)
  check('非法时段被拒（E_ADDED_TASK_SLOTS_INVALID）', slotCase.errors?.[0]?.code === OVERRIDE_ERRORS.E_ADDED_TASK_SLOTS_INVALID, String(slotCase.errors?.[0]?.code))

  const emptyCase = validateOverridePackage({ overrides: {}, basis: BASIS }, CTX)
  check('两者都空仍被拒（E_OVERRIDES_EMPTY）', emptyCase.ok === false && emptyCase.code === OVERRIDE_ERRORS.E_OVERRIDES_EMPTY, String(emptyCase.code))

  const nonArrayCase = validateOverridePackage({ overrides: {}, addedTasks: 'bg_monitor', basis: BASIS }, CTX)
  check('addedTasks 非数组被拒（E_ADDED_TASKS_INVALID）', nonArrayCase.errors?.[0]?.code === OVERRIDE_ERRORS.E_ADDED_TASKS_INVALID, String(nonArrayCase.errors?.[0]?.code))

  check('白名单恰好为 bp_monitor / bg_monitor（不得自造任务域）', JSON.stringify(ADDABLE_TASK_IDS) === JSON.stringify(['bp_monitor', 'bg_monitor']), ADDABLE_TASK_IDS.join('/'))

  /* ================= 12. 隔离：写入全部落在副本库 ================= */
  section('12. 隔离：真实库零改动')
  check('副本库文件存在且被写入', existsSync(TMP_DB))
  const realRows = (() => {
    const db = new DatabaseSync(SRC_DB, { readOnly: true })
    try {
      return db.prepare('SELECT COUNT(*) n FROM prescriptions WHERE patient_id IN (?, ?)').get(patientId, patientId2).n
    } finally {
      db.close()
    }
  })()
  check('演示库中不存在该验收患者（写入未串库）', realRows === 0, String(realRows))
} catch (err) {
  fail++
  lines.push('')
  lines.push(`  ❌ 验收脚本异常：${err.message}`)
  lines.push(String(err.stack || '').split('\n').slice(0, 4).join('\n'))
} finally {
  cleanup()
}

console.log('')
console.log('=== 智能体「新增监测项申请」验收（Step 12 语义）===')
console.log(lines.join('\n'))
console.log('')
console.log(`通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log(`失败 ${fail} 项`)
  process.exit(1)
}
