/**
 * 智能体悬浮入口
 * 全局常驻，随时唤醒迈康智能体；协同进行中会显示动态指示
 */
import React, { useState } from 'react'
import { Badge, Tooltip } from 'antd'
import styled from 'styled-components'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  ExperimentOutlined,
  PlayCircleFilled,
  PictureOutlined,
  MessageOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import { useAgent } from '../../contexts/AgentContext'

const Wrap = styled.div`
  position: fixed;
  right: 24px;
  bottom: 28px;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;

  @media (max-width: 768px) {
    right: 16px;
    bottom: 96px;
  }
`

const Orb = styled.button`
  width: 60px;
  height: 60px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  color: #fff;
  font-size: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  box-shadow: 0 8px 28px rgba(99, 102, 241, 0.45);
  transition: transform 0.25s ease;

  &:hover { transform: scale(1.08); }

  ${(p) =>
    p.$running &&
    `
    animation: orbPulse 1.6s ease-in-out infinite;
    background: linear-gradient(135deg, #8b5cf6, #ec4899);
  `}

  @keyframes orbPulse {
    0%, 100% { box-shadow: 0 8px 28px rgba(139, 92, 246, 0.5); }
    50% { box-shadow: 0 8px 36px rgba(236, 72, 153, 0.75); }
  }
`

const Menu = styled.div`
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.16);
  padding: 12px;
  min-width: 220px;
  animation: menuIn 0.22s ease;

  @keyframes menuIn {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
`

const MenuTitle = styled.div`
  font-size: 12.5px;
  color: #9ca3af;
  padding: 2px 8px 8px;
  border-bottom: 1px solid #f5f5f5;
  margin-bottom: 6px;
`

const MenuItem = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  border: none;
  background: transparent;
  border-radius: 10px;
  cursor: pointer;
  font-size: 14px;
  color: #374151;
  text-align: left;
  transition: background 0.2s ease;

  &:hover { background: #f5f3ff; color: #6d28d9; }
`

const AgentOrb = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { run, startRun, setOrbOpen, orbOpen, agents, briefing } = useAgent()
  const [open, setOpen] = useState(false)

  const running = run.status === 'running'
  const onAgentPage = location.pathname.startsWith('/agents')

  const go = (path, tab) => {
    setOpen(false)
    setOrbOpen(false)
    navigate(path, tab ? { state: { tab } } : undefined)
  }

  return (
    <Wrap>
      {open && (
        <Menu>
          <MenuTitle>
            {running ? '智能体正在协同推理…' : `${agents.length} 个智能体待命中`}
          </MenuTitle>

          <MenuItem
            onClick={() => {
              setOpen(false)
              if (onAgentPage) {
                startRun('生成今日健康简报与干预方案')
              } else {
                go('/agents')
                setTimeout(() => startRun('生成今日健康简报与干预方案'), 300)
              }
            }}
          >
            <PlayCircleFilled style={{ color: '#6366f1' }} />
            {running ? '重新启动协同' : '启动今日协同'}
          </MenuItem>

          <MenuItem onClick={() => go('/agents', 'chat')}>
            <MessageOutlined style={{ color: '#8b5cf6' }} /> 和智能体聊聊
          </MenuItem>

          <MenuItem onClick={() => go('/agents', 'vision')}>
            <PictureOutlined style={{ color: '#a855f7' }} /> 拍张报告问一问
          </MenuItem>

          <MenuItem onClick={() => go('/agents')}>
            <ExperimentOutlined style={{ color: '#0ea5e9' }} /> 打开智能体中心
          </MenuItem>

          {briefing && (
            <div style={{ marginTop: 8, padding: '10px 12px', background: '#f5f3ff', borderRadius: 10, fontSize: 12.5, color: '#6d28d9', lineHeight: 1.6 }}>
              健康评分 {briefing.score} · 风险{briefing.risk?.label} · {briefing.headline}
            </div>
          )}
        </Menu>
      )}

      <Tooltip title={open ? '' : '迈康智能体'} placement="left">
        <Badge count={run.alerts?.length || 0} offset={[-4, 4]}>
          <Orb
            $running={running}
            onClick={() => setOpen((v) => !v)}
            aria-label="迈康智能体"
          >
            {open ? <CloseOutlined /> : <ExperimentOutlined />}
          </Orb>
        </Badge>
      </Tooltip>
    </Wrap>
  )
}

export default AgentOrb
