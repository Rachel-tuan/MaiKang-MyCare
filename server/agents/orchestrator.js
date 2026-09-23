/**
 * 迈康 MyCare · 多智能体编排器
 *
 * 按 PIPELINE 拓扑依次唤醒智能体，上游结论作为下游输入，全过程以事件流形式对外输出，
 * 前端据此实时绘制「智能体协同过程」。
 *
 * 事件类型：
 *   run_start / agent_start / agent_thought / tool_call / agent_result / handoff / run_done / error
 */
import { AGENTS, PIPELINE, getAgent, runtimePreamble } from './registry.js'
import { createToolExecutor, toolsForAgent, toInternalLevel } from './tools.js'
import { ALERT_LEVEL } from '../../src/utils/clinicalRules.js'
import { isModelConfigured, resolveFallback, resolveFallbackOnError, runToolLoop, safeParseJSON } from '../deepseek.js'
import { mockAgentRun } from './mock.js'

/**
 * 把上游智能体的结论压缩成「交接提要」，让前端能看见到底交接了什么。
 * 只取每个智能体对下游真正有用的字段，不做整包透传。
 */
function summarizeForHandoff(agentId, result) {
  if (!result || typeof result !== 'object') return null
  const clip = (v, max = 28) => {
    const s = String(v ?? '')
    return s.length > max ? `${s.slice(0, max)}…` : s
  }
  switch (agentId) {
    case 'vitals': {
      const concerns = (result.concerns || []).slice(0, 2).map((c) => clip(c))
      return {
        指标样本数: result.indicators?.length ?? 0,
        主要风险项: concerns.length ? concerns : '未发现明显异常',
        结论: clip(result.summary, 40),
      }
    }
    case 'sentinel':
      return {
        最高风险等级: result.highestLevel,
        命中风险数: result.riskCount ?? (result.risks || []).length,
        通知对象: (result.notifyTargets || []).join(' / ') || 'self',
      }
    case 'planner':
      return {
        风险等级: result.riskLevel,
        运动建议: result.exercise
          ? `${result.exercise.type || ''} ${result.exercise.duration || ''}分钟`.trim()
          : '未给出',
        饮食要点数: (result.diet?.recommendations || []).length,
        目标步数: result.goals?.steps ?? '未设定',
      }
    default:
      return null
  }
}

/* 每个智能体的任务指令与输出契约（按场景分组，见下方 TASK_LIBRARY） */
const BRIEFING_TASKS = {  vitals: {
    task: '对用户全部体征指标执行统计分析，找出改善项与风险项。必须先调用 analyze_vital_trends 获取统计结果。',
    schema: `{"summary":"整体结论，80字以内","indicators":[{"indicator":"指标名","unit":"单位","mean":数值,"latest":数值,"trend":"上升/下降/平稳","达标率":"xx%","最长连续异常":数值}],"highlights":["改善点"],"concerns":["风险点"]}`,
  },
  sentinel: {
    task:
      '基于体征分析结论执行分级风险评估。产品预警等级只能使用「紧急 / 预警 / 关注 / 提示」，'
      + '严禁使用「高危 / 中危 / 低危」等医学危险分层术语；不得改写工具返回的阈值、等级与数值。',
    schema:
      `{"highestLevel":"紧急/预警/关注/提示","riskCount":数值,"risks":[{"level":"紧急/预警/关注/提示","title":"风险标题","basis":"判定依据（含具体数值）","action":"立即行动"}],"notifyTargets":["self"]}`,
  },
  planner: {
    task:
      '结合风险等级、用户疾病谱与生活画像，生成个性化干预方案。必须先调用 draft_intervention_plan，'
      + '并优先采用其中 personalization 字段给出的个性化措辞（如「主食以面食为主」→「先减少约 1/4 的精制面食」）。',
    schema:
      `{"riskLevel":"...","exercise":{"type":"","duration":数值,"frequency":"","intensity":"","note":""},"diet":{"restrictions":[],"recommendations":[]},"personalization":["个性化条目"],"medicationReminders":[{"name":"","time":"","tip":""}],"goals":{"steps":数值,"systolicTarget":"","diastolicTarget":"","bloodSugarTarget":"","weightTarget":"","recordStreak":""},"followUp":"","disclaimer":""}`,
  },
  steward: {
    task: '汇总上游三个智能体的结论，面向老年用户输出一份「今日健康简报」，并给出不超过 3 条、今天就能执行的行动清单。语气温和、句子短。',
    schema:
      `{"headline":"一句话结论（25字以内）","briefing":"简报正文（120字以内）","actions":[{"priority":"high/medium/low","time":"今天上午/今天/今晚","title":"行动标题","detail":"为什么做"}],"encouragement":"鼓励语（40字以内）","disclaimer":"免责提示"}`,
  },
}

