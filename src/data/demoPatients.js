/**
 * 迈康 MyCare · 示范病例唯一数据源
 * ---------------------------------------------------------------------------
 * 本文件是三位示范病例（张建国 / 李秀英 / 王建军）的**唯一**业务数据来源。
 * 登录页、首页、健康数据页、医生端、截图脚本、演示视频脚本、数据库 seed
 * 一律从这里取数，避免出现多套互不一致的演示数据。
 *
 * 依据文档：docs/演示人设设定书_v2.md（定稿）
 * 医学依据：
 *   《中国高血压防治指南（2024 年修订版）》
 *   《中国老年高血压管理指南（2023）》
 *   《中国 2 型糖尿病防治指南（2020 年版）》
 *   《肥胖症诊疗指南（2024 年版）》
 *
 * 口径红线（严禁违反）：
 *   1. 疾病诊断 / 心血管危险分层（医学）与 产品预警等级（系统）是两套词表，互不借用；
 *   2. 产品侧不得出现「高危 / 重度 / 危象」等医学分层术语；
 *   3. 单次血压测量不作为分级诊断依据；
 *   4. 糖尿病演示判定阈值 7.8 mmol/L 仅为本病例个体化阈值，非普适标准；
 *   5. 体重变化不得表述为「脂肪减少」，不得出现「平台期」。
 */

/** 产品预警等级（系统词表，非医学分层） */
export const ALERT_LEVELS = {
  info: { key: 'info', label: '提示', order: 1 },
  watch: { key: 'watch', label: '关注', order: 2 },
  alert: { key: 'alert', label: '预警', order: 3 },
  emergency: { key: 'emergency', label: '紧急', order: 4 },
}

export const EMERGENCY_CONTACT_NOTICE =
  '通知紧急联系人属于敏感操作，需在用户已授权且本人点击确认后才会执行。'

/* ========================================================================== *
 * 病例 A · 张建国 · 原发性高血压 2 级
 * ========================================================================== */
