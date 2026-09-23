import React, { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout, message } from 'antd'
import styled from 'styled-components'

// 导入页面组件
import HomePage from './pages/HomePage'
import PrescriptionPage from './pages/PrescriptionPage'
import DataRecordPage from './pages/DataRecordPage'
import BadgePage from './pages/BadgePage'
import DoctorPage from './pages/DoctorPage'
import ProfilePage from './pages/ProfilePage'
import LoginPage from './pages/LoginPage'
import AgentCenterPage from './pages/AgentCenterPage'
import CareTeamPage from './pages/CareTeamPage'

// 导入布局组件
import AppHeader from './components/Layout/AppHeader'
import AppFooter from './components/Layout/AppFooter'
import BottomNavigation from './components/Layout/BottomNavigation'
import AgentOrb from './components/Agent/AgentOrb'

// 导入上下文
import { UserProvider, useUser } from './contexts/UserContext'
import { HealthDataProvider } from './contexts/HealthDataContext'
import { AgentProvider, useAgent } from './contexts/AgentContext'

const { Content } = Layout

const StyledLayout = styled(Layout)`
  min-height: 100vh;
  background: linear-gradient(160deg, #f7f8ff 0%, #eef2ff 45%, #f5f3ff 100%);
`

const StyledContent = styled(Content)`
  padding: 0;
  margin: 0;
  flex: 1;
  display: flex;
  flex-direction: column;

  @media (max-width: 768px) {
    padding-bottom: 80px; /* 为底部导航留出空间 */
  }
`

const MainContainer = styled.div`
  flex: 1;
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;

  @media (max-width: 768px) {
    padding: 16px;
  }
`

// 受保护的路由组件
const ProtectedRoute = ({ children }) => {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const userData = localStorage.getItem('user')
    if (userData) {
      try {
        setUser(JSON.parse(userData))
      } catch (error) {
        console.error('用户数据解析失败:', error)
        localStorage.removeItem('user')
      }
    }
    setLoading(false)
  }, [])

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)'
      }}>
        <div className="loading-spinner" style={{ width: '40px', height: '40px' }}></div>
      </div>
    )
  }

  return user ? children : <Navigate to="/login" replace />
}

/** 登录后的应用外壳：必须位于各 Provider 内部才能使用 useUser / useAgent */
const AppShell = () => {
  const { user } = useUser()
  const { speak } = useAgent()

  // 健康数据由 HealthDataProvider 依据当前 patient_id 自动载入（API → dataProvider → SQLite）

  const handlePageChange = (pageName) => {
    if (user?.voice_enabled) {
      speak(`已切换到${pageName}页面`)
    }
  }

  return (
    <>
      <AppHeader onVoiceToggle={(enabled) => speak(enabled ? '语音播报已开启' : '语音播报已关闭')} />
      <StyledContent>
        <MainContainer>
          <Routes>
            <Route path="/" element={<HomePage onPageLoad={() => handlePageChange('首页')} />} />
            <Route path="/agents" element={<AgentCenterPage />} />
            {/* 隐私授权：患者本人决定哪位医生可以查看自己的健康档案 */}
            <Route
              path="/care-team"
              element={<CareTeamPage onPageLoad={() => handlePageChange('我的医疗团队')} />}
            />
            <Route
              path="/prescription"
              element={<PrescriptionPage onPageLoad={() => handlePageChange('健康建议')} />}
            />
            <Route
              path="/data-record"
              element={<DataRecordPage onPageLoad={() => handlePageChange('数据记录')} />}
            />
            <Route
              path="/badges"
              element={<BadgePage onPageLoad={() => handlePageChange('勋章')} />}
            />
            <Route
              path="/doctor"
              element={<DoctorPage onPageLoad={() => handlePageChange('医生端')} />}
            />
            <Route
              path="/profile"
              element={<ProfilePage onPageLoad={() => handlePageChange('我的')} />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </MainContainer>
      </StyledContent>
      <BottomNavigation onNavigate={handlePageChange} />
      <AppFooter />
      <AgentOrb />
    </>
  )
}

function App() {
  // 全局消息配置
  useEffect(() => {
    message.config({
      top: 100,
      duration: 3,
      maxCount: 3,
    })
  }, [])

  return (
    <UserProvider>
      <HealthDataProvider>
        <AgentProvider>
          <StyledLayout>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              />
            </Routes>
          </StyledLayout>
        </AgentProvider>
      </HealthDataProvider>
    </UserProvider>
  )
}

export default App