/* ==================================================================== *
 * 场景二 · 健康方案协商（六智能体协同）
 * --------------------------------------------------------------------
 * 「个性化健康建议」页不再是前端一张静态模板，而是六个智能体按各自职责
 * 依次产出、相互交接后汇总成文：
 *   vitals（现状盘点）→ vision（用药/化验解读）→ sentinel（风险与运动禁忌）
 *   → planner（运动/饮食/用药方案主体）→ companion（坚持策略与鼓励）
 *   → steward（汇总成文）
 *
 * 红线（与全项目一致）：
 *   · 阈值、达标率、预警等级一律由工具（clinicalRules 派生）返回，模型不得改写；
 *   · 运动强度必须与风险等级匹配：命中「预警 / 紧急」时只给低强度并优先建议就医；
 *   · 用药只做提醒与注意事项，**不做剂量调整**，必须附「遵医嘱」提示；
 *   · 个性化建议必须引用该患者 lifestyle 的真实内容（不是泛泛而谈）。
 * ==================================================================== */
const CARE_PLAN_TASKS = {
  vitals: {
    task:
      '为「个性化健康建议」做现状盘点：统计这位患者近 7 天的全部体征指标，'
      + '指出哪些在改善、哪些仍在达标线之外。必须先调用 analyze_vital_trends 获取统计结果。',
    schema: `{"summary":"现状结论，80字以内","indicators":[{"indicator":"指标名","unit":"单位","mean":数值,"latest":数值,"trend":"上升/下降/平稳","达标率":"xx%","最长连续异常":数值}],"highlights":["改善点"],"concerns":["需要关注的点"]}`,
  },
  vision: {
    task:
      '解读这位患者正在服用的药物与已有化验结果，为方案规划提供用药侧依据：'
      + '逐条说明药物用途与需要留意的事项（如「可能引起干咳」「注意监测血钾」）。'
      + '没有用药或化验记录时，如实说明「暂无记录」，并建议在档案中补充，不得凭空编造。',
    schema: `{"summary":"用药与化验现状，80字以内","medications":[{"name":"药名","purpose":"用途","caution":"需要留意什么"}],"labNotes":["化验结果要点"],"warnings":["需要注意的用药风险"],"disclaimer":"免责提示"}`,
  },
  sentinel: {
    task:
      '基于体征盘点结论判定风险等级，并明确给出**运动与生活的禁忌**（哪些活动在当前状态下不宜做）。'
      + '产品预警等级只能使用「紧急 / 预警 / 关注 / 提示」，严禁使用「高危 / 中危 / 低危」等医学危险分层术语；'
      + '不得改写工具返回的阈值、等级与数值。',
    schema: `{"highestLevel":"紧急/预警/关注/提示","riskCount":数值,"risks":[{"level":"...","title":"风险标题","basis":"判定依据（含具体数值）","action":"立刻该做什么"}],"restrictions":["当前状态下不宜做的活动"],"notifyTargets":["self"]}`,
  },
  planner: {
    task:
      '综合体征盘点、风险等级与用药侧依据，生成「今天就能照着做」的运动 / 饮食 / 用药建议。'
      + '必须先调用 draft_intervention_plan，并优先采用其中 personalization 字段给出的个性化措辞'
      + '（如生活画像写「主食以面食为主」→「先减少约 1/4 的精制面食，换成杂粮面或搭配一份蔬菜」），'
      + '严禁输出「多运动」「清淡饮食」这类无法执行的空话。强度必须与风险等级匹配。',
    schema:
      `{"riskLevel":"...","exercise":{"type":"","duration":数值,"frequency":"","intensity":"","note":"执行要点与注意事项"},"diet":{"restrictions":[],"recommendations":[]},"personalization":["个性化条目"],"medicationReminders":[{"name":"","time":"","tip":""}],"goals":{"steps":数值,"systolicTarget":"","diastolicTarget":"","bloodSugarTarget":"","weightTarget":"","recordStreak":""},"followUp":"复诊或复查建议","disclaimer":""}`,
  },
  companion: {
    task:
      '面向这位老年患者写一段「坚持策略」：结合他真实的进展（连续记录天数、已改善的指标）给出具体鼓励，'
      + '并针对他自述的困难（lifestyle.biggestDifficulty）给出一个「做不到时的退路方案」。'
      + '语气温和、句子短，不要说教。',
    schema: `{"message":"给患者的一段话（100字以内）","encouragement":"鼓励语（40字以内）","habitTip":"一个最容易做到的小习惯","whenTired":"状态不好时的退路方案"}`,
  },
  steward: {
    task:
      '把上游五个智能体的结论汇总成一份**面向患者的个性化健康建议**：'
      + '先用一句话说清当前状态，再按「规律监测 / 运动 / 饮食 / 用药」四条给出要点，每条不超过 50 字，'
      + '最后附免责提示。要点必须来自上游结论，不得新增任何数据或阈值。',
    schema: `{"headline":"一句话结论（25字以内）","summary":"方案总述（130字以内）","keyPoints":[{"area":"监测/运动/饮食/用药","advice":"建议","why":"为什么"}],"encouragement":"鼓励语","disclaimer":"免责提示"}`,
  },
}