const PATIENT_ZHANG = {
  id: 'patient_1',
  demoCode: '张三',

  profile: {
    name: '张建国',
    gender: '男',
    age: 68,
    height: 170,
    weight: 75.0,
    bmi: 26.0,
    waist: 92,
    phone: '13800138001',
    username: 'zhangjianguo',
    occupation: '退休（原机械厂工人）',
    emergencyContact: {
      name: '张伟',
      relation: '儿子',
      phone: '13800138002',
      authorized: true,
    },
    elderlyMode: true,
    voiceEnabled: true,
  },

  lifestyle: {
    diet: '口味偏咸，日均食盐约 10 g，爱吃腌菜',
    exercise: '偶尔散步，无固定运动习惯',
    sleep: '入睡偏晚，日均约 6 小时',
    biggestDifficulty: '担心血压控制不住',
    aiStyle: '安抚 + 警示',
    motivation: '怕给子女添麻烦',
    tags: {
      highSalt: true,
      pickledFood: true,
      refinedStaple: false,
      fastEating: false,
      lowVegetable: false,
      lateHeavyDinner: false,
      irregularMeals: false,
      sedentary: false,
      snoring: false,
    },
  },

  medical: {
    primaryDisease: '原发性高血压',
    diseaseGrade: '2 级',
    diseaseDuration: '确诊 3 年',
    secondaryDiseases: ['超重', '中心性肥胖'],
    riskStratification: '中危',
    riskStratificationBasis: '2 级高血压 + 1～2 个心血管危险因素（男性 ≥55 岁、超重/中心性肥胖）',
    controlTarget: '诊室血压 < 140/90 mmHg',
    targetBasis: '《中国老年高血压管理指南 2023》：65–79 岁先降至 < 140/90，能耐受可进一步 < 130/80',
    comorbidities: ['超重', '中心性肥胖'],
    organDamage: '无（眼底、尿微量白蛋白、心电图均未见异常）',
    hba1c: null,
    demoThreshold: { systolic: 140, diastolic: 90 },
    demoThresholdNote: '本病例控制目标 < 140/90 mmHg',
    singleReadingNotice:
      'D7 单次 162/98 mmHg 落入 2 级区间，作为趋势恶化信号使用，不单独作为分级诊断依据。',
  },

  medications: [
    {
      name: '苯磺酸氨氯地平片',
      dosage: '5 mg',
      time: '08:00',
      frequency: '每日 1 次',
      note: '晨服（钙通道阻滞剂，老年高血压一线用药）',
    },
  ],

  /** offset：距今天的天数，6 = 最早一天，0 = 今天 */
  healthRecords: [
    { offset: 6, systolic: 132, diastolic: 84, bloodSugar: 5.4, weight: 75.2, heartRate: 74, steps: 6800, exerciseMinutes: 30, sleepHours: 6.5, moodScore: 4, notes: '' },
    { offset: 5, systolic: 136, diastolic: 86, bloodSugar: 5.2, weight: 75.1, heartRate: 76, steps: 6200, exerciseMinutes: 25, sleepHours: 6.0, moodScore: 4, notes: '' },
    { offset: 4, systolic: 138, diastolic: 88, bloodSugar: 5.6, weight: 75.1, heartRate: 78, steps: 5400, exerciseMinutes: 20, sleepHours: 5.8, moodScore: 3, notes: '' },
    { offset: 3, systolic: 144, diastolic: 90, bloodSugar: 5.3, weight: 75.0, heartRate: 80, steps: 6100, exerciseMinutes: 25, sleepHours: 6.2, moodScore: 4, notes: '' },
    { offset: 2, systolic: 152, diastolic: 94, bloodSugar: 5.5, weight: 75.0, heartRate: 82, steps: 5800, exerciseMinutes: 20, sleepHours: 5.5, moodScore: 3, notes: '' },
    { offset: 1, systolic: 158, diastolic: 96, bloodSugar: 5.8, weight: 75.0, heartRate: 84, steps: 4800, exerciseMinutes: 15, sleepHours: 5.8, moodScore: 3, notes: '' },
    { offset: 0, systolic: 162, diastolic: 98, bloodSugar: 5.4, weight: 75.0, heartRate: 82, steps: 5200, exerciseMinutes: 20, sleepHours: 6.0, moodScore: 3, notes: '' },
  ],

  badges: [
    { type: '初次记录', name: '迈出第一步', description: '完成第一次健康数据记录', icon: '⭐', points: 10 },
    { type: '连续记录', name: '坚持不懈', description: '连续 7 天记录健康数据', icon: '📊', points: 30 },
  ],

  initialPoints: 190,

  demoScenario: {
    theme: '预防风险',
    themeKey: 'prevention',
    demoAlertLevel: '预警',
    alertBasis: '连续 4 天收缩压 ≥140 mmHg，且 7 天收缩压涨幅 +30 mmHg',
    keyEvent: 'D7 录入 162/98 mmHg，触发连续异常趋势预警',
    expectedRules: ['R-BP-2', 'R-BP-4'],
    forbiddenRules: ['R-BP-3'],
    agentAction: ['raise_alert', 'schedule_reminder', 'notify_emergency_contact（需用户确认）'],
    recommendedAction: '低盐饮食 + 48 小时内复诊评估用药',
    headline: '风险已记录，建议近期复诊',
    focusVitals: ['systolic_pressure', 'diastolic_pressure'],
  },
}

/* ========================================================================== *
 * 病例 B · 李秀英 · 2 型糖尿病
 * ========================================================================== */
