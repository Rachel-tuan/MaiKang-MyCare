import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import styled from 'styled-components'
import {
  HomeOutlined,
  FileTextOutlined,
  BarChartOutlined,
  TrophyOutlined,
  UserOutlined,
  ExperimentOutlined
} from '@ant-design/icons'

const NavigationContainer = styled.div`
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: white;
  border-top: 1px solid #f0f0f0;
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
  z-index: 1000;
  display: none;
  
  @media (max-width: 768px) {
    display: flex;
  }
`

const NavItem = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12px 8px;
  cursor: pointer;
  transition: all 0.3s ease;
  color: ${props => props.$active ? '#6366f1' : '#6b7280'};
  background: ${props => props.$active ? 'rgba(99, 102, 241, 0.1)' : 'transparent'};
  
  &:hover {
    background: rgba(99, 102, 241, 0.05);
  }
  
  .nav-icon {
    font-size: 20px;
    margin-bottom: 4px;
  }
  
  .nav-label {
    font-size: 12px;
    font-weight: ${props => props.$active ? '600' : '400'};
  }
`

const BottomNavigation = ({ onNavigate }) => {
  const navigate = useNavigate()
  const location = useLocation()

  const navItems = [
    {
      key: 'home',
      path: '/',
      icon: <HomeOutlined />,
      label: '首页'
    },
    {
      key: 'agents',
      path: '/agents',
      icon: <ExperimentOutlined />,
      label: '智能体'
    },
    {
      key: 'data',
      path: '/data-record',
      icon: <BarChartOutlined />,
      label: '数据'
    },
    {
      key: 'prescription',
      path: '/prescription',
      icon: <FileTextOutlined />,
      label: '建议'
    },
    {
      key: 'badges',
      path: '/badges',
      icon: <TrophyOutlined />,
      label: '勋章'
    },
    {
      key: 'profile',
      path: '/profile',
      icon: <UserOutlined />,
      label: '我的'
    }
  ]

  const handleNavClick = (item) => {
    navigate(item.path)
    if (onNavigate) {
      onNavigate(item.label)
    }
  }

  return (
    <NavigationContainer>
      {navItems.map(item => (
        <NavItem
          key={item.key}
          $active={location.pathname === item.path}
          onClick={() => handleNavClick(item)}
        >
          <div className="nav-icon">{item.icon}</div>
          <div className="nav-label">{item.label}</div>
        </NavItem>
      ))}
    </NavigationContainer>
  )
}

export default BottomNavigation