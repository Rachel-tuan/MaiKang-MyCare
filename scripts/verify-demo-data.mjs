/**
 * 迈康 MyCare · 演示人设与规则引擎自检
 * ---------------------------------------------------------------------------
 * 对照 docs/演示人设设定书_v2.md 逐条断言：
 *   1. 三位病例的 7 天数据、达标率、关键数值；
 *   2. 规则命中与「必须不命中」；
 *   3. 紧急联系人授权策略；
 *   4. 生活画像是否真正进入个性化建议；
 *   5. 疾病标签能否被 utils/disease.js 的 hasDisease() 命中；
 *   6. 产品预警等级词表是否干净（不得出现医学危险分层术语）。
 *
 * 用法: node scripts/verify-demo-data.mjs
 */
import { DEMO_PATIENTS, toHealthRecords, toBadges, toUserProfile, getPatientById } from '../src/data/demoPatients.js'
import { evaluateClinicalRules, isRuleMatched, ALERT_LEVEL, shouldNotifyEmergencyContact } from '../src/utils/clinicalRules.js'
import { hasHypertension, hasDiabetes } from '../src/utils/disease.js'

let pass = 0
const failures = []

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (ok) {
    pass += 1
    console.log(`  \u2713 ${label} = ${actual}`)
  } else {
    failures.push(`${label}｜期望 ${expected}，实际 ${actual}`)
    console.log(`  \u2717 ${label}｜期望 ${expected}，实际 ${actual}`)
  }
}

function checkTrue(label, value) {
  check(label, Boolean(value), true)
}

function section(title) {
  console.log(`\n${title}`)
}

const evaluate = (id) => {
  const p = getPatientById(id)
  const records = toHealthRecords(p)
  return { patient: p, records, evaluation: evaluateClinicalRules(p, records) }
}

console.log('='.repeat(72))
console.log('迈康 MyCare · 演示人设与规则引擎自检（对照 演示人设设定书_v2.md）')
console.log('='.repeat(72))

/* ---------------------------------------------------------------- 病例 A */
section('【病例 A】张建国 · 原发性高血压 2 级')
{
  const { patient, records, evaluation } = evaluate('patient_1')

  check('7 天记录条数', records.length, 7)
  check('姓名', patient.profile.name, '张建国')
  check('内部代号', patient.demoCode, '张三')

  const d7 = records[records.length - 1]
  check('D7 收缩压', d7.systolic_pressure, 162)
  check('D7 舒张压', d7.diastolic_pressure, 98)
  check('D1 收缩压', records[0].systolic_pressure, 132)

  check('血压达标率(%)', evaluation.stats.bloodPressure.complianceRate, 42.9)
  check('达标天数', evaluation.stats.bloodPressure.compliantDays, 3)
  check('连续不达标天数', evaluation.stats.bloodPressure.consecutiveAbnormalDays, 4)
  check('7 天收缩压涨幅', evaluation.stats.bloodPressure.rise, 30)

  checkTrue('命中 R-BP-2 连续异常趋势预警', isRuleMatched(evaluation, 'R-BP-2'))
  check('不命中 R-BP-3 严重超标强预警', isRuleMatched(evaluation, 'R-BP-3'), false)
  check('不命中 R-BP-1 单次超标提示', isRuleMatched(evaluation, 'R-BP-1'), false)
  check('最高产品预警等级', evaluation.highestLevel, 'alert')
  check('最高等级中文标签', ALERT_LEVEL[evaluation.highestLevel].label, '预警')

  // 紧急联系人授权
  check('紧急联系人已授权', patient.profile.emergencyContact.authorized, true)
  check('未点击确认时不允许外发', shouldNotifyEmergencyContact(patient, { userConfirmed: false }), false)
  check('已授权且确认后允许外发', shouldNotifyEmergencyContact(patient, { userConfirmed: true }), true)

  // 生活画像进入建议逻辑
  const texts = evaluation.personalization.map((a) => a.text).join('')
  checkTrue('生活画像命中「口味偏咸」', texts.includes('口味偏咸'))
  checkTrue('生活画像命中「腌菜」', texts.includes('腌菜'))

  // 疾病标签兼容
  checkTrue('disease_types 可被 hasHypertension 命中', hasHypertension(patient.medical ? [patient.medical.primaryDisease] : []))
  check('医学危险分层（医生侧）', patient.medical.riskStratification, '中危')
}

/* ---------------------------------------------------------------- 病例 B */
section('【病例 B】李秀英 · 2 型糖尿病')
{
  const { patient, records, evaluation } = evaluate('patient_2')

  check('7 天记录条数', records.length, 7)
  check('姓名', patient.profile.name, '李秀英')
  check('内部代号', patient.demoCode, '李四')

  check('演示判定阈值(mmol/L)', evaluation.stats.bloodSugar.threshold, 7.8)
  check('血糖达标率(%)', evaluation.stats.bloodSugar.complianceRate, 57.1)
  check('达标天数', evaluation.stats.bloodSugar.compliantDays, 4)
  check('7 天极差(mmol/L)', evaluation.stats.bloodSugar.range, 1.4)
  check('7 天峰值(mmol/L)', evaluation.stats.bloodSugar.max, 8.5)
  check('D7 空腹血糖', records[records.length - 1].blood_sugar, 8.3)

  checkTrue('命中 R-BG-2 血糖波动提醒', isRuleMatched(evaluation, 'R-BG-2'))
  checkTrue('命中 R-BG-3 控制不佳趋势', isRuleMatched(evaluation, 'R-BG-3'))
  check('不命中 R-BG-4 复查提醒（2 个月 < 3 个月）', isRuleMatched(evaluation, 'R-BG-4'), false)
  check('最高产品预警等级', evaluation.highestLevel, 'alert')

  // 两个时间尺度分离
  check('HbA1c（长期指标）', patient.medical.hba1c, 7.8)
  checkTrue(
    'HbA1c 与 7 天血糖分属不同字段',
    patient.medical.hba1c === 7.8 && records[records.length - 1].blood_sugar === 8.3
  )
  checkTrue('存在阈值口径说明', String(patient.medical.demoThresholdNote).includes('个体化'))

  const texts = evaluation.personalization.map((a) => a.text).join('')
  checkTrue('生活画像命中「面食为主」', texts.includes('面食为主'))
  checkTrue('生活画像命中「精制面食」', texts.includes('精制面食'))
  checkTrue('disease_types 可被 hasDiabetes 命中', hasDiabetes([patient.medical.primaryDisease]))
}