const PATIENT_LI = {
  id: 'patient_2',
  demoCode: '李四',

  profile: {
    name: '李秀英',
    gender: '女',
    age: 65,
    height: 158,
    weight: 66.0,
    bmi: 26.4,
    waist: 88,
    phone: '13800138011',
    username: 'lixiuying',
    occupation: '退休（原小学教师）',
    emergencyContact: {
      name: '李娜',
      relation: '女儿',
      phone: '13800138012',
      authorized: true,
    },
    elderlyMode: true,
    voiceEnabled: true,
  },

  lifestyle: {
    diet: '主食以面食为主，蔬菜偏少，进餐速度快',
    exercise: '以家务活动为主，无专门锻炼',
    sleep: '基本规律，日均约 7 小时',
    biggestDifficulty: '对反复波动的血糖感到挫败',
    aiStyle: '共情 + 指导',
    motivation: '想减少用药',
    tags: {
      highSalt: false,
      pickledFood: false,
      refinedStaple: true,
      fastEating: true,
      lowVegetable: true,
      lateHeavyDinner: false,
      irregularMeals: false,
      sedentary: false,
      snoring: false,
    },
  },

  medical: {
    primaryDisease: '2 型糖尿病',
    diseaseGrade: null,
    diseaseDuration: '确诊 5 年',
    secondaryDiseases: ['超重', '血脂异常'],
    riskStratification: '中危',
    riskStratificationBasis: '糖尿病合并超重与血脂异常，无靶器官损害',
    controlTarget: '空腹 5.0–7.8 mmol/L，HbA1c 7.0%–7.5%',
    targetBasis: '《中国 2 型糖尿病防治指南 2020》：老年、健康状况良好者采用个体化控制目标',
    comorbidities: ['超重', '血脂异常（TG 1.9 mmol/L ↑）'],
    organDamage: '无（尿微量白蛋白正常、眼底未见糖网、足背动脉搏动正常）',
    hba1c: 7.8,
    hba1cNote: 'HbA1c 反映近 2–3 个月平均血糖，属长期控制指标，不随 7 天血糖波动',
    hba1cLastTestMonthsAgo: 2,
    demoThreshold: { fastingGlucose: 7.8 },
    demoThresholdNote:
      '本病例根据老年患者个体化控制目标，演示判定阈值采用空腹血糖 7.8 mmol/L；该阈值仅用于本项目的趋势分析、达标率计算与演示逻辑，不表述为所有老年糖尿病患者统一适用的医学标准。',
    singleReadingNotice: '7 天血糖为近期趋势指标，与 HbA1c 的时间尺度不同，二者分开展示。',
  },

  medications: [
    {
      name: '二甲双胍片',
      dosage: '0.5 g',
      time: '08:00 / 18:00',
      frequency: '每日 2 次',
      note: '随餐或餐后服用，减少胃肠道反应',
    },
    {
      name: '阿卡波糖片',
      dosage: '50 mg',
      time: '07:30 / 12:30 / 18:30',
      frequency: '每日 3 次',
      note: '随第一口主食嚼服，降低餐后血糖峰值',
    },
  ],

  healthRecords: [
    { offset: 6, systolic: 132, diastolic: 80, bloodSugar: 7.1, weight: 66.2, heartRate: 76, steps: 5200, exerciseMinutes: 25, sleepHours: 7.0, moodScore: 4, notes: '' },
    { offset: 5, systolic: 130, diastolic: 78, bloodSugar: 7.6, weight: 66.1, heartRate: 78, steps: 4800, exerciseMinutes: 20, sleepHours: 6.8, moodScore: 3, notes: '' },
    { offset: 4, systolic: 134, diastolic: 82, bloodSugar: 7.3, weight: 66.1, heartRate: 74, steps: 6200, exerciseMinutes: 30, sleepHours: 7.2, moodScore: 4, notes: '' },
    { offset: 3, systolic: 136, diastolic: 84, bloodSugar: 8.1, weight: 66.0, heartRate: 80, steps: 4500, exerciseMinutes: 20, sleepHours: 6.5, moodScore: 3, notes: '' },
    { offset: 2, systolic: 128, diastolic: 78, bloodSugar: 7.8, weight: 66.0, heartRate: 76, steps: 5600, exerciseMinutes: 35, sleepHours: 7.5, moodScore: 4, notes: '' },
    { offset: 1, systolic: 134, diastolic: 80, bloodSugar: 8.5, weight: 66.0, heartRate: 82, steps: 4200, exerciseMinutes: 20, sleepHours: 6.6, moodScore: 3, notes: '' },
    { offset: 0, systolic: 130, diastolic: 80, bloodSugar: 8.3, weight: 66.0, heartRate: 78, steps: 5400, exerciseMinutes: 40, sleepHours: 7.0, moodScore: 3, notes: '' },
  ],

  badges: [
    { type: '初次记录', name: '迈出第一步', description: '完成第一次健康数据记录', icon: '⭐', points: 10 },
    { type: '连续记录', name: '坚持不懈', description: '连续 7 天记录健康数据', icon: '📊', points: 30 },
  ],

  initialPoints: 220,

  demoScenario: {
    theme: '辅助管理',
    themeKey: 'management',
    demoAlertLevel: '预警',
    alertBasis: '7 天空腹血糖达标率 57.1%（低于 60%）且趋势向上，7 天极差 1.4 mmol/L',
    keyEvent: 'D7 录入空腹血糖 8.3 mmol/L，触发控制不佳趋势规则',
    expectedRules: ['R-BG-2', 'R-BG-3'],
    forbiddenRules: [],
    agentAction: ['draft_intervention_plan（引用饮食画像）', 'schedule_reminder', 'companion 共情'],
    recommendedAction: '调整进食顺序与主食结构 + 复查 HbA1c',
    headline: '血糖趋势已记录，建议 3 个月后复查 HbA1c',
    focusVitals: ['blood_sugar'],
  },
}

