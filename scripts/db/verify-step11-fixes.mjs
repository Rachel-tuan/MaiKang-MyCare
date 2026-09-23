/**
 * 迈康 MyCare · Step 11 缺陷修复验收（D-1 + D-2）
 * ===========================================================================
 * 本脚本**只验证两件事**，不做范围外工作：
 *
 *   D-1「未记录被读成 0」
 *     反事实实验：同一份输入，修复前（视图层用 `?? 0` 伪造）vs 修复后（NULL 保持 NULL），
 *     比较最高等级 / 命中规则 / 7 天涨幅 / 血糖极差 · 最低 / 达标率口径。
 *     并单独验证：真 0 不被误删、NULL 与 0 严格区分、旧字段命名兼容、真实非 NULL 数据仍正常。
 *
 *   D-2「两套风险等级同屏矛盾」
 *     离线：4 位患者 `assessRisk().highestLevel === evaluateClinicalRules().highestLevel`；
 *     线上：隔离端口的真实服务上，`briefing.risk` / 医生端 `evaluation.highestLevel` /
 *           落库 `alerts` 三者等级一致。
 *
 * 约定：
 *   · **在副本库上运行**（默认以真实库 mycare.db 为基做副本，主库全程零改动）；
 *   · 不改任何断言去迁就实现；失败就是失败。
 *
 * 运行：node scripts/db/verify-step11-fixes.mjs
 * 产物：data/step11-fixes-verify-record.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const NODE = process.execPath
const PORT = 3062
const BASE = `http://127.0.0.1:${PORT}`

const MAIN_DB = path.resolve(process.env.MYCARE_BASE_DB_PATH || path.join(ROOT, 'data', 'mycare.db'))
const FALLBACK_DB = path.resolve(path.join(ROOT, 'data', 'mycare-demo.db'))
const TEST_DB = path.join(ROOT, 'data', '_step11-fixes.db')

const BASE_DB = fs.existsSync(MAIN_DB) ? MAIN_DB : FALLBACK_DB
if (!fs.existsSync(BASE_DB)) {
  console.error(`❌ 未找到基准库：${BASE_DB}\n   请先运行 node scripts/db/reset-demo.mjs`)
  process.exit(1)
}
const MAIN_MTIME_BEFORE = fs.existsSync(MAIN_DB) ? fs.statSync(MAIN_DB).mtimeMs : null
fs.copyFileSync(BASE_DB, TEST_DB)

// ⚠️ db.js 的 DB_PATH 是**模块级常量**，在 import 时读取 process.env → 必须先设置再动态导入
process.env.MYCARE_DB_PATH = TEST_DB

const checks = {}
const samples = {}
let passed = 0
let failed = 0

function check(name, ok, detail) {
  checks[name] = { ok: Boolean(ok), detail }
  if (ok) passed += 1
  else failed += 1
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function req(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* keep null */
  }
  return { status: res.status, json, text }
}