/* ---------------------------------------------------------------- 病例 C */
section('【病例 C】王建军 · 肥胖症')
{
  const { patient, records, evaluation } = evaluate('patient_3')

  check('7 天记录条数', records.length, 7)
  check('姓名', patient.profile.name, '王建军')
  check('内部代号', patient.demoCode, '王五')

  check('D1 体重(kg)', records[0].weight, 92.0)
  check('D7 体重(kg)', records[records.length - 1].weight, 90.8)
  check('7 天净变化(kg)', evaluation.stats.weightBehavior.netChange, -1.2)
  check('最大单日回升(kg)', evaluation.stats.weightBehavior.maxRebound, 0.6)
  check('7 天累计运动(分钟)', evaluation.stats.weightBehavior.weekExercise, 200)

  checkTrue('命中 R-WT-2 减重进展反馈', isRuleMatched(evaluation, 'R-WT-2'))
  checkTrue('命中 R-WT-3 短期反弹提醒', isRuleMatched(evaluation, 'R-WT-3'))
  checkTrue('命中 R-WT-4 运动达标激励', isRuleMatched(evaluation, 'R-WT-4'))
  checkTrue('命中 R-WT-5 勋章进度跟进', isRuleMatched(evaluation, 'R-WT-5'))
  check('不命中 R-BP-2（血压未连续异常）', isRuleMatched(evaluation, 'R-BP-2'), false)

  // 未授权路径
  check('紧急联系人未授权', patient.profile.emergencyContact.authorized, false)
  check('未授权时不允许外发', shouldNotifyEmergencyContact(patient, { userConfirmed: true }), false)

  const reboundRule = evaluation.byId['R-WT-3']
  checkTrue('短期反弹文案不提「平台期」', !reboundRule.message.includes('平台期'))
  checkTrue('短期反弹文案说明「不代表脂肪增加」', reboundRule.message.includes('不代表脂肪增加'))
  checkTrue('减重文案不提「脂肪减少」', !evaluation.byId['R-WT-2'].message.includes('脂肪减少'))
  checkTrue('减重文案含「水分与测量波动」', evaluation.byId['R-WT-2'].message.includes('水分与测量波动'))

  const texts = evaluation.personalization.map((a) => a.text).join('')
  checkTrue('生活画像命中「晚餐偏多/七分饱」', texts.includes('七分饱'))
  checkTrue('生活画像命中「打鼾」', texts.includes('打鼾'))
}

/* ------------------------------------------------------------ 通用约束 */
section('【通用约束】')
{
  const forbidden = ['高危', '重度', '危象', '很高危', '低危', '平台期']

  for (const p of DEMO_PATIENTS) {
    const records = toHealthRecords(p)
    const evaluation = evaluateClinicalRules(p, records)

    // 产品词表不得借用医学分层术语
    const ruleText = evaluation.matched
      .map((r) => `${r.levelLabel}${r.title}${r.message}${r.action}`)
      .join('|')
    const dirty = forbidden.filter((w) => ruleText.includes(w))
    check(`${p.profile.name} 规则文案无禁用词`, dirty.length === 0, true)

    // 等级必须落在产品词表内
    const badLevel = evaluation.matched.filter((r) => !ALERT_LEVEL[r.level])
    check(`${p.profile.name} 预警等级全部属于产品词表`, badLevel.length, 0)

    // 数据完整性
    const nan = records.filter((r) =>
      [r.steps, r.systolic_pressure, r.diastolic_pressure, r.blood_sugar, r.weight, r.heart_rate]
        .some((v) => !Number.isFinite(Number(v)))
    )
    check(`${p.profile.name} 7 天数据无 NaN`, nan.length, 0)

    // 日期连续
    const dates = records.map((r) => new Date(r.record_date).getTime())
    const gaps = dates.slice(1).map((t, i) => Math.round((t - dates[i]) / 86400000))
    check(`${p.profile.name} 日期连续（间隔均为 1 天）`, gaps.every((g) => g === 1), true)

    // 用户档案可生成
    const profile = toUserProfile(p)
    checkTrue(`${p.profile.name} 档案含生活画像`, Boolean(profile.lifestyle?.tags))
    checkTrue(`${p.profile.name} 档案含医学设定`, Boolean(profile.medical?.primaryDisease))
    check(`${p.profile.name} 勋章数`, toBadges(p).length, 2)
  }

  // 三人彼此独立
  const ids = DEMO_PATIENTS.map((p) => p.id)
  check('三位患者 id 唯一', new Set(ids).size, 3)
  const names = DEMO_PATIENTS.map((p) => p.profile.name)
  check('正式姓名不含内部代号', names.some((n) => ['张三', '李四', '王五'].includes(n)), false)
  console.log(`  正式姓名：${names.join(' / ')}`)
}

/* ---------------------------------------------------------------- 汇总 */
console.log(`\n${'='.repeat(72)}`)
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项断言 \u2713`)
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项 \u2717`)
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('='.repeat(72))

process.exitCode = failures.length > 0 ? 1 : 0