/* ========================================================================== *
 * 病例 C · 王建军 · 肥胖症
 * ========================================================================== */
const PATIENT_WANG = {
  id: 'patient_3',
  demoCode: '王五',

  profile: {
    name: '王建军',
    gender: '男',
    age: 62,
    height: 172,
    weight: 92.0,
    bmi: 31.1,
    waist: 104,
    phone: '13800138021',
    username: 'wangjianjun',
    occupation: '退休 / 半退休（原出租车司机）',
    emergencyContact: {
      name: '王小雨',
      relation: '女儿',
      phone: '13800138022',
      // 刻意设为未授权：用于演示「未授权时系统只记录、不自动外发」的合规路径
      authorized: false,
    },
    elderlyMode: true,
    voiceEnabled: true,
  },

  lifestyle: {
    diet: '三餐不规律，晚餐偏多，常吃夜宵',
    exercise: '久坐，日均久坐 8 小时以上',
    sleep: '打鼾明显，日均约 6.5 小时（需警惕阻塞性睡眠呼吸暂停）',
    biggestDifficulty: '容易放弃，难以坚持',
    aiStyle: '鼓励 + 激励',
    motivation: '想减回年轻时的体重',
    tags: {
      highSalt: false,
      pickledFood: false,
      refinedStaple: false,
      fastEating: false,
      lowVegetable: false,
      lateHeavyDinner: true,
      irregularMeals: true,
      sedentary: true,
      snoring: true,
    },
  },

  medical: {
    primaryDisease: '肥胖症',
    diseaseGrade: '一级（BMI 31.1，28.0–32.4）',
    diseaseDuration: '超重 10 余年，近期体重持续上升',
    secondaryDiseases: ['代谢综合征', '空腹血糖受损'],
    riskStratification: '合并代谢综合征',
    riskStratificationBasis:
      '代谢综合征（CDS 标准）具备 3 项：BMI 31.1、空腹血糖 6.3 mmol/L、TG 2.4 ↑ 与 HDL-C 0.92 ↓',
    controlTarget: '3–6 个月减重 5%–10%（本例 4.6–9.2 kg），每周 0.5–1.0 kg 匀速下降',
    targetBasis: '《肥胖症诊疗指南 2024 年版》《中国成人超重和肥胖预防控制指南 2021》',
    comorbidities: ['代谢综合征', '空腹血糖受损（IFG 6.3 mmol/L）', '血脂紊乱（TG 2.4 ↑、HDL-C 0.92 ↓）'],
    organDamage: '未见明确靶器官损害；需排查阻塞性睡眠呼吸暂停',
    hba1c: null,
    demoThreshold: { bmi: 28.0, waist: 90 },
    demoThresholdNote: '中国标准 BMI ≥28.0 为肥胖，男性腰围 ≥90 cm 为中心性肥胖',
    singleReadingNotice:
      '体重受水分、糖原储备、进食与测量时间影响，7 天净变化不能等同于脂肪减少，也不宜线性外推。',
  },

  medications: [
    {
      name: '暂无长期用药',
      dosage: '—',
      time: '—',
      frequency: '—',
      note: '首选生活方式干预（医学营养治疗 + 运动治疗 + 行为干预）',
    },
  ],

  healthRecords: [
    { offset: 6, systolic: 138, diastolic: 88, bloodSugar: 6.0, weight: 92.0, heartRate: 84, steps: 3200, exerciseMinutes: 15, sleepHours: 6.5, moodScore: 3, notes: '' },
    { offset: 5, systolic: 136, diastolic: 86, bloodSugar: 6.2, weight: 91.8, heartRate: 82, steps: 3800, exerciseMinutes: 20, sleepHours: 6.8, moodScore: 4, notes: '' },
    { offset: 4, systolic: 140, diastolic: 88, bloodSugar: 6.1, weight: 91.6, heartRate: 86, steps: 4200, exerciseMinutes: 25, sleepHours: 6.4, moodScore: 3, notes: '' },
    { offset: 3, systolic: 134, diastolic: 84, bloodSugar: 6.3, weight: 91.0, heartRate: 80, steps: 5100, exerciseMinutes: 35, sleepHours: 7.0, moodScore: 4, notes: '' },
    { offset: 2, systolic: 135, diastolic: 85, bloodSugar: 6.0, weight: 90.6, heartRate: 78, steps: 5600, exerciseMinutes: 40, sleepHours: 6.6, moodScore: 4, notes: '' },
    { offset: 1, systolic: 138, diastolic: 86, bloodSugar: 6.4, weight: 91.2, heartRate: 84, steps: 3900, exerciseMinutes: 20, sleepHours: 6.2, moodScore: 3, notes: '' },
    { offset: 0, systolic: 136, diastolic: 84, bloodSugar: 6.2, weight: 90.8, heartRate: 82, steps: 6400, exerciseMinutes: 45, sleepHours: 6.9, moodScore: 4, notes: '' },
  ],

  badges: [
    { type: '初次记录', name: '迈出第一步', description: '完成第一次健康数据记录', icon: '⭐', points: 10 },
    { type: '连续记录', name: '坚持不懈', description: '连续 7 天记录健康数据', icon: '📊', points: 30 },
  ],

  initialPoints: 160,

  demoScenario: {
    theme: '促进坚持',
    themeKey: 'adherence',
    demoAlertLevel: '正向',
    alertBasis: '7 天净减 1.2 kg（含水分与测量波动），D5→D6 回升 0.6 kg 属短期反弹',
    keyEvent: 'D7 完成快走 45 分钟、步数 6400，周运动累计 200 分钟达标',
    expectedRules: ['R-WT-2', 'R-WT-3', 'R-WT-4', 'R-WT-5'],
    forbiddenRules: [],
    agentAction: ['正向反馈', '解释体重波动', '授予勋章', '设定明日目标'],
    recommendedAction: '继续保持，明日目标 8000 步',
    headline: '明天继续保持，目标 8000 步',
    focusVitals: ['weight', 'steps'],
  },
}

