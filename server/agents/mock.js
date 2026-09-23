/**
 * 迈康 MyCare · 无模型降级实现
 *
 * 未配置 DEEPSEEK_API_KEY 或模型调用失败时启用。
 * 关键点：降级模式下【分析算法仍然真实执行】（趋势拟合、风险判定、建议生成都跑真代码），
 * 只有「自然语言生成」这一层退化为模板。因此演示效果依旧成立，且不会伪造数据。
 */

// 产品预警等级词表（提示 / 关注 / 预警 / 紧急）—— **唯一来源 clinicalRules 的 ALERT_LEVEL**
// （Step 11 · D-2 之后不再在本文件里另存一份标签表）
import { ALERT_LEVEL } from '../../src/utils/clinicalRules.js'
import { toInternalLevel } from './tools.js'

const levelLabelOf = (key) => ALERT_LEVEL[key]?.label || '提示'
const ARROW = { rising: '↑', falling: '↓', stable: '→' }

function trendWord(a) {
  if (a.direction === 'stable') return '平稳'
  const dir = a.direction === 'rising' ? '上升' : '下降'
  return `${dir}${ARROW[a.direction]}`
}

export async function mockAgentRun(agentId, { executor, user = {}, goal = '', scene = 'briefing' }) {
  const analysis = executor.analysis()
  const risk = executor.risk()
  const carePlan = scene === 'carePlan'

  switch (agentId) {
    case 'vitals': {
      const highlights = analysis
        .filter((a) => a.improving === true)
        .map((a) => `${a.label}呈改善趋势（${a.first} → ${a.latest} ${a.unit}）`)
      const concerns = analysis
        .filter((a) => a.dangerDays > 0 || a.longestAbnormalDays >= 3)
        .map((a) => `${a.label}存在异常：${a.dangerDays} 次超警戒、最长连续 ${a.longestAbnormalDays} 天未达标`)

      const n = analysis[0]?.sampleCount ?? 0
      return {
        thoughts: [
          `读取到最近 ${n} 天的体征记录，共 ${analysis.length} 项指标可分析`,
          '正在对各指标执行最小二乘趋势拟合与达标率统计',
          '交叉比对血压与体重、睡眠与血糖之间的关联',
        ],
        result: {
          summary:
            `已完成 ${analysis.length} 项指标的统计分析，数据窗口 ${n} 天。` +
            (concerns.length ? `发现 ${concerns.length} 项需要关注的异常。` : '整体无明显异常。'),
          indicators: analysis.map((a) => ({
            indicator: a.label,
            unit: a.unit,
            mean: a.mean,
            latest: a.latest,
            trend: trendWord(a),
            达标率: `${a.complianceRate}%`,
            最长连续异常: a.longestAbnormalDays,
          })),
          highlights,
          concerns,
        },
      }
    }

    case 'sentinel': {
      // risk.highestLevel / risk.risks[].level 均为产品键（Step 11 · D-2 统一后）
      const notifyTargets =
        risk.highestLevel === 'emergency' ? ['self', 'family', 'doctor']
        : risk.highestLevel === 'alert' ? ['self', 'family']
        : ['self']

      // 产品预警等级达到「预警 / 紧急」→ 真实触发预警记录
      // 走 raise_alert 工具，与真实模型行为一致；对外通知仍受「已授权 + 用户确认」约束
      if (['alert', 'emergency'].includes(risk.highestLevel)) {
        for (const r of risk.risks.filter((x) => ['alert', 'emergency'].includes(x.level)).slice(0, 2)) {
          await executor.execute('raise_alert', {
            level: toInternalLevel(r.level),
            title: r.title,
            detail: r.detail,
            action: r.action,
            notify: notifyTargets,
          })
        }
      }

      return {
        thoughts: [
          `按确定性规则判定，产品预警等级为「${levelLabelOf(risk.highestLevel)}」`,
          `关注及以上命中 ${risk.risks.length} 条规则`,
          ['alert', 'emergency'].includes(risk.highestLevel)
            ? '已生成预警记录；通知家属或医生需用户已授权并由本人点击确认后才会外发'
            : '未达到预警等级，无需生成预警记录',
        ],
        result: {
          highestLevel: levelLabelOf(risk.highestLevel),
          riskCount: risk.risks.length,
          risks: risk.risks.map((r) => ({
            level: levelLabelOf(r.level),
            title: r.title,
            basis: r.detail,
            action: r.action,
          })),
          notifyTargets,
        },
      }
    }

    case 'planner': {
      // draft_intervention_plan 内部已把用药提醒确定性写入提醒队列（方案 → 执行的闭环），
      // 此处不再重复登记，避免同一用药提醒出现两次。
      const p = await executor.execute('draft_intervention_plan', {})
      return {
        thoughts: [
          `结合疾病谱（${(user.disease_types || []).join('、') || '无特殊'}）与风险等级「${levelLabelOf(risk.highestLevel)}」匹配方案模板`,
          '按年龄与 BMI 调整运动强度，避免高风险期过度运动',
          `已把 ${p.medicationReminders?.length || 0} 条用药提醒写入提醒队列`,
        ],
        result: p,
      }
    }

    /* ---- 以下两个分支服务于「健康方案协商」场景（六智能体协同）---- */
    case 'vision': {
      const meds = Array.isArray(user.medications) ? user.medications : []
      const diseases = user.disease_types || []
      const cautions = []
      if (diseases.some((d) => String(d).includes('高血压'))) {
        cautions.push('服药期间按今日任务测量血压；出现头晕、乏力、起身发黑时先坐下休息，并记录下来告诉医生')
      }
      if (diseases.some((d) => String(d).includes('糖尿病'))) {
        cautions.push('降糖药与进食时间相关，漏餐时不要自行加药；出现心慌、出冷汗要及时测血糖')
      }
      return {
        thoughts: [
          meds.length ? `读取到 ${meds.length} 条在用药物记录` : '档案中暂无用药记录',
          '按病种匹配需要留意的用药事项（本平台不做任何剂量判断）',
          '整理化验结果要点，供方案规划智能体使用',
        ],
        result: {
          summary: meds.length
            ? `目前登记在用的药物 ${meds.length} 种，具体用法用量以医生处方为准。`
            : '档案中暂无用药记录。如果您正在服药，建议在「我的 → 我的健康档案」中补充，建议会更贴合您本人。',
          medications: meds.map((m) => ({
            name: m.name,
            purpose: '长期管理用药（具体适应症以医生处方为准）',
            caution: `${m.dosage || ''}${m.time ? ` · ${m.time}` : ''} 按医嘱服用，不自行增减或停药`.trim(),
          })),
          labNotes: [],
          warnings: cautions,
          disclaimer: '以上为用药提醒，不构成用药调整建议；任何剂量变化请遵医嘱。',
        },
      }
    }

    case 'companion': {
      const lf = user.lifestyle || {}
      const improving = analysis.filter((a) => a.improving === true)
      const streak = analysis[0]?.sampleCount ?? 0
      const difficulty = lf.biggestDifficulty || ''
      return {
        thoughts: [
          `数据窗口 ${streak} 天，先肯定已经做到的部分`,
          improving.length ? `找出真实改善：${improving[0].label}` : '找一件最容易做到的小事作为突破口',
          difficulty ? `针对自述困难「${difficulty}」准备退路方案` : '准备状态不好时的退路方案',
        ],
        result: {
          message:
            `这 ${streak} 天的记录说明您在认真对待自己的身体。` +
            (improving.length ? `${improving[0].label}在往好的方向走，` : '') +
            '咱们不追求一天做到完美，做到一半也算数。',
          encouragement: '坚持记录本身就是最有效的干预，您已经开始了。',
          habitTip: '睡前把血压计放到床头，早上醒来顺手就测，不用特意记着。',
          whenTired: difficulty
            ? '实在不想动的时候，就只做最低限度的部分：量一次血压、把数字记下来，其余今天可以不管。'
            : '状态不好的那天，只保留「量一次血压并记录」，其它任务可以明天再补。',
        },
      }
    }

    case 'steward': {
      const top = risk.risks[0]
      // 生活画像 → 个性化行动（v2 要求：画像必须真正进入建议逻辑）
      const personalization = (executor.rules?.().personalization || []).map((p) => p.text)
      const actions = []

      /* ---- 健康方案协商：汇总成一份面向患者的建议（六智能体协同的终点）---- */
      if (carePlan) {
        const levelText = levelLabelOf(risk.highestLevel)
        const stepSeries = analysis.find((a) => a.key === 'steps')
        const bpSeries = analysis.find((a) => a.key === 'systolic') || analysis.find((a) => a.key === 'blood_pressure')
        const meds = Array.isArray(user.medications) ? user.medications : []
        const keyPoints = [
          {
            area: '监测',
            advice: bpSeries
              ? `按今日任务记录血压（近 7 天均值 ${bpSeries.mean} ${bpSeries.unit}）`
              : '按今日任务完成监测并记录',
            why: `当前产品预警等级：${levelText}`,
          },
          personalization.length
            ? { area: '饮食', advice: personalization[0], why: '根据您自述的日常饮食习惯给出' }
            : { area: '饮食', advice: '每餐先吃蔬菜再吃主食，吃到八分饱', why: '最容易做到的一条饮食调整' },
          {
            area: '运动',
            advice: stepSeries ? `每天散步，目标 ${stepSeries.target} 步` : '每天散步 30 分钟',
            why: '慢病管理的基础运动量',
          },
        ]
        if (meds.length) {
          keyPoints.push({
            area: '用药',
            advice: `按时服用 ${meds.map((m) => m.name).join('、')}`,
            why: '已在健康档案中登记的用药计划',
          })
        }
        return {
          thoughts: [
            '汇总体征盘点、风险与禁忌、用药解读、个性化方案、坚持策略五个上游结论',
            '按「监测 / 运动 / 饮食 / 用药」四条整理要点，不新增任何数据或阈值',
            '附医嘱提示，明确本建议不能替代医生诊断',
          ],
          result: {
            headline:
              risk.highestLevel === 'emergency' ? '出现危险值，请先处理预警项'
              : risk.highestLevel === 'alert' ? '有指标需要重点关注，建议近期复诊'
              : risk.highestLevel === 'watch' ? '整体可控，个别指标需留意'
              : '指标平稳，按当前节奏继续保持',
            summary:
              `本次由六个智能体协同完成：${analysis.length} 项体征盘点、${risk.risks.length} 条规则命中、` +
              `${meds.length} 种在用药物解读，并形成了个性化建议。当前产品预警等级：${levelText}。`,
            keyPoints,
            encouragement: '您已经在这条路上了，一次做一点，比一次做很多更管用。',
            disclaimer: '本建议不能替代医生诊断，用药调整请遵医嘱。',
          },
        }
      }
      if (top) {
        actions.push({ priority: 'high', time: '今天', title: top.action, detail: top.title })
      }
      if (personalization.length) {
        actions.push({
          priority: 'medium',
          time: '今天',
          title: personalization[0],
          detail: '根据您的日常习惯给出的个性化建议',
        })
      } else {
        const stepSeries = analysis.find((a) => a.key === 'steps')
        if (stepSeries && stepSeries.complianceRate < 70) {
          actions.push({ priority: 'medium', time: '今天', title: `散步 30 分钟（目标 ${stepSeries.target} 步）`, detail: '步数达标率偏低' })
        }
      }
      actions.push({ priority: 'low', time: '今晚', title: '睡前记录当天体征数据', detail: '保持记录连续性，方案才更准确' })

      return {
        thoughts: [
          '汇总体征分析、风险判定与干预方案三个上游结果',
          '按「今天就能做」的原则压缩为 3 条以内行动',
          '结合生活画像给出个性化建议，并附加医嘱提示',
        ],
        result: {
          headline:
            risk.highestLevel === 'emergency' ? '血压/血糖出现危险值，请优先处理预警项'
            : risk.highestLevel === 'alert' ? '有需要重点关注的指标，建议近期复诊'
            : risk.highestLevel === 'watch' ? '整体可控，个别指标需要留意'
            : '各项指标平稳，继续保持',
          briefing:
            `本次协同完成 ${analysis.length} 项体征分析、${risk.risks.length} 条规则命中，` +
            `并生成了个性化干预方案。产品预警等级：${levelLabelOf(risk.highestLevel)}。`,
          actions,
          encouragement: '坚持记录本身就是最有效的干预，您已经做到了。',
          disclaimer: '本建议不能替代医生诊断，用药调整请遵医嘱。',
        },
      }
    }

    default:
      return { thoughts: [], result: { summary: '未识别的智能体' } }
  }
}

