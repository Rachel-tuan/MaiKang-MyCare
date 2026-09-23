/**
 * 迈康 MyCare · 验收：注册用户「从 0 到 1」完整闭环（2026-09-17 新增）
 * ===========================================================================
 * 被验收的行为改变（用户诉求：示范病例能做的，注册用户也必须能做）：
 *   ① 注册后可以**完善健康档案**（紧急联系人 / 疾病分级与危险分层 / 生活画像 /
 *      控制目标 / 用药计划），补齐后医生端「患者详情」与示范病例同构；
 *   ② 档案补全**不新建表**、`patient_targets` **不产生第二行**（避免排序歧义）；
 *   ③ 注册用户的智能体对话**同样产出待审提案**，医生端待审能看到患者姓名；
 *   ④ 医生审结后患者端今日任务**真实变化**；
 *   ⑤ 「个性化健康建议」由**六个智能体协同**产出（run_done.carePlan）。
 *
 * 运行方式（自起自停，使用**副本库**，真实库零改动）：
 *   node scripts/db/verify-new-user-flow.mjs
 * ---------------------------------------------------------------------------
 * 说明：本脚本显式把 DEEPSEEK_API_KEY 置空 → 走**本地推理引擎（mock）**通道，
 *   目的是让「六智能体协同链路」的断言在无网络 / 无额度的环境下也**确定可复现**。
 *   真实模型通道另由 ai-score 等验收覆盖。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const SRC_DB = join(ROOT, 'data', 'mycare-demo.db')
const TMP_DB = join(ROOT, 'data', '_newuser-verify.db')
const PORT = 3994
const BASE = `http://127.0.0.1:${PORT}`

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
    // 强制走本地推理引擎，使六智能体协同断言确定可复现
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

const PW = ['v', 'erify', String(Date.now()).slice(-6)].join('')
let patientId = null

try {
  /* ================= 1. 注册 ================= */
  section('1. 自助注册（最小身份信息）')
  const reg = await api('/api/patients/register', {
    method: 'POST',
    body: {
      username: 'verify_new_' + String(Date.now()).slice(-6),
      password: PW,
      name: '验收新用户',
      age: 68,
      gender: 'male',
      height: 170,
      weight: 82,
      phone: '13900001234',
      diseases: ['hypertension'],
    },
  })
  check('注册成功（201）', reg.status === 201, `HTTP ${reg.status}`)
  patientId = reg.json?.patientId
  check('返回 patientId', Boolean(patientId), String(patientId))

  const p0 = await api(`/api/patients/${patientId}/profile`)
  check('注册后档案可读', p0.status === 200, `HTTP ${p0.status}`)
  check('注册后紧急联系人为空', (p0.json?.profile?.contacts || []).length === 0)
  check(
    '注册后生活画像为空',
    !p0.json?.profile?.lifestyle?.diet && !p0.json?.profile?.lifestyle?.exercise
  )
  check('注册后控制目标为 null（patient_targets 无行）', p0.json?.profile?.targets === null)

  /* ================= 2. 完善档案 ================= */
  section('2. 完善健康档案（六类一次提交）')
  const put = await api(`/api/patients/${patientId}/profile`, {
    method: 'PUT',
    body: {
      identity: { name: '验收新用户', gender: 'male', age: 68, height: 170, phone: '13900001234', occupation: '退休教师' },
      emergencyContact: { name: '李华', relation: '女儿', phone: '13800001234', authorized: true },
      conditions: [
        { diseaseName: '高血压', diseaseGrade: '2 级', durationText: '8 年', riskStratification: '中危', riskBasis: '合并 2 项危险因素' },
        { diseaseName: '高血脂', durationText: '3 年' },
      ],
      lifestyle: {
        diet: '口味偏咸，日均食盐约 10 g，爱吃腌菜',
        exercise: '偶尔散步，无固定运动习惯',
        sleep: '入睡偏晚，日均约 6 小时',
        biggestDifficulty: '担心血压控制不住',
        motivation: '怕给子女添麻烦',
        aiStyle: '安抚 + 警示',
      },
      targets: { systolic: 140, diastolic: 90, bmi: 28, steps: 8000 },
      medications: [{ name: '氨氯地平', dosage: '5mg', frequency: '每日一次', time: '08:00' }],
    },
  })
  check('档案保存成功（200）', put.status === 200, `HTTP ${put.status}`)
  const applied = put.json?.applied || []
  check(
    '六类档案全部写入',
    ['patients', 'patient_contacts', 'patient_conditions', 'patient_lifestyle', 'patient_targets', 'medications'].every((t) =>
      applied.includes(t)
    ),
    applied.join('/')
  )

  const p1 = await api(`/api/patients/${patientId}/profile`)
  const prof = p1.json?.profile || {}
  const view = p1.json?.view || {}
  check('紧急联系人已落库', (prof.contacts || [])[0]?.name === '李华', JSON.stringify((prof.contacts || [])[0] || null))
  check('联系人关系与电话已落库', (prof.contacts || [])[0]?.relation === '女儿' && (prof.contacts || [])[0]?.phone === '13800001234')
  check('紧急联系人外发授权为真', (prof.contacts || [])[0]?.authorized === true)
  check(
    '疾病分级 / 病程 / 危险分层已落库',
    (prof.conditions || [])[0]?.diseaseGrade === '2 级' &&
      (prof.conditions || [])[0]?.durationText === '8 年' &&
      (prof.conditions || [])[0]?.riskStratification === '中危'
  )
  check('主诊断唯一（仅第一项 is_primary）', (prof.conditions || [])[0]?.isPrimary === true)
  check('次诊断已落库且非主诊断', (prof.conditions || []).some((c) => c.diseaseName === '高血脂' && c.isPrimary === false))
  check('生活画像饮食已落库', Boolean(prof.lifestyle?.diet))
  check('生活画像最大困难 / 沟通风格已落库', prof.lifestyle?.biggestDifficulty === '担心血压控制不住' && prof.lifestyle?.aiStyle === '安抚 + 警示')
  check(
    '控制目标已落库',
    prof.targets?.systolicTarget === 140 && prof.targets?.diastolicTarget === 90 && prof.targets?.stepsTarget === 8000
  )
  check('用药计划已落库', (prof.medications || [])[0]?.name === '氨氯地平')
  check('档案视图 medical 已带上分级与危险分层', view.medical?.diseaseGrade === '2 级' && view.medical?.riskStratification === '中危')
  check('档案视图带上控制目标文案（basis JSON 可解析）', Boolean(view.medical?.controlTarget), String(view.medical?.controlTarget || ''))

  /* ---- 不变量：patient_targets 只有一行；再次保存不新增 ---- */
  const t1 = queryDb('SELECT target_id, basis FROM patient_targets WHERE patient_id = ?', patientId)
  check('patient_targets 恰好 1 行（未产生排序歧义）', t1.length === 1, `rows=${t1.length}`)
  const basisBefore = t1[0]?.basis

  await api(`/api/patients/${patientId}/profile`, {
    method: 'PUT',
    body: { targets: { systolic: 135, steps: 9000 } },
  })
  const t2 = queryDb('SELECT target_id, basis, systolic_target, steps_target FROM patient_targets WHERE patient_id = ?', patientId)
  check('二次保存后仍为 1 行（UPDATE 而非 INSERT）', t2.length === 1, `rows=${t2.length}`)
  check('目标值已更新', t2[0]?.systolic_target === 135 && t2[0]?.steps_target === 9000, JSON.stringify(t2[0]))
  check('既有行的 basis 未被改写（登录页 JSON 契约不变）', t2[0]?.basis === basisBefore)

  const tables = queryDb("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  check('表数仍为 22（未新建任何表）', tables.length === 22, `tables=${tables.length}`)

  const badPut = await api('/api/patients/patient_does_not_exist/profile', {
    method: 'PUT',
    body: { identity: { name: 'X' } },
  })
  check('未知患者 → 404 E_PATIENT_NOT_FOUND', badPut.status === 404 && badPut.json?.code === 'E_PATIENT_NOT_FOUND', `HTTP ${badPut.status}`)

  const badHeight = await api(`/api/patients/${patientId}/profile`, { method: 'PUT', body: { identity: { height: 999 } } })
  check('非法身高 → 400（不静默接受）', badHeight.status === 400, `HTTP ${badHeight.status}`)

  /* ================= 3. 授权 → 医生端可见 ================= */
  section('3. 隐私授权 → 医生端可见完整档案')
  const beforeAuth = await api('/api/doctors/doc_li/patients')
  check('未授权时医生端看不到该患者', !(beforeAuth.json?.patients || []).some((p) => p.id === patientId))

  const grant = await api(`/api/patients/${patientId}/care-team/doc_li`, { method: 'POST', body: { granted: true } })
  check('授权成功', grant.status === 200, `HTTP ${grant.status}`)

  const afterAuth = await api('/api/doctors/doc_li/patients')
  const me = (afterAuth.json?.patients || []).find((p) => p.id === patientId)
  check('授权后医生端可见', Boolean(me))
  check('医生端能看到紧急联系人（脱敏）', String(me?.emergencyContact || '').includes('李华'), String(me?.emergencyContact || ''))
  check('医生端能看到手机号（脱敏）', String(me?.phone || '').startsWith('139'), String(me?.phone || ''))
  check('医生端能看到疾病谱', (me?.diseases || []).includes('高血压'), JSON.stringify(me?.diseases || []))
  check('医生端患者 cards 携带最新数据字段', me?.recentData && typeof me.recentData === 'object')

  /* ================= 4. 智能体对话 → 提案 ================= */
  section('4. 注册用户的智能体对话 → 任务调整提案')
  const dt0 = await api(`/api/patients/${patientId}/daily-tasks`)
  const taskIds0 = (dt0.json?.tasks || []).map((t) => t.taskId)
  check('注册用户可派生今日任务', taskIds0.length > 0, taskIds0.join('/'))
  check('主诊断高血压 → 生成血压监测任务', taskIds0.includes('bp_monitor'), taskIds0.join('/'))

  const chatEvents = await sse('/api/agent/chat', {
    patientId,
    agentId: 'planner',
    message: '我膝盖疼走不了那么多步，步数降到3000吧；另外血压改成晨起和睡前测',
  })
  const proposalEv = chatEvents.find((e) => e.type === 'task_proposal')
  check('对话产出了 task_proposal 事件', Boolean(proposalEv))
  const props = proposalEv?.proposals || []
  check('包含步数目标调整提案', props.some((p) => p.taskId === 'steps'), JSON.stringify(props.map((p) => `${p.taskId}.${p.field}`)))
  check('包含血压时段调整提案', props.some((p) => p.taskId === 'bp_monitor' && p.field === 'slots'))

  const pending = await api('/api/doctors/doc_li/task-proposals?status=pending')
  // 同一轮最多 2 条提案 → 每条独立成行，这里取该患者的**全部**提案
  const mineAll = (pending.json?.proposals || []).filter((p) => p.patientId === patientId)
  check('医生端待审列表含该提案', mineAll.length > 0, `count=${mineAll.length}`)
  check('待审条目带患者姓名（患者未授权也能认出申请人）', mineAll[0]?.patientName === '验收新用户', String(mineAll[0]?.patientName || ''))
  check('待审条目带授权状态字段', typeof mineAll[0]?.patientAuthorized === 'boolean', String(mineAll[0]?.patientAuthorized))

  /* ================= 5. 医生审结 → 患者端任务变化 ================= */
  section('5. 医生审结 → 患者端今日任务真实变化（审核前不变）')
  const stepsProposalRow = mineAll.find((p) => (p.proposals || []).some((i) => i.taskId === 'steps'))
  if (stepsProposalRow) {
    const dtBefore = await api(`/api/patients/${patientId}/daily-tasks`)
    const stepsBefore = (dtBefore.json?.tasks || []).find((t) => t.taskId === 'steps')
    const targetBefore = stepsBefore?.target
    check('审核前患者端步数目标未被提案影响（仍为档案里的 9000）', targetBefore === 9000, String(targetBefore))

    // 审核前：患者端任务不变（提案行 is_active = 0 天然不参与覆盖读取）
    const proposeRow = queryDb(
      "SELECT is_active, doctor_modified FROM prescriptions WHERE patient_id = ? AND target_goals LIKE '%task_proposal%'",
      patientId
    )
    check('提案行 is_active = 0（未审结前不参与覆盖读取）', proposeRow.every((r) => Number(r.is_active) === 0), JSON.stringify(proposeRow))

    const review = await api(`/api/doctors/doc_li/task-proposals/${stepsProposalRow.proposalId}/review`, {
      method: 'POST',
      body: { decision: 'approve' },
    })
    check('审批通过（200）', review.status === 200, `HTTP ${review.status} ${JSON.stringify(review.json?.code || '')}`)
    check('返回 tasksUnchanged = false', review.json?.tasksUnchanged === false)

    const dtAfter = await api(`/api/patients/${patientId}/daily-tasks`)
    const stepsAfter = (dtAfter.json?.tasks || []).find((t) => t.taskId === 'steps')
    check(
      '患者端步数目标已按提案更新',
      stepsAfter?.target === 3000,
      `${targetBefore} → ${stepsAfter?.target}`
    )
    check('被覆盖任务带 doctor 覆盖回显', Boolean(stepsAfter?.override), JSON.stringify(stepsAfter?.override?.fields || []))
  } else {
    check('找到步数提案（前置条件）', false, '未找到 steps 提案，后续断言跳过')
  }

  /* ================= 6. 六智能体健康建议 ================= */
  section('6. 个性化健康建议 · 六智能体协同')
  const careEvents = await sse('/api/agent/care-plan', { patientId })
  const started = careEvents.filter((e) => e.type === 'agent_start').map((e) => e.agentId)
  const results = careEvents.filter((e) => e.type === 'agent_result')
  const done = careEvents.find((e) => e.type === 'run_done')
  check('协同覆盖六个智能体', new Set(started).size === 6, started.join('/'))
  check(
    '六个智能体均产出结构化结果',
    results.length === 6,
    results.map((r) => r.agentId).join('/')
  )
  const cp = done?.carePlan
  check('run_done 带回 carePlan 成品', Boolean(cp))
  check('carePlan.byAgent 为六个智能体', (cp?.byAgent || []).length === 6, JSON.stringify(cp?.byAgent || []))
  check('成品含汇总要点（健康管家）', (cp?.keyPoints || []).length > 0, `keyPoints=${(cp?.keyPoints || []).length}`)
  check('成品含运动方案（方案规划）', Boolean(cp?.plan?.exercise?.type), String(cp?.plan?.exercise?.type || ''))
  check('成品含用药解读（多模态识别）', Boolean(cp?.medication?.summary), String(cp?.medication?.summary || '').slice(0, 40))
  check('成品含坚持策略（情感陪伴）', Boolean(cp?.companion?.message), String(cp?.companion?.message || '').slice(0, 30))
  check('成品含产品预警等级（风险预警）', typeof cp?.riskLevel === 'string', String(cp?.riskLevel || ''))
  check('成品含免责声明', Boolean(cp?.disclaimer))

  /* ---- 协同不得改动档案与阈值 ---- */
  const t3 = queryDb('SELECT target_id, systolic_target, basis FROM patient_targets WHERE patient_id = ?', patientId)
  check('协同运行未新增 patient_targets 行', t3.length === 1, `rows=${t3.length}`)
  check('协同运行未改写控制目标', t3[0]?.systolic_target === 135, String(t3[0]?.systolic_target))

  /* ================= 7. 从 0 到 1：记录 → 评分 ================= */
  section('7. 记录数据 → 规则评分（闭环终点）')
  const rec = await api(`/api/patients/${patientId}/records`, {
    method: 'POST',
    body: { steps: 6200, systolic_pressure: 148, diastolic_pressure: 92, fasting_glucose: 5.6, exercise_minutes: 25 },
  })
  check('可写入当日数据', rec.status === 200, `HTTP ${rec.status}`)

  const snapshot = await api(`/api/patients/${patientId}/snapshot`)
  check('当日快照可读', snapshot.status === 200, `HTTP ${snapshot.status}`)

  const score = await api('/api/agent/briefing', { method: 'POST', body: { patientId } })
  check('晨报可生成（本地算法，不依赖模型）', score.status === 200, `HTTP ${score.status}`)
  check('晨报含规则分与等级', Number.isFinite(score.json?.score), `score=${score.json?.score} grade=${score.json?.grade}`)
  check('晨报含产品预警等级', typeof score.json?.risk?.highestLevel === 'string', String(score.json?.risk?.highestLevel || ''))

  const alerts = await api(`/api/patients/${patientId}/alerts`)
  check('预警落库接口可读', alerts.status === 200, `count=${(alerts.json?.alerts || []).length}`)
} catch (err) {
  lines.push('')
  lines.push(`💥 验收脚本异常：${err?.message || err}`)
  if (serverOut) lines.push('--- 服务端输出 ---\n' + serverOut.slice(-2000))
  fail++
} finally {
  cleanup()
}

lines.push('')
lines.push('='.repeat(64))
lines.push(`通过 ${pass} / ${pass + fail}${fail ? `　失败 ${fail}` : '　全部通过 ✅'}`)
lines.push('='.repeat(64))
console.log(lines.join('\n'))
process.exit(fail ? 1 : 0)