function startServer() {
  const child = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MYCARE_DB_PATH: TEST_DB },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/status`)
      if (r.status === 200) return true
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  return false
}

const PIDS = ['patient_1', 'patient_2', 'patient_3', 'patient_4']

async function main() {
  /* ================= 动态导入（必须在设置 MYCARE_DB_PATH 之后） ================= */
  const { getPatientRecords, listPatientAlerts } = await import('../../server/data/patientService.js')
  const { buildAgentContext, toRulePatient, buildRuleEvaluation } = await import(
    '../../server/data/agentContext.js'
  )
  const { persistRuleAlerts } = await import('../../server/data/alertService.js')
  const { evaluateClinicalRules, seriesOf, highestAlertLevel, ALERT_LEVEL } = await import(
    '../../src/utils/clinicalRules.js'
  )
  const { computeDailyHealthScore } = await import('../../src/utils/healthScore.js')
  const { assessRisk } = await import('../../server/agents/tools.js')

  const line = '─'.repeat(78)
  console.log(line)
  console.log('迈康 MyCare · Step 11 缺陷修复验收（D-1 未记录被读成 0 / D-2 两套风险等级）')
  console.log(line)
  console.log(`基准库 : ${BASE_DB}`)
  console.log(`副本库 : ${TEST_DB}`)
  console.log(line)

  const server = startServer()
  const up = await waitForServer()

  try {
    check('S0 隔离服务启动（副本库 + 独立端口）', up, `listening on ${PORT}`)
    if (!up) throw new Error('服务未启动')

    /* ====================================================================== *
     * D-1 · 第 1 段：根因与不变量
     * ====================================================================== */
    console.log('\n[D-1 · 1] NULL 语义：缺测必须是 null，不是 0')

    const pid1 = 'patient_1'
    const rec1 = await getPatientRecords(pid1, 7)
    /** 缺测日：该日部分字段为 NULL（主库 2026-09-15 只录了步数） */
    const partialDay = rec1.records.find(
      (r) =>
        r.record_date === '2026-09-15' ||
        (r.systolic_pressure === null && r.fasting_glucose === null && r.steps !== null)
    )
    samples.partialDay = partialDay || null

    check(
      '1a 缺测日的血压/血糖为 null（视图层不再伪造 0）',
      Boolean(partialDay) &&
        partialDay.systolic_pressure === null &&
        partialDay.diastolic_pressure === null &&
        partialDay.blood_sugar === null &&
        partialDay.fasting_glucose === null &&
        partialDay.bloodPressure?.systolic === null &&
        partialDay.bloodPressure?.diastolic === null &&
        partialDay.bloodSugar === null,
      partialDay
        ? `date=${partialDay.record_date} sys=${partialDay.systolic_pressure} bpAlias=${JSON.stringify(partialDay.bloodPressure)} bgAlias=${partialDay.bloodSugar}`
        : '未找到缺测日样本'
    )

    /** 修复前语义：把视图层曾经的 `?? 0` 伪造动作在内存中重放一遍 */
    const refabricate = (records) =>
      records.map((r) => ({
        ...r,
        bloodPressure: {
          systolic: r.systolic_pressure ?? r.bloodPressure?.systolic ?? 0,
          diastolic: r.diastolic_pressure ?? r.bloodPressure?.diastolic ?? 0,
        },
        bloodSugar: r.blood_sugar ?? r.bloodSugar ?? 0,
        bloodSugarAlias: r.blood_sugar ?? r.bloodSugar ?? 0,
        heartRate: r.heart_rate ?? r.heartRate ?? 0,
        exerciseMinutes: r.exercise_minutes ?? r.exerciseMinutes ?? 0,
      }))

    const preFixRecords = refabricate(rec1.records) // 修复前语义
    const postFixRecords = rec1.records // 修复后（当前实现）

    const preSeries = seriesOf(preFixRecords, 'systolic')
    const postSeries = seriesOf(postFixRecords, 'systolic')
    const preBgSeries = seriesOf(preFixRecords, 'bloodSugar')
    const postBgSeries = seriesOf(postFixRecords, 'bloodSugar')

    check(
      '1b 修复后：规则序列中不再出现伪造的 0',
      postSeries.every((p) => p.value !== 0) && postBgSeries.every((p) => p.value !== 0),
      `血压序列=${JSON.stringify(postSeries.map((p) => p.value))} 血糖序列=${JSON.stringify(postBgSeries.map((p) => p.value))}`
    )
    check(
      '1c 修复后：缺测日不进序列（既不进分子也不进分母）',
      partialDay
        ? !postSeries.some((p) => p.date === partialDay.record_date) &&
          !postBgSeries.some((p) => p.date === partialDay.record_date)
        : false,
      partialDay ? `缺测日 ${partialDay.record_date} 已排除` : '无样本'
    )
    check(
      '1d 对照组成立：修复前语义下 0 确实会进入序列（证明反事实有效）',
      preSeries.some((p) => p.value === 0) && preBgSeries.some((p) => p.value === 0),
      `修复前血压序列末尾=${preSeries[preSeries.length - 1]?.value} 血糖序列末尾=${preBgSeries[preBgSeries.length - 1]?.value}`
    )
    check(
      '1e 真实非 NULL 数据仍被正确读取（逐值等于库中值）',
      (() => {
        const expect = rec1.records
          .map((r, i) => ({ d: r.record_date, v: r.systolic_pressure }))
          .filter((x) => x.v !== null)
        const got = postSeries.map((p) => ({ d: p.date, v: p.value }))
        return JSON.stringify(expect) === JSON.stringify(got)
      })(),
      `${postSeries.length} 条（有序逐值比对）`
    )

    console.log('\n[D-1 · 2] NULL 与真 0 严格区分（不做 `> 0` 粗暴过滤）')
    const zeroSteps = seriesOf([{ record_date: '2026-01-01', steps: 0 }], 'steps')
    const zeroSys = seriesOf([{ record_date: '2026-01-01', systolic_pressure: 0 }], 'systolic')
    check(
      '2a 真 0 不被过滤（步数 0 / 收缩压 0 都保留为有效数值）',
      zeroSteps.length === 1 &&
        zeroSteps[0].value === 0 &&
        zeroSys.length === 1 &&
        zeroSys[0].value === 0,
      `steps=${JSON.stringify(zeroSteps.map((x) => x.value))} sys=${JSON.stringify(zeroSys.map((x) => x.value))}`
    )
    const legacy = seriesOf(
      [{ record_date: '2026-01-02', bloodPressure: { systolic: 130, diastolic: 80 } }],
      'systolic'
    )
    check(
      '2b 旧字段命名仍兼容（只有视图别名、没有 DB 列名的记录仍能取到值）',
      legacy.length === 1 && legacy[0].value === 130,
      `取值=${legacy[0]?.value}`
    )
    const missingOnly = seriesOf([{ record_date: '2026-01-03', systolic_pressure: null }], 'systolic')
    check(
      '2c 纯缺测记录不产生任何序列点（未记录 ≠ 测得 0）',
      missingOnly.length === 0,
      `序列长度=${missingOnly.length}`
    )

    /* ====================================================================== *
     * D-1 · 第 3 段：反事实结论
     * ====================================================================== */
    console.log('\n[D-1 · 3] 反事实实验：同一输入，修复前 vs 修复后')

    const ctx1 = await buildAgentContext(pid1, { days: 7 })
    const rulePatient1 = toRulePatient(ctx1)
    const evPre = evaluateClinicalRules(rulePatient1, preFixRecords)
    const evPost = evaluateClinicalRules(rulePatient1, postFixRecords)

    const tbl = {
      修复前: {
        最高等级: evPre.highestLevel,
        命中规则: evPre.matched.map((m) => `${m.ruleId}(${m.level})`),
        血压7天涨幅: evPre.stats.bloodPressure?.rise ?? null,
        血糖极差: evPre.stats.bloodSugar?.range ?? null,
        血糖最低: evPre.stats.bloodSugar?.min ?? null,
        血压达标率: evPre.stats.bloodPressure?.complianceRate ?? null,
        血压达标分母: evPre.stats.bloodPressure?.totalDays ?? null,
      },
      修复后: {
        最高等级: evPost.highestLevel,
        命中规则: evPost.matched.map((m) => `${m.ruleId}(${m.level})`),
        血压7天涨幅: evPost.stats.bloodPressure?.rise ?? null,
        血糖极差: evPost.stats.bloodSugar?.range ?? null,
        血糖最低: evPost.stats.bloodSugar?.min ?? null,
        血压达标率: evPost.stats.bloodPressure?.complianceRate ?? null,
        血压达标分母: evPost.stats.bloodPressure?.totalDays ?? null,
      },
    }
    samples.counterfactual = tbl
    for (const [k, v] of Object.entries(tbl)) {
      console.log(
        `  · ${k}: 等级=${v.最高等级} 涨幅=${v.血压7天涨幅} 血糖[min/极差]=${v.血糖最低}/${v.血糖极差} 达标率=${v.血压达标率}% 分母=${v.血压达标分母} 命中=[${v.命中规则.join(', ')}]`
      )
    }

    const preIds = new Set(evPre.matched.map((m) => m.ruleId))
    const postIds = new Set(evPost.matched.map((m) => m.ruleId))
    const recordedDays = rec1.records.filter((r) => r.systolic_pressure !== null).length

    check(
      '3a 修复后最高等级不再被伪造 0 扭曲（对照：修复前不同）',
      evPost.highestLevel !== evPre.highestLevel &&
        evPost.highestLevel === 'alert',
      `pre=${evPre.highestLevel} post=${evPost.highestLevel}`
    )
    check(
      '3b 修复后命中真实预警 R-BP-2（修复前被末尾 0 掩盖）',
      postIds.has('R-BP-2') && !preIds.has('R-BP-2'),
      `pre=${[...preIds].join('/')} post=${[...postIds].join('/')}`
    )
    check(
      '3c 修复后不再产生假预警 R-BG-2（该日并未测血糖）',
      !postIds.has('R-BG-2') && preIds.has('R-BG-2'),
      `pre=${preIds.has('R-BG-2')} post=${postIds.has('R-BG-2')}`
    )
    check(
      '3d 血压 7 天涨幅回到真实值（修复前因末尾 0 变负）',
      Number(evPost.stats.bloodPressure?.rise) > 0 && Number(evPre.stats.bloodPressure?.rise) < 0,
      `pre=${evPre.stats.bloodPressure?.rise} post=${evPost.stats.bloodPressure?.rise}`
    )
    check(
      '3e 血糖极差/最低回到真实值（修复前的「最低 0」是伪造值）',
      Number(evPost.stats.bloodSugar?.min) > 0 &&
        Number(evPre.stats.bloodSugar?.min) === 0 &&
        Number(evPost.stats.bloodSugar?.range) < Number(evPre.stats.bloodSugar?.range),
      `pre min=${evPre.stats.bloodSugar?.min} range=${evPre.stats.bloodSugar?.range} / post min=${evPost.stats.bloodSugar?.min} range=${evPost.stats.bloodSugar?.range}`
    )
    check(
      '3f 达标率口径：缺测日不进分母（分母 = 有记录日数）',
      Number(evPost.stats.bloodPressure?.totalDays) === recordedDays &&
        Number(evPre.stats.bloodPressure?.totalDays) === rec1.records.length &&
        Number(evPost.stats.bloodPressure?.complianceRate) <
          Number(evPre.stats.bloodPressure?.complianceRate),
      `有记录 ${recordedDays} 日 / 窗口 ${rec1.records.length} 日；达标率 pre=${evPre.stats.bloodPressure?.complianceRate}% → post=${evPost.stats.bloodPressure?.complianceRate}%`
    )

    console.log('\n[D-1 · 4] 同一类「缺测语义」在规则层内保持一致')
    const onlyStepsDay = { steps: 10333, exercise_minutes: 60 }
    const scoreDetail = computeDailyHealthScore({
      today: onlyStepsDay,
      diseases: ['原发性高血压', '2 型糖尿病'],
    })
    check(
      '4a healthScore：缺测维度按 0 分计入且标 missing（不因缺测而虚高）',
      scoreDetail.score < 100 &&
        scoreDetail.missing.includes('血压') &&
        scoreDetail.missing.includes('血糖'),
      `score=${scoreDetail.score} missing=[${scoreDetail.missing.join('、')}]`
    )
    check(
      '4b clinicalRules：缺测日既不算达标也不进分母（与 4a 同向：缺测 ≠ 达标）',
      Number(evPost.stats.bloodPressure?.compliantDays) <=
        Number(evPre.stats.bloodPressure?.compliantDays) &&
        Number(evPost.stats.bloodPressure?.totalDays) ===
          Number(evPre.stats.bloodPressure?.totalDays) - 1,
      `达标日 pre=${evPre.stats.bloodPressure?.compliantDays} → post=${evPost.stats.bloodPressure?.compliantDays}`
    )

    /* ====================================================================== *
     * D-2 · 第 5 段：离线一致性（唯一裁定者）
     * ====================================================================== */
    console.log('\n[D-2 · 5] 等级唯一来源：assessRisk === clinicalRules（4 位患者）')

    const offline = {}
    for (const pid of PIDS) {
      const ctx = await buildAgentContext(pid, { days: 7 }).catch(() => null)
      if (!ctx) {
        offline[pid] = { skipped: true }
        continue
      }
      const rp = toRulePatient(ctx)
      const ev = evaluateClinicalRules(rp, ctx.records)
      const risk = assessRisk(ctx.records, ctx.user, ev)
      const trigIds = ev.triggered.map((m) => m.ruleId).sort()
      const riskIds = risk.risks.map((r) => r.ruleId).sort()
      offline[pid] = {
        clinicalRules: ev.highestLevel,
        assessRisk: risk.highestLevel,
        label: risk.levelLabel,
        alertsExpected: highestAlertLevel(ev.triggered.map((m) => m.level)) === ev.highestLevel,
        trigIds,
        riskIds,
        score: risk.score,
        obsKeys: risk.observations.map((o) => Object.keys(o).sort().join(',')),
      }
    }
    samples.offline = offline
    for (const [pid, o] of Object.entries(offline)) {
      if (o.skipped) {
        console.log(`  · ${pid}: 副本库中不存在 → 跳过（报告以线上接口为准）`)
        continue
      }
      console.log(
        `  · ${pid}: clinicalRules=${o.clinicalRules} assessRisk=${o.assessRisk} label=${o.label} 命中=[${o.riskIds.join(', ')}]`
      )
    }

    const present = Object.entries(offline).filter(([, o]) => !o.skipped)
    check(
      '5a assessRisk 的等级全部等于 clinicalRules 的等级',
      present.length > 0 && present.every(([, o]) => o.assessRisk === o.clinicalRules),
      present.map(([p, o]) => `${p}:${o.assessRisk}/${o.clinicalRules}`).join(' ')
    )
    check(
      '5b assessRisk.risks 恰为 clinicalRules 的「关注及以上」命中项（ruleId 集合一致）',
      present.every(([, o]) => JSON.stringify(o.trigIds) === JSON.stringify(o.riskIds)),
      present.map(([p, o]) => `${p}:[${o.riskIds.join('/')}]`).join(' ')
    )
    check(
      '5c highestAlertLevel(triggered) 与 highestLevel 自洽',
      present.every(([, o]) => o.alertsExpected === true),
      present.map(([p, o]) => `${p}:${o.alertsExpected}`).join(' ')
    )
    check(
      '5d 等级序 score 与 ALERT_LEVEL.order 同源',
      present.every(([, o]) => o.score === ALERT_LEVEL[o.assessRisk]?.order),
      present.map(([p, o]) => `${p}:${o.score}`).join(' ')
    )
    check(
      '5e observations 只有描述字段（title/detail/action），不含任何等级键',
      present.every(([, o]) => o.obsKeys.every((k) => k === 'action,detail,title')),
      present.map(([, o]) => `[${o.obsKeys.join('|')}]`).slice(0, 2).join(' ')
    )

    console.log('\n[D-2 · 6] 静态证明：assessRisk 内不再有「比较阈值 → 决定等级」的判定')
    const toolsSrc = fs.readFileSync(path.join(ROOT, 'server', 'agents', 'tools.js'), 'utf8')
    const startIdx = toolsSrc.indexOf('export function assessRisk(')
    const endIdx = toolsSrc.indexOf('\n/**', startIdx + 10)
    const body = toolsSrc.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 3000)
    const forbidden = ["'critical'", "'high'", "'medium'", "'low'", '>= 180', '>= 160', '16.7', '11.1', '120', '3.9']
    const hits = forbidden.filter((f) => body.includes(f))
    check(
      '6a assessRisk 函数体内不存在第二套阈值与内部等级字面量',
      startIdx > 0 && hits.length === 0,
      hits.length ? `命中：${hits.join(' ')}` : '零命中'
    )
    const mockSrc = fs.readFileSync(path.join(ROOT, 'server', 'agents', 'mock.js'), 'utf8')
    const dupLabel = /\{\s*critical:\s*'紧急'/.test(toolsSrc) || /\{\s*critical:\s*'紧急'/.test(mockSrc)
    check(
      '6b 项目内只剩一份等级标签表（ALERT_LEVEL），不再各自复制中文标签映射',
      !dupLabel,
      dupLabel ? '仍存在重复标签映射' : '已统一到 ALERT_LEVEL'
    )
    const homeSrc = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'HomePage.jsx'), 'utf8')
    check(
      '6c 首页风险标签不再按内部键位着色，与预警卡片共用同一套等级色',
      /LEVEL_COLOR\[briefing\.risk\?\.label\]/.test(homeSrc) &&
        !/highestLevel === 'critical'/.test(homeSrc),
      '标签色取自 LEVEL_COLOR[label]'
    )

    /* ====================================================================== *
     * D-2 · 第 7 段：线上闭环（隔离端口真实服务）
     * ====================================================================== */
    console.log('\n[D-2 · 7] 线上闭环：briefing / clinicalRules（医生端）/ alerts 三者等级一致')

    const doctorView = await req('GET', '/api/doctors/doc_li/patients')
    const docById = {}
    for (const p of doctorView.json?.patients || []) docById[p.id] = p
    // 基准库决定线上可见的患者集合（主库 4 位 / 副本库 3 位），断言只针对实际存在的患者
    const HTTP_PIDS = PIDS.filter((p) => docById[p])
    console.log(`  · 线上可见患者：${HTTP_PIDS.join(', ')}（基准库 ${path.basename(BASE_DB)}）`)

    // 先把确定性规则命中落库（与 /api/agent/orchestrate 的收尾动作同一函数，不含模型调用），
    // 保证 alerts 不是基于旧数据的陈旧快照
    for (const pid of HTTP_PIDS) {
      const ctx = await buildAgentContext(pid, { days: 7 })
      await persistRuleAlerts(pid, buildRuleEvaluation(ctx), { source: 'rule_engine' })
    }

    const online = {}
    for (const pid of HTTP_PIDS) {
      const br = await req('POST', '/api/agent/briefing', { patientId: pid })
      const al = await req('GET', `/api/patients/${pid}/alerts?limit=20`)
      const doc = docById[pid]
      const evLevel = doc?.evaluation?.highestLevel || null
      const labels = (al.json?.alerts || []).map((a) => a.level)
      const KEY_BY_LABEL = Object.fromEntries(
        Object.entries(ALERT_LEVEL).map(([k, v]) => [v.label, k])
      )
      const alertKeys = labels.map((l) => KEY_BY_LABEL[l]).filter(Boolean)
      const topLabel = alertKeys.length ? ALERT_LEVEL[highestAlertLevel(alertKeys)].label : null
      online[pid] = {
        briefingLevel: br.json?.risk?.highestLevel ?? null,
        briefingLabel: br.json?.risk?.label ?? null,
        headline: br.json?.headline ?? null,
        itemIds: (br.json?.risk?.items || []).map((i) => i.ruleId).filter(Boolean),
        matchedIds: (doc?.evaluation?.matched || []).map((m) => m.ruleId),
        doctorLevel: evLevel,
        alerts: labels,
        alertsTop: topLabel,
        status: br.status,
      }
    }
    samples.online = online
    for (const [pid, o] of Object.entries(online)) {
      console.log(
        `  · ${pid}: briefing=${o.briefingLevel}/${o.briefingLabel} | 医生端(clinicalRules)=${o.doctorLevel} | alerts=[${o.alerts.join(', ') || '无'}]`
      )
    }

    check(
      '7a briefing 均返回 200 且等级为产品键（1–4 档词表）',
      HTTP_PIDS.every((p) => ['info', 'watch', 'alert', 'emergency'].includes(online[p].briefingLevel)),
      HTTP_PIDS.map((p) => `${p}:${online[p].briefingLevel}`).join(' ')
    )
    check(
      '7b briefing 等级 === 医生端 evaluation.highestLevel（同一 clinicalRules）',
      HTTP_PIDS.every((p) => !online[p].doctorLevel || online[p].briefingLevel === online[p].doctorLevel),
      HTTP_PIDS.map((p) => `${p}:${online[p].briefingLevel}/${online[p].doctorLevel}`).join(' ')
    )
    check(
      '7c briefing.label / headline 与等级一一对应（同一词表）',
      HTTP_PIDS.every((p) => {
        const o = online[p]
        if (!o.briefingLevel) return false
        const expectLabel = ALERT_LEVEL[o.briefingLevel].label
        const headOk = {
          emergency: '出现危险值，请优先处理预警项',
          alert: '指标达到预警等级，今天需要重点关注',
          watch: '整体可控，个别指标需留意',
          info: '各项指标平稳，继续保持',
        }[o.briefingLevel]
        return o.briefingLabel === expectLabel && o.headline === headOk
      }),
      HTTP_PIDS.map((p) => `${p}:${online[p].briefingLabel}「${String(online[p].headline).slice(0, 10)}…」`).join(' ')
    )
    check(
      '7d briefing 的检出项取自 clinicalRules 命中集（ruleId ⊆ matched）',
      HTTP_PIDS.every((p) => {
        const o = online[p]
        return o.itemIds.every((id) => o.matchedIds.includes(id))
      }),
      HTTP_PIDS.map((p) => `${p}:[${online[p].itemIds.join('/')}]⊆[${online[p].matchedIds.length}条]`).join(' ')
    )
    check(
      '7e **同屏不再矛盾**：晨报等级与落库预警卡片等级一致（无预警时必为「提示」）',
      HTTP_PIDS.every((p) => {
        const o = online[p]
        const expect = ALERT_LEVEL[o.briefingLevel]?.label
        return o.alerts.length === 0 ? o.briefingLevel === 'info' : o.alertsTop === expect
      }),
      HTTP_PIDS.map((p) => {
        const o = online[p]
        return `${p}: briefing=${o.briefingLabel} vs alerts=${o.alerts.join('/') || '无'}`
      }).join(' | ')
    )
  } catch (e) {
    check('EX 执行未抛异常', false, e.message)
  } finally {
    server.kill()
    await sleep(500)
  }

  /* ---- 主库零改动核验 ---- */
  if (MAIN_MTIME_BEFORE !== null) {
    check(
      'Z1 真实库零改动（本次验收全程只读主库，仅操作副本）',
      fs.statSync(MAIN_DB).mtimeMs === MAIN_MTIME_BEFORE,
      `main=${path.basename(MAIN_DB)}`
    )
  }

  console.log(line)
  console.log(`==== Step 11 缺陷修复验收：${passed}/${passed + failed} 通过 ====`)
  console.log(line)

  fs.writeFileSync(
    path.join(ROOT, 'data', 'step11-fixes-verify-record.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseDb: BASE_DB,
        testDb: TEST_DB,
        checks,
        samples,
        summary: { passed, failed, total: passed + failed, allPass: failed === 0 },
      },
      null,
      2
    ),
    'utf8'
  )
  try {
    fs.rmSync(TEST_DB, { force: true })
  } catch {
    /* ignore */
  }
  if (failed) process.exitCode = 1
}

main()