export function mockChat(agentId, message, { executor, user = {} }) {
  const analysis = executor.analysis()
  const risk = executor.risk()

  if (agentId === 'companion') {
    return `我在呢。您别急，咱们一步一步来。\n\n${
      risk.risks.length
        ? `我看到您最近有一条需要留意的地方——${risk.risks[0].title}。${risk.risks[0].action}`
        : '您最近的指标都挺稳的，这很不容易，继续保持。'
    }\n\n有哪里不舒服，或者心里烦，都可以跟我说说。`
  }

  if (agentId === 'vision') {
    return `我收到了您上传的内容。\n\n${message}\n\n以上信息我会结合您的档案一起看：您目前确诊 ${(user.disease_types || []).join('、') || '（未填写）'}。\n\n需要提醒的是，识别结果仅供参考，请以医院报告单与医生诊断为准。`
  }

  if (analysis.length) {
    const worst = analysis.find((a) => a.dangerDays > 0) || analysis[0]
    return `针对您的问题，我查了最近的记录：\n\n` +
      analysis.slice(0, 3).map((a) => `· ${a.label}：均值 ${a.mean} ${a.unit}，趋势${trendWord(a)}，达标率 ${a.complianceRate}%`).join('\n') +
      `\n\n关注点：${worst.label} 最长连续 ${worst.longestAbnormalDays} 天未达标。\n` +
      `${risk.risks[0] ? `建议：${risk.risks[0].action}` : '建议：保持当前节奏即可。'}\n\n` +
      `（当前处于演示模式，配置 DEEPSEEK_API_KEY 后将由大模型生成更自然的回答。）`
  }

  return '我暂时没有读到您的体征记录。您可以先到「数据记录」里录入一次血压、血糖或步数，我再帮您分析。'
}
