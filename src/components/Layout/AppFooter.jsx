import React from 'react'
import { Layout, Typography } from 'antd'
import styled from 'styled-components'

const { Footer } = Layout
const { Text } = Typography

const StyledFooter = styled(Footer)`
  text-align: center;
  background: #f8fafc;
  border-top: 1px solid #e2e8f0;
  padding: 24px 50px;
  margin-bottom: 60px; // 为移动端底部导航留出空间
  
  @media (min-width: 769px) {
    margin-bottom: 0;
  }
`

const FooterContent = styled.div`
  max-width: 1200px;
  margin: 0 auto;
  
  .footer-text {
    color: #64748b;
    font-size: 14px;
    margin-bottom: 8px;
  }
  
  .footer-links {
    display: flex;
    justify-content: center;
    gap: 24px;
    margin-top: 16px;
    
    @media (max-width: 768px) {
      flex-direction: column;
      gap: 8px;
    }
  }
  
  .footer-link {
    color: #6366f1;
    text-decoration: none;
    font-size: 14px;
    
    &:hover {
      text-decoration: underline;
    }
  }
`

const AppFooter = () => {
  return (
    <StyledFooter>
      <FooterContent>
        <Text className="footer-text">
          迈康 MyCare —— 老年慢病多智能体协同健康管理平台
        </Text>
        <Text className="footer-text">
          基于医学指南参考与确定性规则的健康管理平台
        </Text>
        <div className="footer-links">
          <a href="#" className="footer-link">隐私政策</a>
          <a href="#" className="footer-link">服务条款</a>
          <a href="#" className="footer-link">联系我们</a>
          <a href="#" className="footer-link">帮助中心</a>
        </div>
        <Text className="footer-text" style={{ marginTop: '16px' }}>
          © 2026 迈康 MyCare 团队. 保留所有权利.
        </Text>
      </FooterContent>
    </StyledFooter>
  )
}

export default AppFooter