/** 三位示范病例（顺序即登录页展示顺序） */
export const DEMO_PATIENTS = [PATIENT_ZHANG, PATIENT_LI, PATIENT_WANG]

export const DEFAULT_PATIENT_ID = PATIENT_ZHANG.id

/* ========================================================================== *
 * 读取与转换
 * ========================================================================== */

export const getPatientById = (id) =>
  DEMO_PATIENTS.find((p) => p.id === id) || null

export const getPatientByUsername = (username) =>
  DEMO_PATIENTS.find((p) => p.profile.username === String(username || '').toLowerCase()) || null

export const getPatientByDemoCode = (code) =>
  DEMO_PATIENTS.find((p) => p.demoCode === code) || null

/** 登录页三个示范病例入口的展示信息 */
export const listDemoEntries = () =>
  DEMO_PATIENTS.map((p) => {
    const m = p.medical
    const shortGrade = m.diseaseGrade ? m.diseaseGrade.split('（')[0].trim() : ''
    return {
      id: p.id,
      name: p.profile.name,
      disease: shortGrade ? `${m.primaryDisease} ${shortGrade}` : m.primaryDisease,
      summary: p.demoScenario.theme,
      age: p.profile.age,
      gender: p.profile.gender,
      focus: m.controlTarget,
    }
  })

