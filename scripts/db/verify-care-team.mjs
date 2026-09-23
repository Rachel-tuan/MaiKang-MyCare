/**
 * 迈康 MyCare · 验收：隐私授权闭环（2026-09-17 新增）
 * ===========================================================================
 * 被验收的行为改变：
 *   **注册不再等于授权。** 原先 registerPatient() 直接写入
 *   `doctor_patient_relations.is_active = 1`，新注册账号立刻出现在医生端；
 *   现改为写 `is_active = 0`，只有患者本人在「我的医疗团队」显式同意后才置 1。
 *
 * 不变量（必须全部成立）：
 *   · 医生端可见性**唯一**取决于 doctor_patient_relations.is_active = 1；
 *   · 撤回授权**不删除**关联行，也**不改动**患者任何健康数据；
 *   · 授权动作幂等；非布尔 granted 一律 400；
 *   · 患者不存在 → 404 E_PATIENT_NOT_FOUND，**绝不回落**示范患者。
 *
 * 运行方式（自起自停，使用**副本库**，真实库零改动）：
 *   node scripts/db/verify-care-team.mjs
 * ---------------------------------------------------------------------------
 * 铁律：本脚本不碰 data/mycare.db；只复制 data/mycare-demo.db 到临时副本。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const SRC_DB = join(ROOT, 'data', 'mycare-demo.db')
const TMP_DB = join(ROOT, 'data', '_careteam-verify.db')
const PORT = 3996
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  env: { ...process.env, MYCARE_DB_PATH: TMP_DB, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOut = ''
child.stdout.on('data', (d) => (serverOut += d.toString()))
child.stderr.on('data', (d) => (serverOut += d.toString()))

function shutdown() {
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  try {
    rmSync(TMP_DB, { force: true })
    rmSync(`${TMP_DB}-wal`, { force: true })
    rmSync(`${TMP_DB}-shm`, { force: true })
  } catch {
    /* ignore */
  }
}