/* 场景 → 任务契约 / 协同拓扑 */
const TASK_LIBRARY = { briefing: BRIEFING_TASKS, carePlan: CARE_PLAN_TASKS }

/**
 * 健康方案协商拓扑：六个智能体全部参与。
 * vitals 与 vision 可并行（互不依赖），sentinel 依赖 vitals，
 * planner 依赖三者，companion 依赖 vitals，最后由 steward 汇总。
 */
export const CARE_PLAN_PIPELINE = [
  { id: 'vitals', label: '体征盘点', dependsOn: [] },
  { id: 'vision', label: '用药与化验解读', dependsOn: [] },
  { id: 'sentinel', label: '风险与禁忌', dependsOn: ['vitals'] },
  { id: 'planner', label: '个性化方案', dependsOn: ['vitals', 'sentinel', 'vision'] },
  { id: 'companion', label: '坚持策略', dependsOn: ['vitals'] },
  { id: 'steward', label: '汇总成文', dependsOn: ['vitals', 'sentinel', 'planner', 'companion'] },
]

const PIPELINES = { briefing: PIPELINE, carePlan: CARE_PLAN_PIPELINE }

/** 模型输出合法性的最小判据：至少出现一个契约里的标志字段（避免空对象被当成成功） */
const VALID_HINT_KEYS = ['summary', 'highestLevel', 'exercise', 'headline', 'message', 'encouragement']

/* ---------------------------- 异步事件通道 ---------------------------- */
function createChannel() {
  const queue = []
  let pending = null
  let closed = false
  return {
    push(value) {
      if (pending) {
        const resolve = pending
        pending = null
        resolve({ value, done: false })
      } else {
        queue.push(value)
      }
    },
    close() {
      closed = true
      if (pending) {
        const resolve = pending
        pending = null
        resolve({ value: undefined, done: true })
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            pending = resolve
          })
        },
      }
    },
  }
}

