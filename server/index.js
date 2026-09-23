/**
 * 迈康 MyCare · 多智能体服务端
 * Express + SSE，承接 DeepSeek 调用，前端不接触 API Key。
 */
import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'

import { config, isModelConfigured, rootDir } from './config.js'
import {
  getSeries,
  getDailySnapshot,
  getPatientProfile,
  toUserProfileView,
  todayCST,
} from './data/dataProvider.js'
import {
  listPatientEntries,
  resolvePatientForLogin,
  registerPatient,
  resetPatientPassword,
  updatePatientProfile,
  getPatientRecords,
  getPatientBadges,
  upsertDailyRecord,
  getDoctorPatients,
  getPatientCareTeam,
  setDoctorConsent,
  getDailyTasks,
  getEffectiveTaskState,
  appendBloodPressureReading,
  appendBloodGlucoseReading,
  appendMedicationLog,
} from './data/patientService.js'
import {
  applyOverridePackage,
  revokeOverride,
  validationError,
} from './data/taskOverrideService.js'
import {
  createDoctorNote,
  listPatientNotes,
  markNoteRead,
  assertDoctorExists,
} from './data/doctorNoteService.js'
import {
  createOrUpdateProposal,
  listProposals,
  reviewProposal,
} from './data/proposalService.js'
import {
  computeAiScore,
  readScoreCache,
} from './data/aiScoreService.js'
import { runProposalChannel } from './agents/proposalIntent.js'
import {
  validateOverridePackage,
  TASK_OVERRIDE_CONTRACT,
  OVERRIDE_CONTRACT_VERSION,
  THRESHOLD_FIELDS,
  NOT_OVERRIDABLE_TASK_IDS,
  ADDABLE_MONITOR_TASKS,
} from '../src/utils/taskOverride.js'
import { AI_STATUS_TEXT } from '../src/utils/aiScore.js'
import { buildAgentContext, buildRuleEvaluation, buildVisionContext } from './data/agentContext.js'
import { memoryPreamble } from './data/agentMemory.js'
import { DataProviderError } from './data/errors.js'
import { persistRuleAlerts, listPatientAlerts } from './data/alertService.js'
import { publicAgents, PIPELINE, getAgent, runtimePreamble } from './agents/registry.js'
import { orchestrate } from './agents/orchestrator.js'
import { createToolExecutor } from './agents/tools.js'
import { isModelConfigured as modelReady, resolveFallback, runToolLoop, chatStream } from './deepseek.js'
import { mockChat } from './agents/mock.js'
import { readImage } from './vision.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '15mb' }))

