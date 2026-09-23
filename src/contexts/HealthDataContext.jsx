import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { PrescriptionRules } from '../models'
import { computeDailyHealthScore, gradeOf, extraDimensionsFromAddedTasks } from '../utils/healthScore'
import { useUser } from './UserContext'
import * as patientApi from '../services/patientApi'

const HealthDataContext = createContext()

export const useHealthData = () => {
  const context = useContext(HealthDataContext)
  if (!context) {
    throw new Error('useHealthData must be used within a HealthDataProvider')
  }
  return context
}

/* ============================================================================
 * 东八区「今天」YYYY-MM-DD
 * ---------------------------------------------------------------------------
 * 与后端 `server/data/dataProvider.js` 的 `todayCST()` **同一算法**
 * （Intl + Asia/Shanghai），保证「界面认定的今天」与「服务端认定的今天」
 * 在任何机器时区下都不会串日 —— 否则今日评分与今日任务又会各说各话。
 * ========================================================================== */
const cstToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())

/* ============================================================================
 * 兼容层：统一记录 / 勋章的字段视图
 * ---------------------------------------------------------------------------
 * 后端返回的记录已同时携带「数据库命名」与「视图模型命名」两套字段；
 * 此处仅做兜底归一，确保任何页面按任一命名访问都能拿到正确值。
 * 数据**不再写入 localStorage**。
 * ========================================================================== */

const num = (v, d = 0) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : d
}

export function normalizeRecord(r = {}) {
  const systolic = num(r.systolic_pressure ?? r.bloodPressure?.systolic, 0)
  const diastolic = num(r.diastolic_pressure ?? r.bloodPressure?.diastolic, 0)
  const bloodSugar = r.blood_sugar ?? r.bloodSugar ?? 0
  const heartRate = num(r.heart_rate ?? r.heartRate, 0)
  const exerciseMinutes = num(r.exercise_minutes ?? r.exerciseMinutes, 0)
  const sleepHours = num(r.sleep_hours ?? r.sleepHours, 7)
  const moodScore = num(r.mood_score ?? r.moodScore, 4)
  const date = r.record_date || r.date || ''

  return {
    ...r,
    record_date: date,
    systolic_pressure: systolic,
    diastolic_pressure: diastolic,
    blood_sugar: bloodSugar,
    heart_rate: heartRate,
    exercise_minutes: exerciseMinutes,
    sleep_hours: sleepHours,
    mood_score: moodScore,
    date,
    bloodPressure: { systolic, diastolic },
    bloodSugar: num(bloodSugar, 0),
    heartRate,
    exerciseMinutes,
    sleepHours,
    moodScore,
  }
}

/** 勋章类型（中文标签）→ 勋章页目录 id */
const BADGE_ID_BY_TYPE = {
  初次记录: 'first_record',
  坚持一周: 'week_streak',
  连续记录: 'week_streak',
  坚持一月: 'month_streak',
  步数达标: 'steps_10k',
  运动达标: 'exercise_week',
  减重成功: 'weight_loss',
  血压达标: 'bp_normal',
  血糖达标: 'sugar_control',
}

const BADGE_ICON_BY_TYPE = {
  步数达标: '🚶',
  连续记录: '📊',
  运动达标: '⚡',
  减重成功: '🎯',
  血压达标: '❤️',
  血糖达标: '🧪',
  初次记录: '⭐',
  坚持一月: '🏅',
}

export function normalizeBadge(b = {}) {
  const typeLabel = b.badge_type || b.badgeType || ''
  const key = b.badgeKey || b.badge_key || b.id || b.badgeId
  const id = key || BADGE_ID_BY_TYPE[typeLabel] || typeLabel
  const earnedDate = b.earned_date || b.earnedDate || new Date().toISOString()
  const name = b.badge_name || b.name || typeLabel
  const icon = b.badge_icon || b.icon || BADGE_ICON_BY_TYPE[typeLabel] || '🏅'

  return {
    ...b,
    id,
    badgeId: id,
    badgeKey: key || id,
    badgeType: typeLabel || id,
    badge_type: typeLabel || id,
    name,
    badge_name: name,
    icon,
    badge_icon: icon,
    earnedDate,
    earned_date: earnedDate,
    level: b.level ?? 1,
    points: b.points ?? 0,
  }
}

/** 单指标序列 → 页面趋势对象（不参与阈值判定，仅方向/幅度） */
const trendOf = (series) => {
  if (!series || !series.stats) return { trend: 'stable', change: 0 }
  const dir = series.stats.direction
  return {
    trend: dir === 'rising' ? 'increasing' : dir === 'falling' ? 'decreasing' : 'stable',
    change: series.stats.pctChange ?? 0,
  }
}