/* -------------------- 单个智能体的执行（含降级） -------------------- */
async function runSingleAgent({ agent, goal, context, dependencyOutputs, executor, emit, signal, taskSpec = null, scene = 'briefing' }) {
  const startedAt = Date.now()

  const depText = Object.entries(dependencyOutputs)
    .filter(([, v]) => v)
    .map(([id, v]) => `【${getAgent(id)?.name || id} 的结论】\n${JSON.stringify(v).slice(0, 2000)}`)
    .join('\n\n')

  const userPrompt = [
    `用户健康档案：${JSON.stringify({
      name: context.user?.name,
      age: context.user?.age,
      gender: context.user?.gender,
      bmi: context.user?.bmi,
      diseases: context.user?.disease_types,
      lifestyle: context.user?.lifestyle,
      medical: context.user?.medical,
    })}`,
    depText ? `上游智能体结论：\n${depText}` : '',
    `本次任务目标：${goal || '生成今日健康简报'}`,
    `你的任务：${taskSpec?.task || '完成你的职责。'}`,
    `【口径约束，必须遵守】
1. 产品预警等级只能使用「提示 / 关注 / 预警 / 紧急」，严禁使用「高危 / 中危 / 低危 / 重度 / 危象」等医学危险分层术语。
2. 医学诊断（如「原发性高血压 2 级」）与危险分层（如「中危」）属于医生侧表述，不得与产品预警等级混用。
3. 阈值、达标率、预警等级一律以工具返回结果为准，不得自行修改；体重变化不得表述为「脂肪减少」，不得使用「平台期」。
4. 个性化建议必须引用该用户 lifestyle 中的真实生活习惯。`,
    `请只输出如下结构的 JSON，不要包含任何解释文字：\n${taskSpec?.schema || '{}'}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  // —— 模型不可用 → 降级（或按 ALLOW_MOCK_FALLBACK=false 直接报错）——
  if (!isModelConfigured()) {
    // 允许降级则继续走 mock；禁用降级时在此抛出 ModelUnavailableError，交由上层转成 error 事件
    resolveFallback(`智能体「${agent.name}」`)
    const { thoughts, result } = await mockAgentRun(agent.id, { executor, user: context.user || {}, goal, scene })
    for (const t of thoughts) {
      emit({ type: 'agent_thought', agentId: agent.id, text: t })
      await sleep(160)
    }
    emit({ type: 'agent_result', agentId: agent.id, data: result, durationMs: Date.now() - startedAt, degraded: true })
    return result
  }

  // —— 真实模型：工具调用闭环 ——
  try {
    let thoughtBuffer = []
    const { content } = await runToolLoop({
      messages: [
        { role: 'system', content: `${runtimePreamble()}\n\n${agent.systemPrompt}` },
        { role: 'user', content: userPrompt },
      ],
      tools: toolsForAgent(agent),
      execute: executor.execute,
      signal,
      temperature: agent.id === 'companion' ? 0.8 : 0.4,
      maxRounds: 3,
      onToolCall: (record) => {
        thoughtBuffer.push(`调用工具 ${record.name}`)
        emit({
          type: 'tool_call',
          agentId: agent.id,
          name: record.name,
          args: record.args,
          result: summarizeToolResult(record.result),
          round: record.round,
        })
      },
    })

    const data = safeParseJSON(content)
    if (!data || !VALID_HINT_KEYS.some((k) => data[k])) {
      throw new Error('模型输出结构不符合预期')
    }
    emit({ type: 'agent_result', agentId: agent.id, data, durationMs: Date.now() - startedAt, degraded: false })
    return data
  } catch (err) {
    // 模型失败：默认降级兜住以保证流程不中断；ALLOW_MOCK_FALLBACK=false 时改为原样抛出真实错误
    resolveFallbackOnError(err)
    emit({ type: 'agent_thought', agentId: agent.id, text: `模型调用异常（${err.message}），切换本地推理引擎` })
    const { thoughts, result } = await mockAgentRun(agent.id, { executor, user: context.user || {}, goal, scene })
    for (const t of thoughts) emit({ type: 'agent_thought', agentId: agent.id, text: t })
    emit({ type: 'agent_result', agentId: agent.id, data: result, durationMs: Date.now() - startedAt, degraded: true })
    return result
  }
}

function summarizeToolResult(result) {
  if (result === null || result === undefined) return null
  if (Array.isArray(result)) return `数组(${result.length} 项)`
  if (typeof result === 'object') {
    const keys = Object.keys(result).slice(0, 5)
    return keys.map((k) => `${k}: ${shorten(result[k])}`).join('，')
  }
  return shorten(result)
}

function shorten(v) {
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ 主编排流程 ------------------------------ */
export async function* orchestrate({ context = {}, goal = '', signal, scene = 'briefing' } = {}) {
  const channel = createChannel()
  const runId = `run_${Date.now().toString(36)}`
  const results = {}
  /** 场景决定协同拓扑与任务契约：briefing = 四智能体晨报，carePlan = 六智能体方案协商 */
  const pipeline = PIPELINES[scene] || PIPELINE
  const taskLibrary = TASK_LIBRARY[scene] || BRIEFING_TASKS

  const producer = (async () => {
    const executor = createToolExecutor(context)
    try {
      channel.push({
        type: 'run_start',
        runId,
        goal: goal || '生成今日健康简报与干预方案',
        agents: pipeline.map((s) => s.id),
        pipeline,
        scene,
        model: isModelConfigured() ? 'deepseek' : 'local-engine',
        startedAt: new Date().toISOString(),
      })

      for (const step of pipeline) {
        if (signal?.aborted) break
        const agent = getAgent(step.id)
        if (!agent) continue

        channel.push({
          type: 'agent_start',
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          icon: agent.icon,
          color: agent.color,
          dependsOn: step.dependsOn,
          startedAt: new Date().toISOString(),
        })

        const dependencyOutputs = Object.fromEntries(step.dependsOn.map((id) => [id, results[id]]))
        if (step.dependsOn.length) {
          // 交接提要：把上游结论中下游真正需要的信息显式列出来
          const digest = {}
          for (const id of step.dependsOn) {
            const s = summarizeForHandoff(id, results[id])
            if (s) digest[getAgent(id)?.name || id] = s
          }
          channel.push({
            type: 'handoff',
            from: step.dependsOn,
            to: step.id,
            reason: `${agent.name} 已接收 ${step.dependsOn.map((d) => getAgent(d)?.name).join('、')} 的输出`,
            payload: digest,
          })
        }

        const result = await runSingleAgent({
          agent,
          goal,
          context,
          dependencyOutputs,
          executor,
          emit: (e) => channel.push({ ...e, runId }),
          signal,
          taskSpec: taskLibrary[agent.id] || null,
          scene,
        })
        results[agent.id] = result
        channel.push({ type: 'agent_done', agentId: agent.id })
      }

      // —— 安全兜底：预警及以上必须留下预警记录 ——
      // 是否调用 raise_alert 由模型自主判断，但医疗场景不允许「已触发预警却无记录」，
      // 因此当产品预警等级达到「预警 / 紧急」而模型未触发预警时，由确定性规则补齐。
      //
      // Step 11 · D-2 之后：`risk.highestLevel` 与 `risk.risks[].level` **已是产品键位**
      // （info / watch / alert / emergency），全部来自 clinicalRules —— 此处不再做任何
      // 键位翻译式判定，也不引入第二套阈值。对外一律使用产品预警词表，
      // 不使用「高危 / 中危」等医学危险分层术语。
      const risk = executor.risk()
      const needAlert = [ALERT_LEVEL.emergency.key, ALERT_LEVEL.alert.key].includes(risk?.highestLevel)
      if (needAlert && executor.effects.alerts.length === 0) {
        const auto = (risk.risks || []).filter((r) =>
          [ALERT_LEVEL.emergency.key, ALERT_LEVEL.alert.key].includes(r.level),
        )
        for (const r of auto.slice(0, 3)) {
          await executor.execute('raise_alert', {
            // raise_alert 的入参契约沿用内部键位（模型可见 schema 不变），此处只做键名翻译
            level: toInternalLevel(r.level),
            title: r.title,
            detail: r.detail,
            action: r.action,
            // 紧急 → 通知家人与医生；预警 → 仅通知家人。外部通知仍受「已授权 + 用户确认」约束。
            notify:
              r.level === ALERT_LEVEL.emergency.key ? ['self', 'family', 'doctor'] : ['self', 'family'],
          })
        }
        const first = auto[0]
        if (first) {
          results.sentinel = {
            ...(results.sentinel || {}),
            __autoPatched: true,
            note: '产品预警等级达到预警及以上，模型未触发预警，已由确定性规则补齐预警记录',
          }
        }
      }

      // —— 汇总副作用 ——
      channel.push({
        type: 'run_done',
        runId,
        scene,
        summary: results.steward || results.vitals || {},
        alerts: executor.effects.alerts,
        reminders: executor.effects.reminders,
        analysis: results.vitals?.indicators || [],
        risk: results.sentinel || null,
        plan: results.planner || null,
        /**
         * 健康方案协商的成品：**只做字段归位，不做任何再生成**。
         * 每一条都带来源智能体，前端据此标注「这段是谁说的」。
         */
        carePlan:
          scene === 'carePlan'
            ? {
                headline: results.steward?.headline ?? null,
                summary: results.steward?.summary ?? null,
                keyPoints: results.steward?.keyPoints ?? [],
                encouragement: results.steward?.encouragement ?? results.companion?.encouragement ?? null,
                disclaimer: results.steward?.disclaimer ?? results.planner?.disclaimer ?? null,
                riskLevel: results.sentinel?.highestLevel ?? null,
                restrictions: results.sentinel?.restrictions ?? [],
                status: results.vitals ?? null,
                medication: results.vision ?? null,
                plan: results.planner ?? null,
                companion: results.companion ?? null,
                byAgent: pipeline.map((s) => s.id),
              }
            : null,
        model: isModelConfigured() ? 'deepseek' : 'local-engine',
        finishedAt: new Date().toISOString(),
      })
    } catch (err) {
      channel.push({ type: 'error', runId, message: err.message })
    } finally {
      channel.close()
    }
  })()

  for await (const event of channel) {
    yield event
  }
  await producer
}

/* ------------------------------ 对话能力 ------------------------------ */
export { AGENTS, PIPELINE, getAgent }