/* ------------------------------ SSE 工具 ------------------------------ */
function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      /* ignore */
    }
  }, 15000)

  return {
    send(event) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    end() {
      clearInterval(heartbeat)
      res.end()
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ 基础接口 ------------------------------ */
app.get('/api/status', (req, res) => {
  res.json({
    app: '迈康 MyCare',
    version: '2.0.0',
    modelConfigured: isModelConfigured(),
    model: isModelConfigured() ? config.model : 'local-engine',
    // 是否允许「无 Key 时降级为本地推理引擎」。false = 排障模式：无 Key 直接报错
    mockFallbackAllowed: config.allowMockFallback,
    visionConfigured: Boolean(config.visionApiKey),
    capabilities: ['multi-agent-orchestration', 'tool-calling', 'streaming', 'voice', 'vision-input'],
  })
})

app.get('/api/agents', (req, res) => {
  res.json({ agents: publicAgents(), pipeline: PIPELINE })
})

/* ==================================================================== *
 * 患者数据 API（第二阶段 Step 4）
 * --------------------------------------------------------------------
 * 前端页面不再读 localStorage / demoPatients.js，统一经此访问 dataProvider → SQLite。
 * 患者身份以 patient_id 为唯一规范键；查不到患者返回 404，绝不回落到默认患者。
 * ==================================================================== */

/** DataProviderError → HTTP（code 见 server/data/errors.js） */
function sendDataError(res, err) {
  res.status(err?.httpStatus ?? 500).json({
    error: err?.message || '服务器内部错误',
    code: err?.code ?? 'E_INTERNAL',
    detail: err?.detail ?? null,
  })
}

/**
 * 智能体接口的患者身份解析（Step 5）。
 * 入站只接受 patient_id（兼容收 user_id 别名），**不接受**前端回传的 records/profile/badges —
 * 后端一律以 patient_id 经 dataProvider 自取数据。
 */
function resolveBodyPatientId(body = {}) {
  const raw = body.patientId ?? body.patient_id ?? body.userId ?? body.user_id
  return raw === undefined || raw === null || String(raw).trim() === '' ? null : String(raw)
}

function sendInvalidArg(res, message) {
  res.status(400).json({ error: message, code: 'E_INVALID_ARG', detail: null })
}

/** 示范病例入口（登录页一键进入） */
app.get('/api/patients', async (req, res) => {
  try {
    res.json({ patients: await listPatientEntries() })
  } catch (err) {
    sendDataError(res, err)
  }
})

/**
 * 登录身份解析。
 * 兼容入站 user_id 别名（契约 §3），进入 dataProvider 前统一归一为 patient_id。
 */
app.post('/api/patients/login', async (req, res) => {
  const { patientId, userId, username, password } = req.body || {}
  try {
    const resolved = await resolvePatientForLogin({ patientId: patientId || userId, username, password })
    res.json(resolved)
  } catch (err) {
    sendDataError(res, err)
  }
})

/**
 * 自助注册：在 patients 中建立属于该账号的真实档案（含疾病诊断 / 紧急联系人 / 医患关系）。
 * 注册成功后 patients 多出一行，登录页示范入口不受影响（仅列免密账号），
 * 新账号的血压 / 血糖等数据完全由用户自己录入产生。
 */
app.post('/api/patients/register', async (req, res) => {
  try {
    res.status(201).json(await registerPatient(req.body || {}))
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 找回密码：用户名 + 注册手机号双因子匹配后重置（仅自助注册账号） */
app.post('/api/patients/reset-password', async (req, res) => {
  try {
    res.json(await resetPatientPassword(req.body || {}))
  } catch (err) {
    sendDataError(res, err)
  }
})

app.get('/api/patients/:patientId/profile', async (req, res) => {
  try {
    const profile = await getPatientProfile(req.params.patientId)
    res.json({ patientId: req.params.patientId, profile, view: toUserProfileView(profile) })
  } catch (err) {
    sendDataError(res, err)
  }
})

/**
 * 完善 / 更新健康档案（「从 0 到 1」建档闭环）。
 * --------------------------------------------------------------------
 * 入站只收 patientId + 档案字段；六类档案（基础信息 / 紧急联系人 / 疾病诊断 /
 * 生活画像 / 控制目标 / 用药计划）一次提交，后端按「有行则 UPDATE、无行才 INSERT」
 * 落库，**不新建表**、**不产生 patient_targets 第二行**。
 *
 * 与 Step 11 的关系：本接口写的是**规则层与事实层之上的档案层**，
 * 不参与任何规则判定，也不触碰 clinicalRules 与生效覆盖包；
 * 患者自述的控制目标仍可由医生在「今日任务」中调整。
 */
app.put('/api/patients/:patientId/profile', async (req, res) => {
  try {
    const result = await updatePatientProfile(req.params.patientId, req.body || {})
    res.json({ ok: true, ...result })
  } catch (err) {
    sendDataError(res, err)
  }
})

app.get('/api/patients/:patientId/snapshot', async (req, res) => {
  try {
    const date = req.query.date || todayCST()
    res.json(await getDailySnapshot(req.params.patientId, date))
  } catch (err) {
    sendDataError(res, err)
  }
})

app.get('/api/patients/:patientId/series/:metricKey', async (req, res) => {
  const { days = 7, source, anchorMode, from, to, measureType } = req.query
  const options = {}
  if (source) options.source = source
  if (anchorMode) options.anchorMode = anchorMode
  if (from) options.from = from
  if (to) options.to = to
  if (measureType) options.measureType = measureType
  try {
    res.json(await getSeries(req.params.patientId, req.params.metricKey, Number(days) || 7, options))
  } catch (err) {
    sendDataError(res, err)
  }
})

app.get('/api/patients/:patientId/records', async (req, res) => {
  try {
    res.json(await getPatientRecords(req.params.patientId, Number(req.query.days) || 30))
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 录入 / 修正一条当日健康数据（落库，追加不覆盖） */
app.post('/api/patients/:patientId/records', async (req, res) => {
  try {
    res.json(await upsertDailyRecord(req.params.patientId, req.body || {}))
  } catch (err) {
    sendDataError(res, err)
  }
})

/* ==================================================================== *
 * Step 9 · 一天多次测量（事实层追加） + 今日任务（派生视图）
 * --------------------------------------------------------------------
 * · POST /readings        → 纯 INSERT 一条 blood_pressure_readings / blood_glucose_readings，
 *                           同日多次互不覆盖；随后回写 daily 兼容层（仅供既有规则使用）。
 * · POST /medication-logs → 服药打卡（一个药物多个时段 = 多个计划实例）。
 * · GET  /daily-tasks     → 由确定性规则生成的今日任务，进度实时派生、不落库。
 * ==================================================================== */
app.post('/api/patients/:patientId/readings', async (req, res) => {
  const body = req.body || {}
  const kind = String(body.kind || body.type || '').trim()
  try {
    if (kind === 'blood_pressure' || kind === 'bloodPressure' || kind === 'bp') {
      return res.status(201).json(await appendBloodPressureReading(req.params.patientId, body))
    }
    if (kind === 'blood_glucose' || kind === 'bloodGlucose' || kind === 'bg') {
      return res.status(201).json(await appendBloodGlucoseReading(req.params.patientId, body))
    }
    return sendInvalidArg(res, "kind 必填，只能为 'blood_pressure' 或 'blood_glucose'")
  } catch (err) {
    sendDataError(res, err)
  }
})

app.post('/api/patients/:patientId/medication-logs', async (req, res) => {
  try {
    res.status(201).json(await appendMedicationLog(req.params.patientId, req.body || {}))
  } catch (err) {
    sendDataError(res, err)
  }
})

app.get('/api/patients/:patientId/daily-tasks', async (req, res) => {
  try {
    res.json(await getDailyTasks(req.params.patientId, req.query.date))
  } catch (err) {
    sendDataError(res, err)
  }
})

app.get('/api/patients/:patientId/badges', async (req, res) => {
  try {
    res.json({ patientId: req.params.patientId, badges: await getPatientBadges(req.params.patientId) })
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 落库预警（alerts 表）—— 患者端 / 医生端读取，数据来自确定性规则命中后的落库结果 */
app.get('/api/patients/:patientId/alerts', async (req, res) => {
  try {
    res.json(await listPatientAlerts(req.params.patientId, { limit: Number(req.query.limit) || 20 }))
  } catch (err) {
    sendDataError(res, err)
  }
})

/**
 * 患者端：读当日「Rule Score + 已缓存的 AI 辅助分」（Step 11 · Phase 3）。
 * --------------------------------------------------------------------
 * **只读缓存，绝不触发模型调用** —— 避免「刷新一次页面花一次钱」。
 * 需要生成时用 `POST /api/agent/score`。
 *
 * 注意区分两种「没有 AI 分」：
 *   · `aiStatus: null` + `cached: false`  → **尚未生成**，界面应显示可生成的入口，而非「不可用」
 *   · `aiStatus: 'unavailable'`           → 已尝试但拿不到（模型未配置 / 调用失败）
 */
app.get('/api/patients/:patientId/score', async (req, res) => {
  const { patientId } = req.params
  try {
    const { snapshot, inputHash, hit } = await readScoreCache(patientId, req.query.date)
    const { rule } = snapshot
    res.json({
      patientId,
      date: snapshot.date,
      inputHash,
      rule: rule.score,
      ruleGrade: rule.grade,
      ruleBreakdown: rule.breakdown,
      applicableDimensions: snapshot.applicableDimensions,
      aiStatus: hit ? hit.aiStatus : null,
      ai: hit ? hit.ai : null,
      code: hit ? hit.code : null,
      detail: hit ? hit.detail : null,
      rejected: hit ? hit.rejected : [],
      aiMessage: hit ? (hit.aiStatus === 'ok' ? null : AI_STATUS_TEXT[hit.aiStatus] || null) : null,
      model: hit ? hit.model : null,
      cached: Boolean(hit),
      generated: Boolean(hit),
      generatedAt: hit ? hit.generatedAt : null,
      generatedAtRequest: new Date().toISOString(),
    })
  } catch (err) {
    sendDataError(res, err)
  }
})

/* ==================================================================== *
 * 隐私授权闭环（2026-09-17）—— 患者本人对「医生可否查阅我的档案」的开关
 * --------------------------------------------------------------------
 * 契约：
 *   GET  /api/patients/:patientId/care-team
 *        → { patientId, doctors: [{ doctorId, name, title, department,
 *                                   granted, relationCreatedAt }] }
 *   POST /api/patients/:patientId/care-team/:doctorId  body { granted: boolean }
 *        → { patientId, doctorId, granted, doctor }
 * 边界：
 *   · 只读写**授权状态**，不返回任何健康数据；
 *   · 医生端可见性**唯一**取决于 doctor_patient_relations.is_active，
 *     getDoctorPatients() 的既有过滤条件一个字未改 → 撤回后医生端立即不可见；
 *   · 入站只接受 patientId + doctorId + 布尔 granted，**不接受** records/profile 回传。
 * ==================================================================== */

app.get('/api/patients/:patientId/care-team', async (req, res) => {
  try {
    res.json(await getPatientCareTeam(req.params.patientId))
  } catch (err) {
    sendDataError(res, err)
  }
})

app.post('/api/patients/:patientId/care-team/:doctorId', async (req, res) => {
  const { granted } = req.body || {}
  if (typeof granted !== 'boolean') {
    return sendInvalidArg(res, 'granted 必须为布尔值（true = 同意授权 / false = 撤回授权）')
  }
  try {
    res.json(await setDoctorConsent(req.params.patientId, req.params.doctorId, granted))
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 医生端：经 doctor_patient_relations 查询其管理患者（**仅 is_active = 1 = 患者已授权**） */
app.get('/api/doctors/:doctorId/patients', async (req, res) => {
  try {
    res.json(await getDoctorPatients(req.params.doctorId))
  } catch (err) {
    sendDataError(res, err)
  }
})

/* ==================================================================== *
 * Step 11 · Phase 1 —— 医生端「今日任务」覆盖 + 真落库医生建议
 * --------------------------------------------------------------------
 * 三条不可违背的边界（与 docs/Step11_最终技术方案_评审修订版.md 一致）：
 *   1. 规则仍是今日任务的唯一生成者 —— 覆盖只改参数，**不新建任务域**；
 *   2. 医学阈值与 clinicalRules 口径**不得**被覆盖层或 AI 触碰；
 *   3. 「宁可报错，不要静默忽略」—— 任一项非法 → **整包 400**（原子拒绝）。
 *
 * 关口模型：
 *   关口 1 校验 validateOverridePackage()（src/utils/taskOverride.js，前后端共用同一把尺子）
 *   关口 2 应用 buildDailyTasks({ taskOverrides })
 *   关口 3 写入 applyOverridePackage()（全项目唯一写覆盖包的函数）
 *   前端只做体验级预校验，**准入判定一律以后端为准**。
 * ==================================================================== */

/** 可覆盖字段字典 —— 枚举只在契约层定义一处，前端不得自行拼字 */
function overrideContractDict() {
  return {
    contractVersion: OVERRIDE_CONTRACT_VERSION,
    taskIds: Object.keys(TASK_OVERRIDE_CONTRACT),
    notOverridableTaskIds: NOT_OVERRIDABLE_TASK_IDS.slice(),
    thresholdFields: THRESHOLD_FIELDS.slice(),
    fields: TASK_OVERRIDE_CONTRACT,
    // Step 12：医生审结「同意新增监测项」时可启用的监测域白名单（含默认时段与合法枚举）。
    // 前端据此渲染「修改后生效」的时段勾选，**不得自行硬编码**这两个域。
    addableMonitorTasks: ADDABLE_MONITOR_TASKS,
  }
}

/**
 * 校验上下文：疾病谱 + **当日规则实际生成的任务域**（由后端推导，不由前端或 AI 声明）。
 * 「医生不能创造规则不存在的任务域」这一条就落在这里。
 */
async function buildOverrideContext(patientId, date) {
  const profile = await getPatientProfile(patientId)
  const view = toUserProfileView(profile)
  const state = await getEffectiveTaskState(patientId, date)
  return {
    view,
    state,
    ctx: {
      generatedTaskIds: state.taskIds,
      primaryDisease: view.medical.primaryDisease,
      diseases: view.diseases,
    },
  }
}

/** 医生端：某患者当日任务实况（含进度）+ 当前生效覆盖包 + 可覆盖字段字典 */
app.get('/api/doctors/:doctorId/patients/:patientId/tasks', async (req, res) => {
  try {
    assertDoctorExists(req.params.doctorId)
    const date = req.query.date || todayCST()
    const { state } = await buildOverrideContext(req.params.patientId, date)
    res.json({
      patientId: req.params.patientId,
      date: state.date,
      tasks: state.tasks,
      overrides: state.overrides,
      overridePackage: state.overridePackage,
      overrideContract: overrideContractDict(),
    })
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 医生端：写入 / 替换当前生效覆盖包（PUT 表达「替换」语义） */
app.put('/api/doctors/:doctorId/patients/:patientId/task-overrides', async (req, res) => {
  const { doctorId, patientId } = req.params
  const { overrides, basis, contractVersion } = req.body || {}
  try {
    assertDoctorExists(doctorId)
    const { ctx } = await buildOverrideContext(patientId, req.query.date)

    // —— 关口 1：唯一尺子（前端预校验与 AI 过滤共用同一实现）——
    const verdict = validateOverridePackage({ overrides, basis, contractVersion }, ctx)
    if (!verdict.ok) return sendDataError(res, validationError(verdict, { patientId, overrides }))

    // —— 关口 3：唯一写库出口（单事务：旧版本失效 + 新版本生效 + 步数目标同步）——
    const applied = applyOverridePackage({
      patientId,
      doctorId,
      overrides: verdict.normalized.overrides,
      basis: verdict.normalized.basis,
      origin: 'doctor',
    })

    const after = await getEffectiveTaskState(patientId, req.query.date)
    res.json({
      ok: true,
      prescriptionId: applied.prescriptionId,
      overrides: verdict.normalized.overrides,
      tasks: after.tasks,
      overridePackage: after.overridePackage,
    })
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 医生端：撤销某任务域的覆盖（回落规则值） */
app.delete('/api/doctors/:doctorId/patients/:patientId/task-overrides/:taskId', async (req, res) => {
  const { doctorId, patientId, taskId } = req.params
  try {
    assertDoctorExists(doctorId)
    if (!Object.prototype.hasOwnProperty.call(TASK_OVERRIDE_CONTRACT, taskId)) {
      throw new DataProviderError('E_UNKNOWN_TASK_ID', `不支持覆盖的任务：${taskId}`, { taskId })
    }
    const result = revokeOverride(patientId, taskId, doctorId)
    if (!result.revoked) {
      return res.status(404).json({
        error: '该任务域当前没有生效覆盖',
        code: 'E_OVERRIDE_NOT_FOUND',
        detail: result,
      })
    }
    const after = await getEffectiveTaskState(patientId)
    res.json({ ok: true, revokedTaskId: taskId, reason: result.reason, tasks: after.tasks })
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 医生端：新增建议 —— 真落库（D8，修复此前「提示成功但刷新即丢」的假功能） */
app.post('/api/doctors/:doctorId/patients/:patientId/notes', async (req, res) => {
  const { content, noteType, priority } = req.body || {}
  try {
    const note = createDoctorNote({
      doctorId: req.params.doctorId,
      patientId: req.params.patientId,
      content,
      noteType,
      priority,
    })
    res.status(201).json(note)
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 患者端：读取医生建议 / 调整通知 */
app.get('/api/patients/:patientId/doctor-notes', async (req, res) => {
  try {
    const unreadOnly = String(req.query.unread || '') === '1'
    res.json({
      patientId: req.params.patientId,
      notes: listPatientNotes(req.params.patientId, {
        unreadOnly,
        limit: Number(req.query.limit) || 20,
      }),
    })
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 患者端：标记建议已读 */
app.post('/api/patients/:patientId/doctor-notes/:noteId/read', async (req, res) => {
  try {
    res.json(markNoteRead(req.params.patientId, req.params.noteId))
  } catch (err) {
    sendDataError(res, err)
  }
})

/* ==================================================================== *
 * Step 11 · Phase 2 —— 医生端「任务调整申请」审核
 * --------------------------------------------------------------------
 * 患者端对话产出的提案都是 is_active=0 的待审行，**不参与**覆盖读取 →
 * 医生点「同意」之前，患者端任务一个字都不变。
 * approve / modify 复用与医生端 PUT 完全相同的校验与写库函数（同一把尺子）。
 * ==================================================================== */

const PROPOSAL_STATUSES = ['pending', 'reviewed', 'all']

/** 医生端：任务调整申请列表（默认只看待审） */
app.get('/api/doctors/:doctorId/task-proposals', async (req, res) => {
  try {
    assertDoctorExists(req.params.doctorId)
    const requested = String(req.query.status || 'pending')
    const status = PROPOSAL_STATUSES.includes(requested) ? requested : 'pending'
    const patientId = req.query.patientId ? String(req.query.patientId) : null
    const proposals = listProposals({ status, patientId })
    res.json({
      doctorId: req.params.doctorId,
      status,
      patientId,
      count: proposals.length,
      proposals,
    })
  } catch (err) {
    sendDataError(res, err)
  }
})

/** 医生端：审结一条提案（approve 采纳 / modify 修改后生效 / reject 驳回） */
app.post('/api/doctors/:doctorId/task-proposals/:proposalId/review', async (req, res) => {
  const { doctorId, proposalId } = req.params
  const { decision, overrides, reason } = req.body || {}
  try {
    assertDoctorExists(doctorId)
    if (!['approve', 'modify', 'reject'].includes(decision)) {
      throw new DataProviderError('E_INVALID_ARG', 'decision 非法，只能为 approve / modify / reject', {
        decision,
      })
    }
    const result = await reviewProposal({ proposalId, doctorId, decision, overrides, reason })
    res.json({ ok: true, ...result })
  } catch (err) {
    sendDataError(res, err)
  }
})

/**
 * 健康方案协商（六智能体协同 · 「个性化健康建议」页的数据源）
 * --------------------------------------------------------------------
 * 与 /api/agent/orchestrate 的区别：
 *   · orchestrate  → 四智能体「今日简报」拓扑（体征 → 风险 → 方案 → 汇总）
 *   · care-plan    → **六智能体「方案协商」拓扑**
 *                    （体征盘点 → 用药与化验解读 → 风险与禁忌 →
 *                      个性化方案 → 坚持策略 → 汇总成文）
 *   成品由 run_done 事件带回（`carePlan` 字段），并保留每个智能体的原始产出，
 *   便于页面标注「这一条是哪位智能体给的」。
 *
 * 入站只收 patientId；上下文由后端经 dataProvider 装配，前端不回传任何体征数据。
 * 红线：本接口**不落库、不改今日任务、不改任何医学阈值**——它只产出建议文本，
 *   运动强度必须与风险等级匹配，用药只做提醒不做剂量调整。
 */
app.post('/api/agent/care-plan', async (req, res) => {
  const patientId = resolveBodyPatientId(req.body)
  const { goal = '' } = req.body || {}
  if (!patientId) return sendInvalidArg(res, 'patientId 必填（后端以 patient_id 自取数据）')

  let context
  try {
    context = await buildAgentContext(patientId, { days: 7 })
  } catch (err) {
    return sendDataError(res, err)
  }

  const sse = openSSE(res)
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  try {
    for await (const event of orchestrate({
      context,
      goal: goal || '生成个性化健康管理建议（运动 / 饮食 / 用药与坚持策略）',
      signal: controller.signal,
      scene: 'carePlan',
    })) {
      sse.send(event)
    }
  } catch (err) {
    sse.send({ type: 'error', message: err.message })
  } finally {
    sse.end()
  }
})

/**
 * 轻量晨报：只跑本地算法，不调用大模型，适合首页自动加载。
 * 入站只收 patient_id；后端经 dataProvider → SQLite 自取上下文。
 */
app.post('/api/agent/briefing', async (req, res) => {
  const patientId = resolveBodyPatientId(req.body)
  if (!patientId) return sendInvalidArg(res, 'patientId 必填（后端以 patient_id 自取数据）')

  let context
  try {
    context = await buildAgentContext(patientId, { days: 7 })
  } catch (err) {
    return sendDataError(res, err)
  }

  const executor = createToolExecutor(context)
  const analysis = executor.analysis()
  const risk = executor.risk()
  const score = executor.execute('compute_health_score', {})

  Promise.resolve(score).then((s) => {
    const actions = []
    const top = risk.risks[0]
    if (top) actions.push({ priority: 'high', title: top.action, detail: top.title })
    const steps = analysis.find((a) => a.key === 'steps')
    if (steps && steps.complianceRate < 70) {
      actions.push({ priority: 'medium', title: `散步 30 分钟（目标 ${steps.target} 步）`, detail: '步数达标率偏低' })
    }
    // 描述性观察（**无等级**）：只在行动位还有余量时占用一格，绝不参与风险等级
    const obs = (risk.observations || [])[0]
    if (obs && actions.length < 2) actions.push({ priority: 'low', title: obs.action, detail: obs.title })
    actions.push({ priority: 'low', title: '睡前记录当天体征', detail: '保持记录连续性' })

    res.json({
      score: s.score,
      grade: s.grade,
      breakdown: s.breakdown,
      // 风险等级**唯一来源**：clinicalRules（Step 11 · D-2）。
      // highestLevel 为产品键 info / watch / alert / emergency；
      // items 与落库 alerts、医生端状态取自同一集合（rules.triggered）。
      risk: {
        highestLevel: risk.highestLevel,
        label: risk.levelLabel,
        items: risk.risks.slice(0, 4),
        observations: risk.observations,
      },
      headline:
        risk.highestLevel === 'emergency' ? '出现危险值，请优先处理预警项'
        : risk.highestLevel === 'alert' ? '指标达到预警等级，今天需要重点关注'
        : risk.highestLevel === 'watch' ? '整体可控，个别指标需留意'
        : '各项指标平稳，继续保持',
      actions: actions.slice(0, 3),
      indicators: analysis.map((a) => ({
        key: a.key,
        label: a.label,
        unit: a.unit,
        latest: a.latest,
        mean: a.mean,
        direction: a.direction,
        complianceRate: a.complianceRate,
        improving: a.improving,
      })),
      generatedAt: new Date().toISOString(),
    })
  })
})

/**
 * AI 评分（Step 11 · Phase 3）：生成或读取「Rule Score + AI 辅助分」。
 * --------------------------------------------------------------------
 * 入站只收 `{ patientId, date?, force? }` —— **不接受**前端回传的 records / profile / 分数。
 * 后端经 dataProvider 自取当日体征与疾病谱，Rule Score 由 `src/utils/healthScore.js` 现算。
 *
 * 三条铁律（与方案 §4 一致）：
 *   ① **主数字恒为 Rule Score**；AI 只贡献 `adjustments`，最终分由确定性纯函数合成。
 *   ② 一切降级（模型未配置 / 调用失败 / 结构不合法 / 违反约束）**一律回落 Rule Score**，
 *      本接口**永不**因为 AI 不可用而报错 —— 页面必须还能显示规则分。
 *   ③ `force: true` = 跳过当日缓存重新生成（界面上的「重新生成」按钮）。**不落库**。
 */
app.post('/api/agent/score', async (req, res) => {
  const patientId = resolveBodyPatientId(req.body)
  if (!patientId) return sendInvalidArg(res, 'patientId 必填（后端以 patient_id 自取数据）')
  try {
    const result = await computeAiScore(patientId, {
      date: req.body?.date,
      force: req.body?.force === true,
    })
    res.json(result)
  } catch (err) {
    sendDataError(res, err)
  }
})

/**
 * 完整多智能体协同：SSE 推送全过程。
 * 入站只收 { patientId, goal }；上下文由后端 patient_id → dataProvider → SQLite 装配。
 * 运行结束后把确定性规则命中落库到 alerts（Step 5 闭环终点）。
 */
app.post('/api/agent/orchestrate', async (req, res) => {
  const patientId = resolveBodyPatientId(req.body)
  const { goal = '' } = req.body || {}
  if (!patientId) return sendInvalidArg(res, 'patientId 必填（后端以 patient_id 自取数据）')

  let context
  try {
    context = await buildAgentContext(patientId, { days: 7 })
  } catch (err) {
    return sendDataError(res, err)
  }

  const sse = openSSE(res)
  const controller = new AbortController()
  // 注意：必须监听 res 的 close（连接断开），而不是 req 的 close
  // —— req 的 close 会在请求体读取完毕后立即触发，会导致协同流程刚起步就被中断
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  try {
    for await (const event of orchestrate({ context, goal, signal: controller.signal })) {
      sse.send(event)
    }

    // —— 闭环终点：确定性规则命中 → alerts 落库 ——
    // 等级 / 依据一律取自 clinicalRules 的命中结果；AI 只做表达，不写库。
    const evaluation = buildRuleEvaluation(context)
    const persisted = await persistRuleAlerts(patientId, evaluation, { source: 'orchestrator' })
    sse.send({ type: 'alerts_persisted', patientId, ...persisted })
  } catch (err) {
    sse.send({ type: 'error', message: err.message })
  } finally {
    sse.end()
  }
})

/**
 * Step 11 · Phase 2 · 确定性任务调整提案通道
 * --------------------------------------------------------------------
 * 与模型可用性**解耦**（F-7）：未配 Key 时 `/api/agent/chat` 走 `mockChat` 降级分支，
 * **不经过 runToolLoop**。若把提案识别挂在「模型工具调用」上，答辩环境下
 * 「对话 → 医生审核」整条链路根本不会触发 —— 故识别做成确定性通道。
 *
 * 红线：本函数只**生成待审提案行**（is_active=0），绝不触碰生效覆盖包；
 *      唯一写覆盖包的入口仍是 `applyOverridePackage()`，且只在医生审结时被调用。
 *       提案通道失败**不得**影响对话主流程（catch 后返回空数组）。
 */
async function buildProposalEvents({ patientId, agentId, message }) {
  if (!patientId || !String(message || '').trim()) return []
  try {
    const { state, ctx } = await buildOverrideContext(patientId)
    const outcome = await runProposalChannel({
      patientId,
      agentId,
      message,
      state,
      ctx,
      createOrUpdate: createOrUpdateProposal,
    })
    if (!outcome?.proposalIds?.length) return []
    return [
      {
        type: 'task_proposal',
        patientId,
        agentId,
        status: 'pending_review',
        proposalIds: outcome.proposalIds,
        proposals: outcome.proposals,
        filteredCount: outcome.filtered?.length ?? 0,
      },
    ]
  } catch (err) {
    console.warn('提案通道失败：', err?.message || err)
    return []
  }
}

/**
 * 把本轮「任务调整申请」的**真实结果**写进系统提示（Step 11 · 2026-09-17 补充）。
 * ---------------------------------------------------------------------------
 * 起因：患者说「我还想每天监测一下血糖」，模型自己调了 `schedule_reminder`（一个**本次会话内
 * 的内存副作用，不落库、不进入每日任务**），却在回复里写成「已为您把血糖监测排进每日提醒」——
 * 患者被承诺了一件系统从未做过的事，医生端也什么都收不到。
 *
 * 修法：申请单由**确定性通道**（`buildProposalEvents`）在模型说话之前就算好了，
 * 这里把回执原样交给模型，让它只能**转述系统事实**，不能自行声称已修改任务。
 */
function proposalReceiptForPrompt(events = []) {
  const items = (Array.isArray(events) ? events : []).flatMap((e) => e.proposals || [])
  const lines = ['【本轮任务调整申请 · 系统回执（由后端确定性通道生成，不是你的推测）】']

  if (!items.length) {
    lines.push(
      '本轮**没有**生成任何待审申请。若患者提出了增加 / 取消监测、调整目标或测量时段，' +
        '你必须如实说明：这类变更需要医生决定，本轮系统**没有**新增或改动任何任务。'
    )
  } else {
    lines.push(`本轮系统已生成 ${items.length} 条待审申请（**尚未生效**）：`)
    for (const p of items) {
      lines.push(
        p.type === 'monitor_request'
          ? `  · 申请新增「${p.label || p.taskId}」日常监测（是否纳入由医生判断）`
          : `  · ${p.taskId}.${p.field}：${JSON.stringify(p.currentValue)} → ${JSON.stringify(p.proposedValue)}`
      )
    }
    lines.push('请如实告知患者「已提交医生审核，审核通过前您的今日任务不会有任何变化」。')
    if (items.some((p) => p.type === 'monitor_request')) {
      lines.push(
        '若医生审核通过该监测项，系统会**真正启用**它：患者端今日任务立即出现该项，' +
          '并同时计入当日健康评分的适用维度。这是未来的结果，**审核通过前不得说成已经生效**。'
      )
    }
  }

  lines.push(
    '【硬约束】你**没有任何权限**新增、删除或修改每日任务、监测频次、提醒计划与医学阈值。' +
      '`schedule_reminder` 只是**本次会话内的一次性记录**：不落库、不会出现在患者的每日任务里、医生也看不到。' +
      '禁止出现「已为您排进每日提醒 / 已修改任务 / 已生效 / 已帮您加上」这类表述；' +
      '只能表述为「已提交医生审核」或「需要医生确认」。'
  )
  lines.push(
    '【与弱记忆的分工】若系统提示词里的「该患者的历史上下文（弱记忆）」显示某条申请已被医生审结，' +
      '那是**医生决定的既成事实**（不是你的功劳，也不是你的权限）：状态为「医生已同意」时可以如实告知' +
      '患者该项已由医生审结生效；状态为「医生未通过」时如实说明未通过并转述医生理由。' +
      '这条**不适用于本轮**新提交、尚未审结的申请 —— 那些仍然只能说「已提交医生审核」。'
  )
  return lines.join('\n')
}

/**
 * 与指定智能体对话：工具闭环 + 流式输出。
 * 入站只收 patientId；后端经 dataProvider 装配上下文（无 patientId 时使用空上下文）。
 */
app.post('/api/agent/chat', async (req, res) => {
  const { agentId = 'steward', message = '', history = [] } = req.body || {}
  const patientId = resolveBodyPatientId(req.body)
  const agent = getAgent(agentId) || getAgent('steward')

  let context = {}
  if (patientId) {
    try {
      context = await buildAgentContext(patientId, { days: 7 })
    } catch (err) {
      return sendDataError(res, err)
    }
  }

  const executor = createToolExecutor(context)
  const sse = openSSE(res)
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  try {
    sse.send({ type: 'chat_start', agentId: agent.id, name: agent.name, icon: agent.icon, color: agent.color })

    // —— Step 11 · Phase 2：确定性提案通道（两条分支共用同一结果）——
    const proposalEvents = await buildProposalEvents({ patientId, agentId: agent.id, message })

    if (!modelReady()) {
      // 允许降级则走本地 mock 对话；ALLOW_MOCK_FALLBACK=false 时抛出，由下方 catch 转成 error 事件
      resolveFallback(`对话智能体「${agent.name}」`)
      const text = mockChat(agent.id, message, { executor, user: context.user || {} })
      for (const chunk of textChunks(text)) {
        sse.send({ type: 'token', text: chunk })
        await sleep(18)
      }
      for (const ev of proposalEvents) sse.send(ev)
      sse.send({ type: 'chat_done', degraded: true })
      return
    }

    const { toolsForAgent } = await import('./agents/tools.js')
    // Step 13 · 弱记忆：该患者过往诉求 + 医生最近结论（**只读**，见 data/agentMemory.js）。
    // 无记忆时 memoryPreamble 返回空串，被 filter(Boolean) 丢掉 —— 不往提示词里塞噪声。
    // 提示词块自身已声明「这是历史、可能过期、要当前值必须调工具」。
    const memoryBlock = memoryPreamble(context.user?.memory)
    const messages = [
      {
        role: 'system',
        content: [runtimePreamble(), agent.systemPrompt, memoryBlock, proposalReceiptForPrompt(proposalEvents)]
          .filter(Boolean)
          .join('\n\n'),
      },
      ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ]

    const result = await runToolLoop({
      messages,
      tools: toolsForAgent(agent),
      execute: executor.execute,
      signal: controller.signal,
      temperature: agent.id === 'companion' ? 0.85 : 0.6,
      maxRounds: 4,
      onToolCall: (record) => {
        sse.send({
          type: 'tool_call',
          agentId: agent.id,
          name: record.name,
          args: record.args,
          result: summarize(record.result),
        })
      },
    })

    if (!result.trace.length && result.content) {
      // 未触发工具，直接把已生成的答复分片下发，省一次模型调用
      for (const chunk of textChunks(result.content)) {
        sse.send({ type: 'token', text: chunk })
        await sleep(12)
      }
    } else {
      // 触发过工具：重新以流式方式生成最终答复，保证真·流式
      for await (const delta of chatStream({ messages: result.messages, signal: controller.signal })) {
        sse.send({ type: 'token', text: delta })
      }
    }
    for (const ev of proposalEvents) sse.send(ev)
    sse.send({ type: 'chat_done', degraded: false })
  } catch (err) {
    sse.send({ type: 'error', message: err.message })
  } finally {
    sse.end()
  }
})

/**
 * 多模态：图像解读（药盒 / 化验单 / 体检报告）
 * 优先走视觉模型；未配置时回退到前端 OCR 文本。
 * 入站只收 patientId（可选）—— 档案由后端经 dataProvider 自取，前端不回传 context。
 */
app.post('/api/vision/read', async (req, res) => {
  const { image, ocrText = '', hint = '' } = req.body || {}
  const patientId = resolveBodyPatientId(req.body)
  try {
    let context = {}
    if (patientId) context = await buildVisionContext(patientId)
    const result = await readImage({ image, ocrText, hint, context })
    res.json(result)
  } catch (err) {
    if (err?.code) return sendDataError(res, err)
    res.status(500).json({ error: err.message })
  }
})

function* textChunks(text, size = 6) {
  const s = String(text || '')
  for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size)
}

function summarize(result) {
  if (result === null || result === undefined) return null
  if (Array.isArray(result)) return `数组(${result.length} 项)`
  if (typeof result === 'object') {
    return Object.keys(result)
      .slice(0, 5)
      .map((k) => {
        const s = typeof result[k] === 'object' ? JSON.stringify(result[k]) : String(result[k])
        return `${k}: ${s.length > 50 ? `${s.slice(0, 50)}…` : s}`
      })
      .join('，')
  }
  return String(result)
}

/* --------------------- 生产环境：托管前端构建产物 --------------------- */
const distDir = path.join(rootDir, 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(config.port, () => {
  /* eslint-disable no-console */
  console.log(`\n  迈康 MyCare 智能体服务已启动`)
  console.log(`  → http://localhost:${config.port}`)
  console.log(
    `  模型：${
      isModelConfigured()
        ? config.model
        : config.allowMockFallback
          ? '未配置 Key，运行于本地推理引擎（降级模式）'
          : '⚠ 未配置 Key 且已禁用降级（ALLOW_MOCK_FALLBACK=false）→ 智能体接口将直接报错'
    }`
  )
  console.log(`  视觉：${config.visionApiKey ? config.visionModel : '未配置，图像走 OCR 通道'}\n`)
})
