/**
 * 迈康 MyCare · 任务调整「提案意图」确定性通道（Step 11 · Phase 2）
 * ===========================================================================
 * 为什么必须是**确定性通道**（F-7，原方案漏项）：
 *   无模型环境（未配 DEEPSEEK_API_KEY）下 `/api/agent/chat` 走 `mockChat` 降级分支，
 *   **不经过 runToolLoop**。若把提案识别挂在「模型工具调用」上，答辩环境里
 *   整条「对话 → 医生审核」链路**根本不会触发**。
 *   因此：识别 = 关键词预筛 + 结构化抽取（本文件，零模型依赖）；
 *         有模型时，模型只用来把 `reason` 措辞得更自然（本版未启用，保持确定性）。
 *
 * 五步流水线（与方案 §2.2 一一对应）：
 *   ① 关键词 / 正则预筛（零成本，不命中即返回）
 *   ② 命中 → 结构化抽取 `taskId / field / proposedValue`
 *   ③ `currentValue` ← **后端** `getEffectiveTaskState()` 注入（模型返回值一律丢弃）
 *   ④ 逐条过 `validateOverridePackage()` —— 阈值字段 / 停用监测项 / 未生成任务 /
 *      范围越界一律**逐条过滤、不生成提案**（绝不让非法项进库）
 *   ⑤ 单轮 ≤2 条 + 同域去重
 *
 * 两类候选（`type` 字段区分）：
 *   · `override`        —— 改「规则已生成任务」的参数（target / slots），过覆盖契约校验；
 *   · `monitor_request` —— 患者希望**新增一个当前未生成的监测域**（如非糖尿病患者
 *                          提出「每天监测血糖」）。覆盖层**无权新建任务域**，但该类诉求
 *                          必须送达医生 —— 故不带 proposedValue，只作为一张申请单推送。
 *
 * 红线：本文件**不写库**，也**不引用** `applyOverridePackage()`。
 *      它只负责产出候选，落库由 `proposalService.createOrUpdateProposal()` 完成。
 */
import { ADDABLE_TASK_IDS, validateOverridePackage } from '../../src/utils/taskOverride.js'
import { PROPOSAL_MAX_PER_TURN } from '../data/proposalService.js'

/* ------------------------------------------------------------------ *
 * 词表（只在此处定义，UI / 服务端不得各处自行拼字）
 * ------------------------------------------------------------------ */

/** 时段口语别名 → 落库枚举（必须落在 BP_SLOT_OPTIONS 内） */
const BP_SLOT_ALIAS = Object.freeze([
  { re: /晨起|早上|清晨|早晨|早起|起床后/, slot: '晨起' },
  { re: /上午/, slot: '上午' },
  { re: /下午|午后|傍晚/, slot: '下午' },
  { re: /睡前|晚上|临睡前|临睡|睡觉前|夜里/, slot: '睡前' },
])

/** 血糖口语别名 → 落库枚举（必须落在 GLUCOSE_MEASURE_TYPES 内） */
const BG_SLOT_ALIAS = Object.freeze([
  { re: /餐后\s*2\s*(?:小时|h|H)?|饭后\s*2\s*(?:小时|h|H)?|餐后2h/, slot: '餐后2h' },
  { re: /空腹|饭前|早餐前/, slot: '空腹' },
  { re: /随机/, slot: '随机' },
  { re: /睡前|晚上|临睡前|临睡/, slot: '睡前' },
])

const STEP_MENTION = /步数|走路|散步|步行|每天走|走不动|走不了|走不下来|走不完|膝盖|关节|腿疼|腿脚/
const STEP_HARD = /走不动|走不了|走不下来|走不完|膝盖|关节|腿疼|腿脚|吃力|疼|减少|少走|降低|下调|减量/
const STEP_EXPLICIT = /(?:降到|减到|下调到|下调至|改到|改成|改为|控制在|减少到|只能走|只能|每天走)\s*(\d{3,5})\s*步?/

