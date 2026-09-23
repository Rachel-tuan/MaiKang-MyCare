/**
 * 性能基准测试
 * 测量核心算法层（趋势拟合 / 达标率 / 风险判定 / 建议生成）的真实耗时，
 * 为设计报告提供可复现的性能数据。
 * 运行：node scripts/benchmark.mjs
 */
import { performance } from 'node:perf_hooks'
import {
  analyzeSeries,
  assessRisk,
  computeHealthScore,
  draftInterventionPlan,
  createToolExecutor,
} from '../server/agents/tools.js'

function makeRecords(n) {
  const out = []
  const today = new Date()
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    out.push({
      record_date: d.toISOString().slice(0, 10),
      steps: 5200 + (i % 7) * 400,
      systolic_pressure: 130 + (i % 9) * 4,
      diastolic_pressure: 80 + (i % 7) * 2,
      blood_sugar: (6.0 + (i % 6) * 0.5).toFixed(1),
      weight: (76 + (i % 5) * 0.3).toFixed(1),
      heart_rate: 72 + (i % 8),
      exercise_minutes: 20 + (i % 5) * 10,
      sleep_hours: (6.2 + (i % 4) * 0.3).toFixed(1),
    })
  }
  return out
}

const USER = { age: 68, bmi: 26.3, disease_types: ['高血压', '糖尿病'] }
const KEYS = [
  'systolic_pressure', 'diastolic_pressure', 'blood_sugar',
  'heart_rate', 'weight', 'steps', 'sleep_hours', 'exercise_minutes',
]

function bench(label, fn, iterations = 200) {
  fn() // 预热
  const start = performance.now()
  for (let i = 0; i < iterations; i += 1) fn()
  const total = performance.now() - start
  const avg = total / iterations
  console.log(
    `  ${label.padEnd(26, '·')} 平均 ${avg.toFixed(3)} ms    (${iterations} 次总计 ${total.toFixed(1)} ms)`,
  )
  return avg
}

console.log('\n===== 迈康 MyCare · 核心算法性能基准 =====\n')

for (const days of [7, 30, 90, 365]) {
  const records = makeRecords(days)
  console.log(`【数据规模：${days} 天记录 / ${days * 8} 个数据点】`)
  bench('单指标趋势分析', () => analyzeSeries(records, 'systolic_pressure'))
  bench('八项指标全量分析', () => KEYS.map((k) => analyzeSeries(records, k)))
  bench('分级风险评估', () => assessRisk(records, USER))
  bench('健康评分计算', () => computeHealthScore(records))
  bench('个性化建议生成', () => draftInterventionPlan(USER, assessRisk(records, USER), []))
  bench('工具层全链路', () => {
    const ex = createToolExecutor({ user: USER, records, badges: [] })
    ex.analysis(); ex.risk()
  }, 100)
  console.log('')
}

const records = makeRecords(365)
console.log('【健康数据快照序列化体积】')
const snapshot = { user: USER, records, badges: [] }
const json = JSON.stringify(snapshot)
console.log(`  365 天记录 JSON 体积：${(json.length / 1024).toFixed(1)} KB`)
console.log(`  平均单条记录：${(json.length / records.length).toFixed(0)} 字节\n`)
