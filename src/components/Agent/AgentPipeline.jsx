/**
 * 多智能体协同可视化
 * 实时展示每个智能体的运行状态、思考链与工具调用轨迹
 */
import React from 'react'
import { Tag, Tooltip, Empty } from 'antd'
import styled from 'styled-components'
import {
  CheckCircleFilled,
  LoadingOutlined,
  ClockCircleOutlined,
  ApiOutlined,
  ThunderboltFilled,
} from '@ant-design/icons'

const Wrapper = styled.div`
  display: flex;
  align-items: stretch;
  gap: 0;
  overflow-x: auto;
  padding: 8px 4px 16px;

  @media (max-width: 900px) {
    flex-direction: column;
  }
`

const Node = styled.div`
  flex: 1 1 0;
  min-width: 220px;
  display: flex;
  align-items: stretch;

  @media (max-width: 900px) {
    min-width: 0;
    width: 100%;
  }
`

const Card = styled.div`
  flex: 1;
  position: relative;
  border-radius: 16px;
  padding: 16px;
  background: ${(p) => (p.$active ? '#f5f3ff' : '#ffffff')};
  border: 2px solid ${(p) => (p.$active ? p.$color : p.$done ? '#e5e7eb' : '#f0f0f0')};
  box-shadow: ${(p) =>
    p.$active ? `0 8px 24px ${p.$color}33` : '0 2px 8px rgba(0, 0, 0, 0.05)'};
  transition: all 0.35s ease;
  animation: ${(p) => (p.$active ? 'agentPulse 1.8s ease-in-out infinite' : 'none')};

  @keyframes agentPulse {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
  }
`

const CardHead = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
`

const Icon = styled.div`
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  background: ${(p) => `${p.$color}1a`};
  flex-shrink: 0;
`

const Name = styled.div`
  font-size: 15px;
  font-weight: 700;
  color: #1f2937;
  line-height: 1.25;
`

const Role = styled.div`
  font-size: 12px;
  color: #9ca3af;
`

const StatusDot = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: ${(p) => p.$color};
  font-weight: 600;
  margin-left: auto;
`

const ThoughtList = styled.div`
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 132px;
  overflow-y: auto;

  &::-webkit-scrollbar { width: 4px; }
  &::-webkit-scrollbar-thumb { background: #e5e7eb; border-radius: 2px; }
`

const Thought = styled.div`
  font-size: 12.5px;
  line-height: 1.5;
  color: #4b5563;
  padding-left: 10px;
  position: relative;

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 7px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: ${(p) => p.$color};
  }

  animation: fadeUp 0.3s ease;
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
`

const ToolChips = styled.div`
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`

/* 上下文交接提要：显式展示「上游交接了什么给这个智能体」 */
const HandoffBox = styled.div`
  margin-top: 10px;
  border-radius: 10px;
  border: 1px dashed #a7f3d0;
  background: #f0fdfa;
  padding: 8px 10px;

  animation: fadeUp 0.35s ease;

  .hd-head {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    font-weight: 700;
    color: #0f766e;
    margin-bottom: 6px;
  }

  .hd-item {
    font-size: 11.5px;
    line-height: 1.55;
    color: #475569;
    margin-top: 3px;
    word-break: break-all;
  }

  .hd-src {
    display: inline-block;
    font-size: 10.5px;
    font-weight: 700;
    color: #0d9488;
    background: #ccfbf1;
    border-radius: 4px;
    padding: 0 5px;
    margin-right: 4px;
  }
`

const Arrow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  color: ${(p) => (p.$flowing ? '#6366f1' : '#d1d5db')};
  font-size: 18px;
  flex-shrink: 0;
  transition: color 0.3s ease;

  @media (max-width: 900px) {
    width: 100%;
    height: 28px;
    transform: rotate(90deg);
  }