const EXERCISE_MENTION = /运动|锻炼|快走|慢跑|太极|健身|康复操|活动量/
const EXERCISE_HARD = /做不了|做不动|吃力|累|减少|少|降低|下调|缩短/
const EXERCISE_EXPLICIT = /(?:降到|减到|下调到|改到|改成|改为|调整到|增加到|提高到|控制在|每次|每天)\s*(\d{1,3})\s*分钟/

const STOP_INTENT = /不想测|不测了|不想量|不量了|停掉|取消|不用测|不用量|别再提醒|不想再|不想记录|去掉|不想每天/
const TARGET_INTENT = /目标|控制到|控制在|降到|减到|改到|改成|低于|以下|不超过/

/**
 * 「希望新增监测项」的诉求（Step 11 · Phase 2 · 2026-09-17 补充）
 * ---------------------------------------------------------------------------
 * 场景：非糖尿病患者在对话里说「我还想每天监测一下血糖，毕竟年纪老了」。
 * 该诉求**不在参数覆盖的能力范围内** —— 覆盖层只能改「规则已生成的任务」的参数
 * （见 taskOverride.js 红线 1），而血糖监测任务由**主诊断**派生。
 *
 * 这一类诉求恰恰是**最需要医生介入**的：是否新增日常监测属于医学判断。
 * 因此不生成覆盖型提案，而生成一张 `monitor_request` **申请单**推给医生审核。
 * ⚠️ Step 12 语义（用户确认「同意即启用并计入评分」）：医生「同意」后该监测域**才真正启用** ——
 * 写入覆盖包的 `addedTasks`，患者端立即出现该任务并计入当日评分适用维度；
 * **医生审结之前患者端一个字都不变**。本条通道自身仍然只写 is_active=0 的申请行。
 *
 * ⚠️ 可申请范围必须与**审批侧的能力同源**：只有 `ADDABLE_TASK_IDS`（白名单）内的域，
 * 医生同意时才可能真正启用。白名单之外的域（如 `weight_record` 无时段结构）即便推给医生，
 * 审结也必然失败 —— 故此处直接不生成申请，避免出现「医生无法处理却躺在待审列表里」的单子。
 * 智能体仍会如实回复「本轮系统没有新增或改动任何任务」（回执提示词保证，见 index.js）。
 *
 * 识别要求「指标词 + 新增/关注意图」同时出现，避免把「我血糖还行」误判成申请。
 */
const MONITOR_SUBJECT = Object.freeze([
  { re: /血糖|餐后血糖|空腹血糖|测糖/, taskId: 'bg_monitor', label: '血糖' },
  { re: /血压/, taskId: 'bp_monitor', label: '血压' },
  { re: /体重|称重/, taskId: 'weight_record', label: '体重' },
])

/** 新增/纳入意图（必须与指标词同现） */
const ADD_INTENT = /加上|增加|新增|添加|也要|也想|还想|想要|纳入|加入|多测|多量|每天测|每日测|监测一下|关注一下|也测|也量/

const STEPS_MIN = 1000
const STEPS_MAX = 20000
const STEP_UNIT = 500
const EXERCISE_MIN = 5
const EXERCISE_MAX = 180

/** 过滤用的固定依据（≥4 字即可；真正的依据由医生审核时确认） */
const INTENT_BASIS = '患者在与方案规划智能体的对话中提出了今日任务调整申请'

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 对齐 500 的整数倍并夹到合法区间（步数目标必须是 500 的倍数） */
export function alignStepsTarget(n) {
  const v = Math.round(Number(n) / STEP_UNIT) * STEP_UNIT
  return Math.max(STEPS_MIN, Math.min(STEPS_MAX, v))
}

/**
 * 文本 → 命中到的时段枚举（**按在原文中出现的位置排序**，去重）。
 * 排序不可省：「血糖改成空腹和餐后2小时」必须得到 ['空腹','餐后2h']，
 * 而词表顺序恰好是反的 —— 按词表顺序输出会让展示顺序与患者表述不一致。
 */
