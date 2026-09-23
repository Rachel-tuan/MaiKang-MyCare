/**
 * 自检脚本：不依赖大模型，验证「本地推理引擎 + 智能体编排」链路是否可用。
 * 运行：node scripts/selftest.mjs（需先启动 server）
 */
import {
  toUserProfile,
  toHealthRecords,
  toBadges,
  DEFAULT_PATIENT_ID,
  getPatientById,
} from '../src/data/demoPatients.js'

const BASE = process.env.BASE || 'http://localhost:3001'

// 测试夹具同样取自唯一数据源 src/data/demoPatients.js（病例 A · 张建国）
const _patient = getPatientById(process.env.DEMO_PATIENT_ID || DEFAULT_PATIENT_ID)

const context = {
  user: toUserProfile(_patient),
  records: toHealthRecords(_patient),
  badges: toBadges(_patient).map((b) => ({
    badge_name: b.badge_name,
    badge_description: b.badge_description,
    points: b.points,
  })),
}

const log = (...a) => console.log(...a)

async function main() {
  log('\n=== 1. 服务状态 ===')
  const status = await fetch(`${BASE}/api/status`).then((r) => r.json())
  log(status)

  log('\n=== 2. 智能体注册表 ===')
  const { agents, pipeline } = await fetch(`${BASE}/api/agents`).then((r) => r.json())
  log(`智能体 ${agents.length} 个：${agents.map((a) => `${a.icon}${a.name}`).join(' / ')}`)
  log(`协作拓扑：${pipeline.map((p) => p.label).join(' → ')}`)

  log('\n=== 3. 轻量晨报（本地算法） ===')
  const briefing = await fetch(`${BASE}/api/agent/briefing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
  }).then((r) => r.json())
  log(`健康评分：${briefing.score} (${briefing.grade})`)
  log(`风险等级：${briefing.risk.label} —— ${briefing.headline}`)
  log('风险明细：')
  briefing.risk.items.forEach((r) => log(`   · [${r.level}] ${r.title} — ${r.detail}`))
  log('今日行动：')
  briefing.actions.forEach((a) => log(`   · (${a.priority}) ${a.title}`))
  log('体征指标：')
  briefing.indicators.forEach((i) =>
    log(`   · ${i.label}: 最新 ${i.latest}${i.unit}，均值 ${i.mean}，趋势 ${i.direction}，达标率 ${i.complianceRate}%`),
  )

  log('\n=== 4. 多智能体协同（SSE 事件流） ===')
  const res = await fetch(`${BASE}/api/agent/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context, goal: '生成今日健康简报' }),
  })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let summary = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      let e
      try {
        e = JSON.parse(line.slice(5).trim())
      } catch {
        continue
      }
      if (e.type === 'run_start') log(`▶ 协同开始（引擎：${e.model}）目标：${e.goal}`)
      else if (e.type === 'agent_start') log(`  ┌ ${e.name} 启动`)
      else if (e.type === 'agent_thought') log(`  │ 思考：${e.text}`)
      else if (e.type === 'tool_call') log(`  │ 调用工具 ${e.name} → ${e.result}`)
      else if (e.type === 'handoff') log(`  │ 交接：${e.reason}`)
      else if (e.type === 'agent_result') log(`  └ 产出（${e.durationMs}ms）`)
      else if (e.type === 'run_done') {
        summary = e.summary
        log(`■ 协同完成，产生 ${e.alerts.length} 条预警、${e.reminders.length} 条提醒`)
      } else if (e.type === 'error') log(`  ✗ 错误：${e.message}`)
    }
  }

  log('\n=== 5. 汇总结论 ===')
  log(JSON.stringify(summary, null, 2).slice(0, 1200))

  log('\n=== 6. 对话（降级模式） ===')
  const chatRes = await fetch(`${BASE}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'companion', message: '我最近有点担心血压', context }),
  })
  const text = await chatRes.text()
  const spoken = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim())
      } catch {
        return null
      }
    })
    .filter((e) => e && e.type === 'token')
    .map((e) => e.text)
    .join('')
  log(`陪伴智能体回复：${spoken}`)

  log('\n✅ 自检通过\n')
}

main().catch((err) => {
  console.error('❌ 自检失败：', err)
  process.exit(1)
})
