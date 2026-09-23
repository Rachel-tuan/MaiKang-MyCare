/**
 * 迈康 MyCare · 自助注册闭环验收
 * ===========================================================================
 * 验证「新账号从零开始」这条链路真的成立：
 *   注册（写 patients）→ 登录（scrypt 密码校验）→ 录入数据（写 daily_health_records）
 *   → 规则引擎现算 → alerts 落库 → 医生端出现该患者
 *
 * 环境：全程在 data/register-flow-verify.db 副本上运行，真实库零改动。
 * 运行：node scripts/db/verify-register-flow.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = path.join(ROOT, 'data', 'mycare.db')
const TMP = path.join(ROOT, 'data', 'register-flow-verify.db')

if (!fs.existsSync(SRC)) {
  console.error(`缺少主库：${SRC}（请先运行 scripts/db/build-sqlite.mjs 与 seed-sqlite.mjs）`)
  process.exit(1)
}
fs.copyFileSync(SRC, TMP)
process.env.MYCARE_DB_PATH = TMP

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const svc = await imp('server/data/patientService.js')
const ctxApi = await imp('server/data/agentContext.js')
const alertApi = await imp('server/data/alertService.js')
const dbApi = await imp('server/data/db.js')

const { registerPatient, resetPatientPassword, resolvePatientForLogin, listPatientEntries, getPatientRecords, upsertDailyRecord, getDoctorPatients } = svc
const { buildAgentContext, buildRuleEvaluation } = ctxApi
const { persistRuleAlerts, listPatientAlerts } = alertApi

const lines = []
let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    lines.push(`  ✅ ${name}`)
  } else {
    fail += 1
    lines.push(`  ❌ ${name}${extra ? `  ← ${extra}` : ''}`)
  }
}

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (offset) => {
  const t = new Date()
  t.setDate(t.getDate() + offset)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

const USERNAME = `e2e_${Date.now().toString(36)}`
const PASSWORD = 'MyCare@2026'
const PHONE = '13900139000'

lines.push(`副本库：${path.relative(ROOT, TMP)}`)
lines.push(`测试账号：${USERNAME}`)
lines.push('')
lines.push('【1】注册即在数据库建立真实档案')

const entriesBefore = await listPatientEntries()
const reg = await registerPatient({
  username: USERNAME,
  password: PASSWORD,
  name: '闭环验收用户',
  gender: 'male',
  age: 62,
  height: 172,
  weight: 76.5,
  phone: PHONE,
  diseases: ['hypertension'],
  emergencyContact: '验收家属',
})
check('注册返回 patient_id，且视图身份键一致', Boolean(reg.patientId) && reg.view.user_id === reg.patientId, `patientId=${reg.patientId}`)
check('新档案是独立患者（患者库新增一行）', reg.patientId !== 'patient_1' && reg.patientId !== 'patient_2' && reg.patientId !== 'patient_3')
check('疾病诊断落库为中文规范病名', (reg.view.diseases || []).includes('高血压'), JSON.stringify(reg.view.diseases))
check('注册后「一键进入示范病例」列表不变（仍为免密账号）', (await listPatientEntries()).length === entriesBefore.length, `${entriesBefore.length} → ${(await listPatientEntries()).length}`)

lines.push('')
lines.push('【2】先注册才能登录（密码校验在后端，前端无法绕过）')

const throwOf = async (fn) => {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

const eNoPwd = await throwOf(() => resolvePatientForLogin({ username: USERNAME }))
check('未携带密码 → 拒绝 E_PASSWORD_REQUIRED', eNoPwd?.code === 'E_PASSWORD_REQUIRED', eNoPwd?.code)

const eBadPwd = await throwOf(() => resolvePatientForLogin({ username: USERNAME, password: 'wrong-password' }))
check('密码错误 → 拒绝 E_PASSWORD_MISMATCH', eBadPwd?.code === 'E_PASSWORD_MISMATCH', eBadPwd?.code)

const eNoUser = await throwOf(() => resolvePatientForLogin({ username: `${USERNAME}_nobody` }))
check('未注册用户名 → E_PATIENT_NOT_FOUND（不回落默认患者）', eNoUser?.code === 'E_PATIENT_NOT_FOUND', eNoUser?.code)

const okLogin = await resolvePatientForLogin({ username: USERNAME, password: PASSWORD })
check('密码正确 → 登录成功且身份键为 patient_id', okLogin.patientId === reg.patientId && okLogin.view.user_id === reg.patientId)

const eDup = await throwOf(() => registerPatient({ username: USERNAME, password: 'whatever123', name: '重名', gender: 'female', age: 50 }))
check('重复用户名 → E_USERNAME_TAKEN', eDup?.code === 'E_USERNAME_TAKEN', eDup?.code)

const demoOk = await resolvePatientForLogin({ patientId: 'patient_1' })
check('示范病例仍可免密一键进入（password_hash 为空）', demoOk.patientId === 'patient_1')

lines.push('')
lines.push('【3】新账号从零开始：只有注册时写入的一条体重')

const r0 = await getPatientRecords(reg.patientId, 30)
check('初始记录数 = 1 且为注册体重', r0.count === 1 && Number(r0.records[0].weight) === 76.5, `count=${r0.count}`)
check('初始没有任何落库预警', (await listPatientAlerts(reg.patientId, { limit: 20 })).alerts.length === 0)

lines.push('')
lines.push('【4】用户自己录入 → 规则引擎现算 → 预警落库')

const series = [[-6, 132, 82], [-5, 136, 84], [-4, 138, 86], [-3, 144, 90], [-2, 152, 94], [-1, 158, 96], [0, 162, 98]]
for (const [off, systolic, diastolic] of series) {
  await upsertDailyRecord(reg.patientId, { date: dayKey(off), systolic, diastolic, steps: 5200, exerciseMinutes: 20 })
}
const r1 = await getPatientRecords(reg.patientId, 7)
check('录入后记录数增长（同日 UPSERT、跨日追加）', r1.count >= 7, `count=${r1.count}`)

const context = await buildAgentContext(reg.patientId, { days: 7 })
const evaluation = buildRuleEvaluation(context)
const matchedIds = (evaluation.matched || []).map((r) => r.ruleId)
check('确定性规则命中 R-BP-2（血压连续升高）', matchedIds.includes('R-BP-2'), matchedIds.join(',') || '无命中')

const persisted = await persistRuleAlerts(reg.patientId, evaluation, { source: 'orchestrator' })
check('命中结果写入 alerts 表', persisted.inserted + persisted.updated > 0, JSON.stringify({ inserted: persisted.inserted, updated: persisted.updated }))

const alerts = (await listPatientAlerts(reg.patientId, { limit: 20 })).alerts
check('alerts 可按 patient_id 读回且归属正确', alerts.length > 0 && alerts.every((a) => a.patientId === reg.patientId), `count=${alerts.length}`)
check('落库预警只记录不外发（externalBlocked=true / confirmed=false）', alerts.every((a) => a.externalBlocked === true && a.confirmed === false))
check('落库文案使用「建议」措辞（不出现「处方」）', alerts.every((a) => !String(a.action || '').includes('处方')), alerts.map((a) => a.action).join(' | '))

lines.push('')
lines.push('【5】医生端随库出现该患者')

const doc = await getDoctorPatients('doc_li')
const mine = doc.patients.find((p) => p.id === reg.patientId)
check('医生端包含新注册患者', Boolean(mine), doc.patients.map((p) => p.id).join(','))
check('医生端该患者带落库预警明细', Boolean(mine && mine.alertCount > 0), mine ? `alertCount=${mine.alertCount}` : '')
check('医生端患者总数 = 示范 3 位 + 新注册 1 位', doc.patients.length === 4, `count=${doc.patients.length}`)

lines.push('')
lines.push('【6】找回密码（用户名 + 注册手机号双因子）')

const ePhone = await throwOf(() => resetPatientPassword({ username: USERNAME, phone: '13800000000', newPassword: 'newpass123' }))
check('手机号不匹配 → E_PHONE_MISMATCH', ePhone?.code === 'E_PHONE_MISMATCH', ePhone?.code)

const rs = await resetPatientPassword({ username: USERNAME, phone: PHONE, newPassword: 'newpass123' })
check('双因子匹配 → 重置成功', rs.ok === true)

const okNew = await resolvePatientForLogin({ username: USERNAME, password: 'newpass123' })
check('重置后的新密码可登录', okNew.patientId === reg.patientId)

const eOld = await throwOf(() => resolvePatientForLogin({ username: USERNAME, password: PASSWORD }))
check('旧密码已失效', eOld?.code === 'E_PASSWORD_MISMATCH', eOld?.code)

lines.push('')
lines.push(`结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`)

const out = lines.join('\n')
console.log(out)
fs.writeFileSync(path.join(ROOT, 'data', 'register-flow-verify-record.json'), JSON.stringify({ pass, fail, at: new Date().toISOString(), lines }, null, 2), 'utf8')

try {
  dbApi.closeDb()
  fs.unlinkSync(TMP)
} catch {
  /* 副本删除失败不影响结论 */
}

process.exit(fail === 0 ? 0 : 1)