function matchSlots(text, alias) {
  const hits = []
  for (const { re, slot } of alias) {
    const idx = String(text).search(re)
    if (idx >= 0 && !hits.some((h) => h.slot === slot)) hits.push({ slot, idx })
  }
  return hits.sort((a, b) => a.idx - b.idx).map((h) => h.slot)
}

/** 按句读切分（阈值判定必须在**同一子句内**，否则「步数降到 5000」会被误算到血压头上） */
const splitClauses = (text) => String(text || '').split(/[，,。；;！!？?\n]/).filter((s) => s.trim())

const firstNumber = (text, re) => {
  const m = String(text || '').match(re)
  return m ? Number(m[1]) : null
}

/* ------------------------------------------------------------------ *
 * ① ② 抽取：每类意图一个纯函数，返回候选或 null
 * ------------------------------------------------------------------ */

function detectSteps(text, task) {
  if (!STEP_MENTION.test(text)) return null
  const current = Number.isInteger(task?.target) ? task.target : null

  const explicit = firstNumber(text, STEP_EXPLICIT)
  if (explicit != null) {
    const next = alignStepsTarget(explicit)
    if (next !== current) {
      return {
        taskId: 'steps',
        field: 'target',
        proposedValue: next,
        reason: `患者希望把每日步数目标调整为 ${next} 步`,
        evidence: [`患者原话：${text.slice(0, 80)}`],
      }
    }
    return null
  }

  // 困难陈述（无明确新值）→ 按当前目标下调约 1/4，并对齐 500
  if (STEP_HARD.test(text) && current) {
    const next = alignStepsTarget(current * 0.75)
    if (next !== current) {
      return {
        taskId: 'steps',
        field: 'target',
        proposedValue: next,
        reason: `患者自述行动受限，请求下调每日步数目标（当前 ${current} 步）`,
        evidence: [`患者原话：${text.slice(0, 80)}`],
      }
    }
  }
  return null
}

function detectExercise(text, task) {
  if (!EXERCISE_MENTION.test(text)) return null
  const current = Number.isInteger(task?.target) ? task.target : null

  const explicit = firstNumber(text, EXERCISE_EXPLICIT)
  if (explicit != null && explicit >= EXERCISE_MIN && explicit <= EXERCISE_MAX && explicit !== current) {
    return {
      taskId: 'exercise',
      field: 'target',
      proposedValue: explicit,
      reason: `患者希望把每日运动时长调整为 ${explicit} 分钟`,
      evidence: [`患者原话：${text.slice(0, 80)}`],
    }
  }

  if (EXERCISE_HARD.test(text) && current) {
    const next = Math.max(EXERCISE_MIN, Math.round(current * 0.75))
    if (next !== current) {
      return {
        taskId: 'exercise',
        field: 'target',
        proposedValue: next,
        reason: `患者自述运动吃力，请求下调运动时长（当前 ${current} 分钟）`,
        evidence: [`患者原话：${text.slice(0, 80)}`],
      }
    }
  }
  return null
}

function detectBpSlots(text) {
  if (!/血压/.test(text)) return null
  const slots = matchSlots(text, BP_SLOT_ALIAS)
  if (!slots.length) return null
  return {
    taskId: 'bp_monitor',
    field: 'slots',
    proposedValue: slots,
    reason: `患者希望把血压测量时段调整为「${slots.join('、')}」`,
    evidence: [`患者原话：${text.slice(0, 80)}`],
  }
}

function detectBgSlots(text) {
  if (!/血糖/.test(text)) return null
  const slots = matchSlots(text, BG_SLOT_ALIAS)
  if (!slots.length) return null
  return {
    taskId: 'bg_monitor',
    field: 'slots',
    proposedValue: slots,
    reason: `患者希望把血糖测量时段调整为「${slots.join('、')}」`,
    evidence: [`患者原话：${text.slice(0, 80)}`],
  }
}