`

const Connector = styled.div`
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: ${(p) => (p.$flowing ? '#a5b4fc' : '#e5e7eb')};
  position: relative;
  overflow: hidden;

  &::after {
    content: '';
    position: absolute;
    inset: 0;
    width: ${(p) => (p.$flowing ? '40%' : '0')};
    background: linear-gradient(90deg, transparent, #6366f1, transparent);
    animation: ${(p) => (p.$flowing ? 'flow 1.2s linear infinite' : 'none')};
  }

  @keyframes flow {
    from { transform: translateX(-100%); }
    to { transform: translateX(300%); }
  }

  @media (max-width: 900px) {
    display: none;
  }
`

const STATUS = {
  idle: { label: '待命', color: '#9ca3af', icon: <ClockCircleOutlined /> },
  running: { label: '推理中', color: '#6366f1', icon: <LoadingOutlined /> },
  done: { label: '已完成', color: '#10b981', icon: <CheckCircleFilled /> },
}

const TOOL_LABEL = {
  get_user_profile: '读档案',
  get_health_records: '读记录',
  analyze_vital_trends: '趋势分析',
  compute_health_score: '健康评分',
  assess_risk: '风险评估',
  draft_intervention_plan: '方案生成',
  raise_alert: '触发预警',
  schedule_reminder: '创建提醒',
  list_badges: '读勋章',
  list_recent_alerts: '查预警',
  search_health_knowledge: '查知识库',
}

const AgentPipeline = ({ pipeline = [], agents = {}, order = [], runStatus = 'idle', handoffs = {} }) => {
  const ids = order.length ? order : pipeline.map((p) => p.id)

  /* 交接提要里的长文本要截断，否则会把卡片撑变形（完整内容在「事件流」里可查） */
  const clip = (v, max = 26) => {
    const s = String(v)
    return s.length > max ? `${s.slice(0, max)}…` : s
  }

  if (!ids.length) {
    return <Empty description="智能体注册表加载中…" image={Empty.PRESENTED_IMAGE_SIMPLE} />
  }

  return (
    <Wrapper>
      {ids.map((id, index) => {
        const live = agents[id]
        const def = pipeline.find((p) => p.id === id)
        const state = live?.status || 'idle'
        const meta = STATUS[state] || STATUS.idle
        const color = live?.color || '#6366f1'
        const isLast = index === ids.length - 1
        const nextAgent = !isLast ? agents[ids[index + 1]] : null

        return (
          <React.Fragment key={id}>
            <Node>
              <Card $active={state === 'running'} $done={state === 'done'} $color={color}>
                <CardHead>
                  <Icon $color={color}>{live?.icon || '🤖'}</Icon>
                  <div style={{ minWidth: 0 }}>
                    <Name>{live?.name || def?.label || id}</Name>
                    <Role>{live?.role || ''}</Role>
                  </div>
                  <StatusDot $color={meta.color}>
                    {meta.icon}
                    <span>{meta.label}</span>
                  </StatusDot>
                </CardHead>

                {live?.thoughts?.length > 0 && (
                  <ThoughtList>
                    {live.thoughts.map((t, i) => (
                      <Thought key={i} $color={color}>
                        {t}
                      </Thought>
                    ))}
                  </ThoughtList>
                )}

                {handoffs[id] && (
                  <HandoffBox>
                    <div className="hd-head">
                      <ThunderboltFilled />
                      接收上游交接
                    </div>
                    {Object.entries(handoffs[id].payload || {}).map(([srcName, digest]) => (
                      <div className="hd-item" key={srcName}>
                        <span className="hd-src">{srcName}</span>
                        {Object.entries(digest)
                          .map(([k, v]) =>
                            Array.isArray(v)
                              ? `${k}：${v.map((x) => clip(x, 20)).join('；')}`
                              : `${k}：${clip(v)}`
                          )
                          .join('　|　')}
                      </div>
                    ))}
                    {(!handoffs[id].payload || !Object.keys(handoffs[id].payload).length) && (
                      <div className="hd-item">{handoffs[id].reason}</div>
                    )}
                  </HandoffBox>
                )}

                {live?.toolCalls?.length > 0 && (
                  <ToolChips>
                    {live.toolCalls.map((t, i) => (
                      <Tooltip key={i} title={t.result ? `${TOOL_LABEL[t.name] || t.name} → ${t.result}` : (TOOL_LABEL[t.name] || t.name)}>
                        <Tag icon={<ApiOutlined />} color="purple" style={{ margin: 0, fontSize: 11 }}>
                          {TOOL_LABEL[t.name] || t.name}
                        </Tag>
                      </Tooltip>
                    ))}
                  </ToolChips>
                )}

                {state === 'done' && live?.durationMs != null && (
                  <div style={{ marginTop: 10, fontSize: 11.5, color: '#9ca3af' }}>
                    <ThunderboltFilled style={{ color: '#f59e0b', marginRight: 4 }} />
                    耗时 {(live.durationMs / 1000).toFixed(2)}s
                    {live.degraded && (
                      <Tag color="orange" style={{ marginLeft: 6, fontSize: 10 }}>
                        本地引擎
                      </Tag>
                    )}
                  </div>
                )}
              </Card>
            </Node>

            {!isLast && (
              <Arrow $flowing={Boolean(nextAgent) || (state === 'running' && runStatus === 'running')}>
                <Connector $flowing={state === 'done' && Boolean(nextAgent)} />
              </Arrow>
            )}
          </React.Fragment>
        )
      })}
    </Wrapper>
  )
}

export default AgentPipeline