/** 患者档案 → 应用内 user 对象（兼容既有 UI 与后端工具的字段命名） */
export function toUserProfile(patient) {
  const p = patient.profile
  const m = patient.medical
  const diseases = [m.primaryDisease, ...(m.secondaryDiseases || [])].filter(Boolean)

  return {
    user_id: patient.id,
    demoCode: patient.demoCode,
    username: p.username,
    name: p.name,
    age: p.age,
    gender: p.gender,
    height: p.height,
    weight: p.weight,
    bmi: p.bmi,
    waist: p.waist,
    disease_types: diseases,
    // 兼容旧字段
    diseases,
    phone: p.phone,
    emergency_contact: `${p.emergencyContact.name}（${p.emergencyContact.relation}）${p.emergencyContact.phone}`,
    emergencyContact: p.emergencyContact,
    occupation: p.occupation,
    elderly_mode: p.elderlyMode,
    voice_enabled: p.voiceEnabled,
    // v2 新增：生活画像与医学设定（供 AI 个性化与医生端展示）
    lifestyle: patient.lifestyle,
    medical: patient.medical,
    medications: patient.medications,
    demoScenario: patient.demoScenario,
    created_at: new Date().toISOString(),
  }
}

const pad2 = (n) => String(n).padStart(2, '0')
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/**
 * 生成固定 7 天健康记录（内部分析用字段命名，normalizeRecord 会补齐视图模型字段）。
 * 数值完全来自本文件的静态脚本，不含任何随机数。
 */
export function toHealthRecords(patient, endDate = new Date()) {
  return (patient.healthRecords || []).map((r, index) => {
    const d = new Date(endDate)
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - (r.offset ?? 0))
    return {
      record_id: `${patient.id}_record_${index + 1}`,
      user_id: patient.id,
      record_date: dateKey(d),
      steps: r.steps,
      systolic_pressure: r.systolic,
      diastolic_pressure: r.diastolic,
      blood_sugar: r.bloodSugar,
      weight: r.weight,
      heart_rate: r.heartRate,
      exercise_minutes: r.exerciseMinutes,
      sleep_hours: r.sleepHours,
      mood_score: r.moodScore,
      notes: r.notes || '',
      created_at: d.toISOString(),
    }
  })
}

/** 患者固定勋章 */
export function toBadges(patient, endDate = new Date()) {
  return (patient.badges || []).map((b, index) => ({
    badge_id: `${patient.id}_badge_${index + 1}`,
    user_id: patient.id,
    badge_type: b.type,
    badge_name: b.name,
    badge_description: b.description,
    badge_icon: b.icon,
    earned_date: endDate.toISOString(),
    level: 1,
    points: b.points,
  }))
}

/** 患者固定积分 */
export const toPoints = (patient) => patient.initialPoints ?? 150

/** 演示数据的达标口径摘要（用于自检与 PPT 引用） */
export const DEMO_FACTS = {
  patient_1: {
    compliance: '血压达标率 42.9%（3/7 天）',
    trend: '收缩压 132 → 162 mmHg（+30）',
    keyRule: 'R-BP-2 连续异常趋势预警',
    notHit: 'R-BP-3 严重超标强预警（162 < 180）',
  },
  patient_2: {
    compliance: '空腹血糖达标率 57.1%（4/7 天，阈值 7.8）',
    trend: '空腹血糖 7.1 → 8.3 mmol/L，极差 1.4',
    keyRule: 'R-BG-3 控制不佳趋势 + R-BG-2 血糖波动提醒',
    notHit: 'R-BG-1 单次超标需单日 >7.8 且前一日达标',
  },
  patient_3: {
    compliance: '7 天体重净变化 −1.2 kg',
    trend: 'D5 90.6 → D6 91.2（+0.6 kg，短期反弹）',
    keyRule: 'R-WT-2 减重进展 + R-WT-3 短期反弹提醒',
    notHit: 'R-WT-5「健步如飞」未解锁（7 天平均步数约 4600 < 8000）',
  },
}