/**
 * 新增监测项申请 —— 只有当该任务域**当前并未生成**时才成立。
 * 域已生成时患者提的必然是「改时段 / 改目标」，交给上面的 override 通道，不重复出申请。
 */
function detectMonitorRequest(text, ctx = {}) {
  if (!ADD_INTENT.test(text)) return null
  const generated = Array.isArray(ctx?.generatedTaskIds) ? ctx.generatedTaskIds : []
  const hit = MONITOR_SUBJECT.find((s) => s.re.test(text))
  if (!hit) return null
  if (generated.includes(hit.taskId)) return null
  // 白名单之外（如 weight_record：无时段结构，审批侧无法启用）→ 不生成申请单。
  // 宁可如实告知「需要医生判断」，也不推一张审结必然失败的单子给医生。
  if (!ADDABLE_TASK_IDS.includes(hit.taskId)) return null
  return {
    type: 'monitor_request',
    taskId: hit.taskId,
    field: 'task',
    label: hit.label,
    reason: `患者希望新增「${hit.label}」日常监测（当前任务由诊断派生，是否纳入需医生判断）`,
    evidence: [`患者原话：${text.slice(0, 80)}`],
  }
}

/** 停用意图 → 必然被过滤（D4：第一版整体不接受 enabled=false），但必须被识别出来计入 filtered */
function detectDisable(text) {
  if (!STOP_INTENT.test(text)) return []
  const out = []
  if (/血压/.test(text)) {
    out.push({
      taskId: 'bp_monitor',
      field: 'enabled',
      proposedValue: false,
      reason: '患者希望停用血压监测',
      evidence: [`患者原话：${text.slice(0, 80)}`],
    })
  }
  if (/血糖/.test(text)) {
    out.push({
      taskId: 'bg_monitor',
      field: 'enabled',
      proposedValue: false,
      reason: '患者希望停用血糖监测',
      evidence: [`患者原话：${text.slice(0, 80)}`],
    })
  }
  return out
}

/**
 * 阈值意图 → 必然被过滤（医学阈值不得被 AI 或覆盖层触碰）。
 *
 * ⚠️ 判定必须**限定在同一子句内**且数字**紧跟意图词**：
 *   反例「血压监测时段改成晨起和睡前，步数降到 5000」——
 *   若整句扫数字，会把 5000（步数）错算成血压阈值，凭空多出一条 filtered 记录。
 */