export const HealthDataProvider = ({ children }) => {
  const { user } = useUser()
  const patientId = user?.user_id || null

  const [healthRecords, setHealthRecords] = useState([])
  const [prescriptions, setPrescriptions] = useState([])
  const [badges, setBadges] = useState([])
  const [alerts, setAlerts] = useState([])
  const [trends, setTrends] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // 自定义注册用户（不在示范库）→ API 返回 E_PATIENT_NOT_FOUND，展示空态而非回落示范数据
  const [noDatabaseProfile, setNoDatabaseProfile] = useState(false)
  // Step 9：今日任务（确定性规则生成的**派生视图**，进度由当天有效 readings 实时计算，不落库）
  const [dailyTasks, setDailyTasks] = useState(null)
  const [dailyTasksLoading, setDailyTasksLoading] = useState(false)

  /** 从后端 API 载入当前患者的记录 / 勋章 / 趋势（全部来自 SQLite） */
  const load = useCallback(async (pid) => {
    if (!pid) {
      setHealthRecords([])
      setBadges([])
      setAlerts([])
      setTrends({})
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [recRes, badgeRes, alertRes, sbp, fpg, wt, st] = await Promise.all([
        patientApi.getRecords(pid, 30),
        patientApi.getBadges(pid).catch(() => []),
        patientApi.getAlerts(pid, { limit: 20 }).catch(() => []),
        patientApi.getSeries(pid, 'systolic_pressure', { days: 7 }).catch(() => null),
        patientApi.getSeries(pid, 'fasting_glucose', { days: 7 }).catch(() => null),
        patientApi.getSeries(pid, 'weight', { days: 7 }).catch(() => null),
        patientApi.getSeries(pid, 'steps', { days: 7 }).catch(() => null),
      ])
      setHealthRecords((recRes.records || []).map(normalizeRecord))
      setBadges((badgeRes || []).map(normalizeBadge))
      setAlerts(alertRes || [])
      const systolic = trendOf(sbp)
      const sugar = trendOf(fpg)
      const weight = trendOf(wt)
      const steps = trendOf(st)
      setTrends({
        steps,
        weight,
        systolic_pressure: systolic,
        blood_sugar: sugar,
        // 兼容别名：数值变化量（部分页面按数值比较）
        bloodPressure: systolic.change,
        bloodSugar: sugar.change,
      })
      setNoDatabaseProfile(false)
    } catch (e) {
      // 明确空态：自定义用户不在库中；绝不回落到默认示范患者
      setHealthRecords([])
      setBadges([])
      setAlerts([])
      setTrends({})
      setError(e)
      setNoDatabaseProfile(e.code === 'E_PATIENT_NOT_FOUND')
      if (e.code !== 'E_PATIENT_NOT_FOUND') console.warn('加载健康数据失败：', e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(patientId)
  }, [patientId, load])

  const refresh = useCallback(() => load(patientId), [load, patientId])

  /**
   * 载入「今日任务」（Step 9）。
   * 任务频次与时段由 src/utils/dailyTasks.js 的确定性规则决定（后端计算），
   * 进度由当天有效 readings 实时派生 —— 前端只读取展示，**不参与任务次数与阈值判定**。
   */
  const loadDailyTasks = useCallback(async (pid) => {
    if (!pid) {
      setDailyTasks(null)
      return null
    }
    setDailyTasksLoading(true)
    try {
      const data = await patientApi.getDailyTasks(pid)
      setDailyTasks(data)
      return data
    } catch (e) {
      // 无档案 / 后端不可用 → 今日任务留空，绝不回落示范数据
      setDailyTasks(null)
      if (e.code !== 'E_PATIENT_NOT_FOUND') console.warn('加载今日任务失败：', e.message)
      return null
    } finally {
      setDailyTasksLoading(false)
    }
  }, [])

  // 身份切换即重算今日任务（与记录同步，避免残留上一位患者的任务）
  useEffect(() => {
    loadDailyTasks(patientId)
  }, [patientId, loadDailyTasks])

  const refreshDailyTasks = useCallback(() => loadDailyTasks(patientId), [loadDailyTasks, patientId])

  /**
   * 只刷新落库预警（alerts 表）。
   * Agent 协同运行结束后由后端落库，前端据此重新读取——避免整页重载。
   */
  const refreshAlerts = useCallback(async () => {
    if (!patientId) {
      setAlerts([])
      return []
    }
    try {
      const list = await patientApi.getAlerts(patientId, { limit: 20 })
      setAlerts(list || [])
      return list || []
    } catch (e) {
      if (e.code !== 'E_PATIENT_NOT_FOUND') console.warn('刷新预警失败：', e.message)
      return []
    }
  }, [patientId])

  /** 兼容旧外壳：切换身份后重新载入 */
  const syncForUser = useCallback(
    (userId) => {
      if (userId && userId !== patientId) load(userId)
    },
    [load, patientId]
  )

  /** 录入健康数据 → 写入后端 SQLite → 重新拉取 */
  const addHealthRecord = useCallback(
    async (record) => {
      if (!patientId) throw new Error('未登录，无法记录数据')
      const res = await patientApi.addRecord(patientId, record)
      await load(patientId)
      await loadDailyTasks(patientId)
      return res.record
    },
    [patientId, load, loadDailyTasks]
  )

  /**
   * 追加一次测量（Step 9）—— **新增一条 readings**，同一天多次互不覆盖。
   * 血压：kind='blood_pressure'，payload 含 systolic / diastolic / slot（UI「午后」→ 落库「下午」）；
   * 血糖：kind='blood_glucose'，payload 含 value / measureType（必填）。
   * 写库后重新拉取记录与今日任务（daily 兼容层与任务进度都会随之变化）。
   */
  const appendReading = useCallback(
    async (kind, payload = {}) => {
      if (!patientId) throw new Error('未登录，无法记录数据')
      const res =
        kind === 'blood_glucose'
          ? await patientApi.addBloodGlucoseReading(patientId, payload)
          : await patientApi.addBloodPressureReading(patientId, payload)
      await load(patientId)
      await loadDailyTasks(patientId)
      return res
    },
    [patientId, load, loadDailyTasks]
  )

  /** 服药打卡（一个药物多个服药时间 = 多个计划实例，按 (药, 时段) 定位） */
  const logMedication = useCallback(
    async (payload = {}) => {
      if (!patientId) throw new Error('未登录，无法记录服药')
      const res = await patientApi.addMedicationLog(patientId, payload)
      await loadDailyTasks(patientId)
      return res
    },
    [patientId, loadDailyTasks]
  )

  /** 生成健康建议（依据档案的派生视图；不落库，不入 localStorage） */
  const generatePrescription = useCallback(
    (profile = {}) => {
      const source = profile && Object.keys(profile).length ? profile : user || {}
      const exercisePlan = PrescriptionRules.generateExercisePlan(source)
      const dietPlan = PrescriptionRules.generateDietPlan(source)
      const medicationReminders = PrescriptionRules.generateMedicationReminders(source)

      const prescription = {
        prescription_id: `prescription_${Date.now()}`,
        user_id: source.user_id,
        exercise: [
          {
            type: exercisePlan.type,
            duration: `${exercisePlan.duration} 分钟`,
            frequency: exercisePlan.frequency,
            intensity: exercisePlan.intensity,
          },
        ],
        diet: [
          ...dietPlan.restrictions.map((r) => ({ category: '限制', recommendation: r, amount: '' })),
          ...dietPlan.recommendations.map((r) => ({ category: '建议', recommendation: r, amount: '' })),
        ],
        medication: medicationReminders.map((m) => ({
          name: m.name,
          dosage: m.dosage,
          frequency: m.frequency,
          timing: m.notes,
        })),
        target_goals: {
          steps: Number(source.bmi) >= 28 ? 10000 : 8000,
          weight_loss: Number(source.bmi) >= 28 ? 2 : 0,
          bp_target: '140/90',
          blood_sugar_target: '7.0',
        },
        generated_date: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        is_active: true,
        doctor_modified: false,
      }

      setPrescriptions((prev) => [...prev.map((p) => ({ ...p, is_active: false })), prescription])
      return prescription
    },
    [user]
  )

  /** 勋章由后端按 badge_definitions 判定；前端不再本地发勋章（避免与库不一致） */
  const checkForNewBadges = useCallback(() => {
    return []
  }, [])

  /* -------------------- 页面读取辅助（全部基于 API 记录） -------------------- */

  /**
   * 指定日期记录；不传日期时取**真实今天（东八区）**。
   * ---------------------------------------------------------------------------
   * ⚠️ **不得**回落到「最近一次记录日」（旧实现如此）。回落的两个后果都成立：
   *   ① 界面写着「今日健康评分」，算的却是历史某天 —— 标题与数据不是同一天，
   *      与今日任务（后端按 `todayCST()` 派生）同屏自相矛盾；
   *   ② 今日未录入的维度会被历史值顶上，白送满分 —— 即红线 10
   *      「缺测不得当达标」的同类缺陷（Step 10 已修 `healthScore.js` 的分母，
   *      这条是同一类问题的残根）。
   * 今日无记录时返回 `undefined`，由调用方决定如何呈现：
   *   · 评分侧按「全项缺测」计 0 分并逐项标 `status: 'missing'`；
   *   · 语音播报侧已有「今天还没有记录健康数据」分支。
   */
  const getTodayData = (date) => {
    const target = date ? String(date) : cstToday()
    return healthRecords.find((record) => record.record_date === target)
  }

  const getRecentData = (days = 7) => {
    const sorted = [...healthRecords].sort((a, b) => new Date(b.record_date) - new Date(a.record_date))
    return sorted.slice(0, days)
  }

  const getHealthTrends = () => trends

  /**
   * ⚠️ F-3（Step 11 实测）：`prescriptions` 表同表承载三种语义的 JSON ——
   *   · 健康处方（无 kind / kind 缺省）
   *   · 今日任务生效覆盖包（kind='task_override_package'）
   *   · 待审任务提案（kind='task_proposal'）
   * 后两者属于**任务覆盖链路**，绝不能被渲染成健康处方，故此处按 kind 过滤。
   */
  const isHealthPrescription = (p) =>
    !p?.kind || (p.kind !== 'task_override_package' && p.kind !== 'task_proposal')

  const getActivePrescription = () =>
    prescriptions.find((p) => p.is_active && isHealthPrescription(p))

  const getActivePrescriptions = () =>
    prescriptions.filter((p) => p.is_active && isHealthPrescription(p))

  /** 连续记录天数（基于数据库记录现算） */
  const getConsecutiveDays = () => {
    const sorted = [...healthRecords].sort((a, b) => new Date(b.record_date) - new Date(a.record_date))
    if (!sorted.length) return 0
    let streak = 1
    for (let i = 1; i < sorted.length; i += 1) {
      const diff = Math.round((new Date(sorted[i - 1].record_date) - new Date(sorted[i].record_date)) / 86400000)
      if (diff === 1) streak += 1
      else break
    }
    return streak
  }

  /**
   * 健康评分（确定性本地计算，数据来自数据库记录）
   * ---------------------------------------------------------------------------
   * 权重与口径的**唯一实现在 src/utils/healthScore.js**，与服务端智能体工具
   * compute_health_score 共用同一份代码 —— 保证「界面上的分数」与「智能体口播的分数」
   * 必然一致。
   *
   * 分母固定为「疾病谱决定的适用维度权重之和」，不再随当日是否有数据漂移。
   * 旧实现是「有数据才把该维度计入分母」，导致缺测不扣分：当天只走了步数、
   * 血压血糖都没测时，分子分母同时缩水，会算出 100 分「优秀」，与同屏的
   * 「风险等级：预警」自相矛盾。
   */
  const getHealthScoreDetail = () =>
    computeDailyHealthScore({
      today: getTodayData() || {},
      diseases: user?.disease_types || user?.diseases || [],
      // Step 12：医生审结新增的监测域 → 额外适用维度。
      // 来源是 daily-tasks 接口回传的**生效覆盖包**（addedTasks），
      // 与后端 aiScoreService / 智能体工具用同一个推导函数，前后端不会分叉。
      extraDimensions: extraDimensionsFromAddedTasks(dailyTasks?.overridePackage?.addedTasks),
    })

  /** 界面主口径：0–100 整数分（保持原有函数签名不变） */
  const getHealthScore = () => getHealthScoreDetail().score

  /** 分数档位文案，与评分同源，避免各处自行写阈值 */
  const getHealthScoreGrade = () => gradeOf(getHealthScore())

  const value = {
    healthRecords,
    prescriptions,
    badges,
    alerts,
    userBadges: badges,
    trends,
    loading,
    error,
    noDatabaseProfile,
    // Step 9：今日任务（确定性规则派生）+ 多次测量追加
    dailyTasks,
    dailyTasksLoading,
    refresh,
    refreshAlerts,
    refreshDailyTasks,
    appendReading,
    logMedication,
    syncForUser,
    addHealthRecord,
    generatePrescription,
    getTodayData,
    getRecentData,
    getDailyHealthData: getTodayData,
    getRecentHealthData: getRecentData,
    getHealthTrends,
    getActivePrescription,
    getActivePrescriptions,
    getHealthScore,
    getHealthScoreDetail,
    getHealthScoreGrade,
    getConsecutiveDays,
    checkForNewBadges,
    checkNewBadges: checkForNewBadges,
    // 兼容占位：本地不做记录更新（更新走后端录入接口）
    updateHealthRecord: () => null,
  }

  return <HealthDataContext.Provider value={value}>{children}</HealthDataContext.Provider>
}
