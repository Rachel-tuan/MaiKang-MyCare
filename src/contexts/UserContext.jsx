import React, { createContext, useContext, useState, useEffect } from 'react'
import { hasHypertension as hasHBPKeyword, hasDiabetes as hasDMKeyword } from '../utils/disease'
import * as patientApi from '../services/patientApi'

const UserContext = createContext()

export const useUser = () => {
  const context = useContext(UserContext)
  if (!context) {
    throw new Error('useUser must be used within a UserProvider')
  }
  return context
}

export const UserProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [elderlyMode, setElderlyMode] = useState(true)
  const [voiceEnabled, setVoiceEnabled] = useState(true)

  /* 会话恢复：localStorage 仅保存「登录身份」，不保存任何健康数据 */
  useEffect(() => {
    const initializeUser = () => {
      try {
        const userData = localStorage.getItem('user')
        const userSettings = localStorage.getItem('userSettings')

        if (userData) {
          const parsedUser = JSON.parse(userData)
          setUser(parsedUser)
          if (parsedUser.elderly_mode !== undefined) setElderlyMode(parsedUser.elderly_mode)
          if (parsedUser.voice_enabled !== undefined) setVoiceEnabled(parsedUser.voice_enabled)
        }
        if (userSettings) {
          const settings = JSON.parse(userSettings)
          setElderlyMode(settings.elderlyMode ?? true)
          setVoiceEnabled(settings.voiceEnabled ?? true)
        }
      } catch (error) {
        console.error('初始化用户数据失败:', error)
        localStorage.removeItem('user')
        localStorage.removeItem('userSettings')
      } finally {
        setLoading(false)
      }
    }

    initializeUser()
  }, [])

  /* 应用老年模式样式 */
  useEffect(() => {
    const body = document.body
    if (elderlyMode) body.classList.add('elderly-mode')
    else body.classList.remove('elderly-mode')
  }, [elderlyMode])

  /* 持久化登录身份 + 偏好（不含健康数据） */
  const persistSession = (profile) => {
    setElderlyMode(profile.elderly_mode ?? true)
    setVoiceEnabled(profile.voice_enabled ?? true)
    localStorage.setItem('user', JSON.stringify(profile))
    localStorage.setItem(
      'userSettings',
      JSON.stringify({ elderlyMode: profile.elderly_mode ?? true, voiceEnabled: profile.voice_enabled ?? true })
    )
  }

  /**
   * 登录（统一走后端 patients 表，凭据不落 localStorage）。
   *   · patientId 路径 → 免密示范病例一键进入；
   *   · username 路径 → 示范病例免密；**自助注册账号必须携带正确密码**（后端 scrypt 校验）。
   * 用户名在 patients 中不存在 → 明确提示「尚未注册」，绝不回落任何默认患者。
   */
  const login = async (credentials = {}) => {
    const patientId = credentials.patientId || credentials.user_id || credentials.id || null
    const username = String(credentials.username || '').trim()
    const password = credentials.password || ''

    if (!patientId && !username) {
      return { success: false, error: '请选择示范病例或输入用户名' }
    }

    try {
      const { patientId: resolvedId, view } = await patientApi.loginPatient({ patientId, username, password })
      setUser(view)
      persistSession(view)
      return { success: true, user: view, patientId: resolvedId, source: patientId ? 'demo' : 'account' }
    } catch (error) {
      if (error.code === 'E_PATIENT_NOT_FOUND') {
        return {
          success: false,
          error: username ? '该账号尚未注册，请先完成注册后再登录' : '未找到该示范病例，请刷新后重试',
          code: error.code,
        }
      }
      return { success: false, error: error.message, code: error.code }
    }
  }

  /**
   * 注册：在服务端 patients 中建立该账号的**真实档案**（新增一位患者，patient_id 即其身份键）。
   * 约束一：注册成功**不自动登录** —— 必须先注册，再用新账号登录。
   * 约束二：新账号从零开始 —— 没有任何历史指标与预警，
   *         所有趋势、评分与规则命中都必须由用户自己录入数据后才会产生。
   */
  const register = async (data = {}) => {
    const username = String(data.username || '').trim()
    const password = String(data.password || '')
    if (!username || !password) {
      return { success: false, error: '用户名与密码均为必填' }
    }

    try {
      const { patientId, view } = await patientApi.registerPatient({
        username,
        password,
        name: data.name,
        age: data.age,
        gender: data.gender,
        phone: data.phone,
        height: data.height,
        weight: data.weight,
        diseases: data.diseases || [],
        emergencyContact: data.emergencyContact,
      })
      return { success: true, registered: true, username, patientId, user: view }
    } catch (error) {
      return { success: false, error: error.message, code: error.code }
    }
  }

  /** 找回密码：用户名 + 注册手机号双因子匹配后由后端重置 */
  const resetPassword = async (payload = {}) => {
    try {
      const r = await patientApi.resetPassword({
        username: payload.username,
        phone: payload.phone,
        newPassword: payload.newPassword,
      })
      return { ok: true, username: r.username }
    } catch (error) {
      return { ok: false, message: error.message, code: error.code }
    }
  }

  const logout = () => {
    setUser(null)
    localStorage.removeItem('user')
    localStorage.removeItem('userSettings')
  }

  const updateUser = (updates) => {
    if (!user) return
    const updatedUser = { ...user, ...updates }
    setUser(updatedUser)
    localStorage.setItem('user', JSON.stringify(updatedUser))
    return updatedUser
  }

  const updateSettings = (settings) => {
    const newSettings = {
      elderlyMode: settings.elderlyMode ?? elderlyMode,
      voiceEnabled: settings.voiceEnabled ?? voiceEnabled,
    }
    setElderlyMode(newSettings.elderlyMode)
    setVoiceEnabled(newSettings.voiceEnabled)
    localStorage.setItem('userSettings', JSON.stringify(newSettings))
    if (user) {
      updateUser({
        elderly_mode: newSettings.elderlyMode,
        voice_enabled: newSettings.voiceEnabled,
      })
    }
  }

  /* 用户健康状态（基于档案派生，非健康数据主存储） */
  const getHealthStatus = () => {
    if (!user) return null
    const { bmi, disease_types } = user
    let status = '良好'
    let color = 'success'
    const recommendations = []

    if (bmi >= 30) {
      status = '需要干预'
      color = 'error'
      recommendations.push('建议积极减重')
    } else if (bmi >= 28) {
      status = '需要关注'
      color = 'warning'
      recommendations.push('建议控制体重')
    }
    if (hasHBPKeyword(disease_types)) recommendations.push('注意血压监测')
    if (hasDMKeyword(disease_types)) recommendations.push('注意血糖控制')

    return { status, color, recommendations, bmi, disease_types }
  }

  /**
   * 用户等级 / 积分。
   * P1（point_transactions / user_levels）尚未建成 —— 按 Step 3 冻结结论：
   * 积分与等级暂不作为运行时数据，**不得伪造为 40 / 等级 1**。
   * 因此返回 { unavailable: true }，由页面给出"待启用"说明。
   */
  const getUserLevel = () => ({
    unavailable: true,
    level: null,
    levelName: null,
    totalPoints: null,
    nextLevelPoints: null,
    progress: 0,
    note: '积分与等级将在 P1 数据表（point_transactions / user_levels）建成后启用。',
  })

  const value = {
    user,
    loading,
    elderlyMode,
    voiceEnabled,
    login,
    register,
    resetPassword,
    logout,
    updateUser,
    updateUserInfo: updateUser,
    updateSettings,
    getHealthStatus,
    getUserLevel,
  }

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>
}
