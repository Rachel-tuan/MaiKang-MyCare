import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App.jsx'
import './index.css'

// 老年友好的主题配置
const elderlyTheme = {
  token: {
    // 基础颜色
    colorPrimary: '#6366f1', // 蓝紫色主色调
    colorSuccess: '#10b981',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',
    colorInfo: '#3b82f6',

    // 字体大小 - 老年友好
    fontSize: 18, // 基础字体增大
    fontSizeLG: 20,
    fontSizeXL: 24,
    fontSizeHeading1: 32,
    fontSizeHeading2: 28,
    fontSizeHeading3: 24,

    // 间距
    padding: 16,
    paddingLG: 24,
    paddingXL: 32,

    // 圆角
    borderRadius: 8,
    borderRadiusLG: 12,

    // 阴影
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
    boxShadowSecondary: '0 4px 12px rgba(0, 0, 0, 0.15)',

    // 高对比度
    colorTextBase: '#1f2937',
    colorBgBase: '#ffffff',
    colorBorder: '#d1d5db',

    // 按钮高度增加
    controlHeight: 48,
    controlHeightLG: 56,
    controlHeightSM: 40
  },
  components: {
    Button: {
      fontWeight: 600,
      borderRadius: 12,
      paddingInline: 24
    },
    Card: {
      borderRadius: 16,
      paddingLG: 24
    },
    Input: {
      borderRadius: 8,
      paddingInline: 16
    },
    Typography: {
      titleMarginBottom: 16,
      titleMarginTop: 0
    }
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ConfigProvider
        locale={zhCN}
        theme={elderlyTheme}
      >
        <App />
      </ConfigProvider>
    </BrowserRouter>
  </React.StrictMode>,
)