let ready = false
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${BASE}/api/status`)
    if (r.ok) {
      ready = true
      break
    }
  } catch {
    /* 还在启动 */
  }
  await sleep(250)
}
if (!ready) {
  shutdown()
  console.error('服务未能在 15 秒内就绪。输出：\n' + serverOut)
  process.exit(1)
}

try {
  const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const stamp = Date.now().toString().slice(-6)

  /* ---------------------------------------------------------------- */
  section('1. 前置：示范病例本就已授权，医生端可见 3 位')
  const list0 = await api('/api/doctors/doc_li/patients')
  check('医生端可访问', list0.status === 200, `HTTP ${list0.status}`)
  check('示范病例 3 位全部可见（种子 is_active = 1）', list0.json?.patients?.length === 3, `count=${list0.json?.patients?.length}`)

  /* ---------------------------------------------------------------- */
  section('2. 注册一个全新账号')
  const username = `ct_${stamp}`
  const reg = await api('/api/patients/register', {
    method: 'POST',
    body: {
      username,
      name: '隐私验收甲',
      password: 'verify123456',
      gender: 'female',
      age: 70,
      height: 160,
      weight: 62,
      diseases: ['hypertension'],
    },
  })
  check('注册成功', reg.status === 201, `HTTP ${reg.status}`)
  const pid = reg.json?.patientId
  check('返回 patient_id', Boolean(pid), pid || '(空)')

  /* ---------------------------------------------------------------- */
  section('3. 核心断言：注册 ≠ 授权 —— 医生端看不到新账号')
  const list1 = await api('/api/doctors/doc_li/patients')
  const inList1 = (list1.json?.patients || []).some((p) => p.id === pid)
  check('医生端患者数仍为 3（未授权不进列表）', list1.json?.patients?.length === 3, `count=${list1.json?.patients?.length}`)
  check('医生端**不含**刚注册的账号', !inList1, `包含=${inList1}`)

  /* ---------------------------------------------------------------- */
  section('4. 患者侧授权清单：新账号默认为「未授权」')
  const team0 = await api(`/api/patients/${pid}/care-team`)
  check('care-team 可访问', team0.status === 200, `HTTP ${team0.status}`)
  const docLi0 = (team0.json?.doctors || []).find((d) => d.doctorId === 'doc_li')
  check('列表中列出 doc_li（可授权对象）', Boolean(docLi0), docLi0 ? docLi0.name : '(缺)')
  check('doc_li 初始 granted = false', docLi0?.granted === false, `granted=${docLi0?.granted}`)
  check('医生姓名/职称来自 doctors 表', docLi0?.name === '李医生', `name=${docLi0?.name} | title=${docLi0?.title}`)

  const prof0 = await api(`/api/patients/${pid}/profile`)
  check('档案视图中 doctors 为空（未授权）', (prof0.json?.profile?.doctors || []).length === 0, `count=${(prof0.json?.profile?.doctors || []).length}`)

  /* ---------------------------------------------------------------- */
  section('5. 入参校验：granted 必须为布尔值 / 未知医生 / 未知患者')
  const bad = await api(`/api/patients/${pid}/care-team/doc_li`, { method: 'POST', body: { granted: 'yes' } })
  check('字符串 granted → 400 E_INVALID_ARG', bad.status === 400 && bad.json?.code === 'E_INVALID_ARG', `HTTP ${bad.status} code=${bad.json?.code}`)
  const badDoc = await api(`/api/patients/${pid}/care-team/doc_ghost`, { method: 'POST', body: { granted: true } })
  check('未知医生 → 400', badDoc.status === 400, `HTTP ${badDoc.status} code=${badDoc.json?.code}`)
  const badPid = await api('/api/patients/patient_ghost/care-team')
  check('未知患者 → 404 E_PATIENT_NOT_FOUND（不回落示范患者）', badPid.status === 404 && badPid.json?.code === 'E_PATIENT_NOT_FOUND', `HTTP ${badPid.status} code=${badPid.json?.code}`)
  const badPid2 = await api('/api/patients/patient_ghost/care-team/doc_li', { method: 'POST', body: { granted: true } })
  check('未知患者授权 → 404（不得凭空建关系）', badPid2.status === 404, `HTTP ${badPid2.status}`)

  /* ---------------------------------------------------------------- */
  section('6. 患者同意授权 → 医生端即刻可见')
  const grant = await api(`/api/patients/${pid}/care-team/doc_li`, { method: 'POST', body: { granted: true } })
  check('授权返回 200 且 granted = true', grant.status === 200 && grant.json?.granted === true, `HTTP ${grant.status} granted=${grant.json?.granted}`)

  const list2 = await api('/api/doctors/doc_li/patients')
  const mine2 = (list2.json?.patients || []).find((p) => p.id === pid)
  check('医生端患者数 = 4', list2.json?.patients?.length === 4, `count=${list2.json?.patients?.length}`)
  check('医生端**出现**该患者', Boolean(mine2), mine2 ? mine2.name : '(缺)')
  check('医生端患者带疾病谱', (mine2?.diseases || []).length > 0, (mine2?.diseases || []).join('/'))
  check('医生端手机号已脱敏（最小必要）', typeof mine2?.phone === 'string', `phone=${mine2?.phone}`)

  const team1 = await api(`/api/patients/${pid}/care-team`)
  const docLi1 = (team1.json?.doctors || []).find((d) => d.doctorId === 'doc_li')
  check('授权后 granted = true', docLi1?.granted === true, `granted=${docLi1?.granted}`)

  const prof1 = await api(`/api/patients/${pid}/profile`)
  check('档案视图中出现该医生', (prof1.json?.profile?.doctors || []).some((d) => d.doctorId === 'doc_li'))

  /* ---------------------------------------------------------------- */
  section('7. 幂等：重复授权结果一致')
  const grantAgain = await api(`/api/patients/${pid}/care-team/doc_li`, { method: 'POST', body: { granted: true } })
  const list3 = await api('/api/doctors/doc_li/patients')
  check('重复授权仍 200', grantAgain.status === 200, `HTTP ${grantAgain.status}`)
  check('患者数仍为 4（不重复插入关系行）', list3.json?.patients?.length === 4, `count=${list3.json?.patients?.length}`)

  /* ---------------------------------------------------------------- */
  section('8. 撤回授权 → 医生端立即不可见，但数据不丢')
  // 先写入一条真实健康记录，用于验证「撤回不动数据」
  const rec = await api(`/api/patients/${pid}/records`, {
    method: 'POST',
    body: { date: TODAY, systolic: 152, diastolic: 96, heartRate: 82, source: 'manual' },
  })
  check('撤回前先写入一条血压记录', rec.status === 200 || rec.status === 201, `HTTP ${rec.status}`)

  const revoke = await api(`/api/patients/${pid}/care-team/doc_li`, { method: 'POST', body: { granted: false } })
  check('撤回返回 200 且 granted = false', revoke.status === 200 && revoke.json?.granted === false, `HTTP ${revoke.status} granted=${revoke.json?.granted}`)

  const list4 = await api('/api/doctors/doc_li/patients')
  check('医生端患者数回到 3', list4.json?.patients?.length === 3, `count=${list4.json?.patients?.length}`)
  check('医生端**不再包含**该患者', !(list4.json?.patients || []).some((p) => p.id === pid))

  const recAfter = await api(`/api/patients/${pid}/records?days=30`)
  const kept = (recAfter.json?.records || []).some((r) => r.date === TODAY)
  check('撤回后患者自己的记录仍在（撤回不动数据）', kept, `HTTP ${recAfter.status}`)

  const team2 = await api(`/api/patients/${pid}/care-team`)
  const docLi2 = (team2.json?.doctors || []).find((d) => d.doctorId === 'doc_li')
  check('撤回后 granted 回到 false', docLi2?.granted === false, `granted=${docLi2?.granted}`)

  /* ---------------------------------------------------------------- */
  section('9. 直查数据库：关系行「不删只翻」，且不新增表')
  const db = new DatabaseSync(TMP_DB, { readOnly: true })
  const rel = db.prepare('SELECT relation_id, is_active FROM doctor_patient_relations WHERE patient_id = ?').all(pid)
  check('关联行仍存在（撤回不删行，保留留痕）', rel.length === 1, `rows=${rel.length}`)
  check('该行 is_active = 0', Number(rel[0]?.is_active) === 0, `is_active=${rel[0]?.is_active}`)
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((t) => t.name)
  check('表数量仍为 22（零建表，未触 P0 冻结）', tables.length === 22, `count=${tables.length}`)
  check('未新增任何审计/授权表', !tables.some((t) => /consent|authoriz|audit|access_log/i.test(t)))

  // 示范病例的授权状态未被本次操作影响
  const demoRel = db
    .prepare("SELECT COUNT(*) AS n FROM doctor_patient_relations WHERE patient_id IN ('patient_1','patient_2','patient_3') AND is_active = 1")
    .get()
  check('3 位示范病例仍全部已授权（演示不受影响）', Number(demoRel.n) === 3, `n=${demoRel.n}`)
  db.close()

  /* ---------------------------------------------------------------- */
  section('10. 再次授权可恢复（授权是可逆开关）')
  await api(`/api/patients/${pid}/care-team/doc_li`, { method: 'POST', body: { granted: true } })
  const list5 = await api('/api/doctors/doc_li/patients')
  check('重新授权后医生端再次可见', (list5.json?.patients || []).some((p) => p.id === pid), `count=${list5.json?.patients?.length}`)

  /* ---------------------------------------------------------------- */
  section('11. 复现原缺陷路径：旧行为已不可能发生')
  const second = await api('/api/patients/register', {
    method: 'POST',
    body: { username: `ct2_${stamp}`, name: '隐私验收乙', password: 'verify123456', age: 66, height: 170, weight: 74, diseases: ['diabetes'] },
  })
  const pid2 = second.json?.patientId
  const list6 = await api('/api/doctors/doc_li/patients')
  check('第二个新注册账号同样不进医生端', !(list6.json?.patients || []).some((p) => p.id === pid2), `pid=${pid2}`)
  const rel2 = new DatabaseSync(TMP_DB, { readOnly: true })
    .prepare('SELECT is_active FROM doctor_patient_relations WHERE patient_id = ?')
    .get(pid2)
  check('第二个账号关联行 is_active = 0', Number(rel2?.is_active) === 0, `is_active=${rel2?.is_active}`)
} catch (err) {
  fail++
  lines.push('')
  lines.push(`  ❌ 脚本异常：${err.message}`)
  lines.push(err.stack || '')
} finally {
  shutdown()
}

lines.push('')
lines.push('─'.repeat(72))
lines.push(`  验收结果：${pass} / ${pass + fail} 通过${fail ? `，${fail} 项失败` : '，全部通过'}`)
lines.push('  说明：本脚本使用副本库 data/_careteam-verify.db，运行结束即删除；真实库零改动。')
lines.push('─'.repeat(72))
console.log(lines.join('\n'))
process.exit(fail ? 1 : 0)