function detectThreshold(text) {
  const out = []
  for (const clause of splitClauses(text)) {
    const isBp = /血压/.test(clause)
    const isBg = /血糖/.test(clause)
    if (!isBp && !isBg) continue
    const m = clause.match(TARGET_INTENT)
    if (!m) continue
    const value = firstNumber(clause, /(?:目标|控制到|控制在|降到|减到|低于|不超过|以下|改成|改为|调整到|调到)[^\d]{0,8}?(\d{2,3}(?:\.\d)?)/)
    if (value == null) continue
    if (isBp) {
      out.push({
        taskId: 'bp_monitor',
        field: 'systolic_target',
        proposedValue: value,
        reason: '患者希望调整血压控制目标（属医学阈值）',
        evidence: [`患者原话：${clause.slice(0, 80)}`],
      })
    }
    if (isBg) {
      out.push({
        taskId: 'bg_monitor',
        field: 'fasting_glucose_target',
        proposedValue: value,
        reason: '患者希望调整血糖控制目标（属医学阈值）',
        evidence: [`患者原话：${clause.slice(0, 80)}`],
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * ④ ⑤ 过滤 + 注入
 * ------------------------------------------------------------------ */

/**
 * 从一句话里识别出**可落库**的任务调整提案。
 *
 * @param {object} p
 * @param {string} p.message         患者原话
 * @param {object} p.state           `getEffectiveTaskState()` 的结果（currentValue 唯一可信来源）
 * @param {object} p.ctx             `{ generatedTaskIds, primaryDisease, diseases }`
 * @returns {{ proposals:Array, filtered:Array }}
 */
export function detectProposalCandidates({ message = '', state = {}, ctx = {} } = {}) {
  const text = String(message || '')
  if (!text.trim() || !state || !Array.isArray(state.tasks)) {
    return { proposals: [], filtered: [] }
  }

  const taskOf = (taskId) => state.tasks.find((t) => t.taskId === taskId) || null

  /* ⓪ 申请型：希望新增一个**当前未生成**的监测域
     —— 必须排在覆盖型之前：一旦某个域被判定为「需要新增」，
        它本来就不在 state.tasks 里，后面的 taskOf() 取不到、也不会重复产出。 */
  const monitorRequests = [detectMonitorRequest(text, ctx)]
    .filter(Boolean)
    .map((c) => ({
      type: 'monitor_request',
      taskId: c.taskId,
      field: 'task',
      label: c.label,
      currentValue: null,
      currentValueSource: 'not_generated',
      proposedValue: null,
      reason: c.reason,
      evidence: c.evidence,
    }))

  // ① ② 抽取（顺序即优先级）
  const detected = [
    detectSteps(text, taskOf('steps')),
    detectExercise(text, taskOf('exercise')),
    detectBpSlots(text),
    detectBgSlots(text),
    ...detectDisable(text),
    ...detectThreshold(text),
  ].filter(Boolean)

  // 同域同字段去重（先出现的优先）
  const seen = new Set()
  const deduped = []
  for (const c of detected) {
    const key = `${c.taskId}::${c.field}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(c)
  }

  // ④ 逐条过滤：不合法的**不生成提案**（绝不进库）
  const proposals = []
  const filtered = []
  for (const c of deduped) {
    const raw = { [c.taskId]: { [c.field]: c.proposedValue } }
    const verdict = validateOverridePackage({ overrides: raw, basis: INTENT_BASIS }, ctx)
    if (!verdict.ok) {
      filtered.push({ taskId: c.taskId, field: c.field, code: verdict.code, message: verdict.errors?.[0]?.message ?? null })
      continue
    }

    // ③ currentValue 由后端注入 —— 模型若返回过 currentValue，早已在上层被丢弃
    const task = taskOf(c.taskId)
    const currentValue = c.field === 'slots' ? (task?.slots || []).map((s) => s.slot) : (task?.target ?? null)

    proposals.push({
      type: 'override',
      taskId: c.taskId,
      field: c.field,
      currentValue,
      currentValueSource: 'effective_task_state',
      proposedValue: verdict.normalized.overrides[c.taskId][c.field],
      reason: c.reason,
      evidence: c.evidence,
    })
  }

  // ⑤ 单轮 ≤2 条（申请型排在最前：患者明确表达的新增诉求优先于参数微调）
  const merged = [...monitorRequests, ...proposals.filter((p) => !monitorRequests.some((m) => m.taskId === p.taskId))]
  return {
    proposals: merged.slice(0, PROPOSAL_MAX_PER_TURN),
    filtered: filtered.slice(0, 8),
  }
}

/**
 * 端到端：识别 → 落库（两条对话分支共用，降级模式同样生效）。
 *
 * @returns {Promise<{proposalIds:string[], created:Array, updated:Array, proposals:Array, filtered:Array}|null>}
 */
export async function runProposalChannel({ patientId, agentId = 'planner', message, state, ctx, createOrUpdate }) {
  if (!patientId || typeof createOrUpdate !== 'function') return null
  const { proposals, filtered } = detectProposalCandidates({ message, state, ctx })
  if (!proposals.length) {
    return filtered.length ? { proposalIds: [], created: [], updated: [], proposals: [], filtered } : null
  }
  const result = createOrUpdate({ patientId, agentId, utterance: message, proposals })
  const proposalIds = [...result.created, ...result.updated].map((x) => x.proposalId)
  return { ...result, proposalIds, proposals, filtered }
}
