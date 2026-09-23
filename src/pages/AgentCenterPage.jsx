/**
 * 迈康智能体中心
 * 多智能体协同控制台：启动协同、观察推理过程、查看结构化结论、与单个智能体对话、图像解读
 */
import React, { useState } from 'react'
import { Card, Button, Typography, Space, Tag, Input, Tabs, Alert, Badge, Tooltip, Segmented, Empty } from 'antd'
import styled from 'styled-components'
import {
  PlayCircleFilled,
  ReloadOutlined,
  ApiOutlined,
  ThunderboltFilled,
  ExperimentOutlined,
  MessageOutlined,
  PictureOutlined,
  ProfileOutlined,
  SoundOutlined,
  DisconnectOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { useAgent } from '../contexts/AgentContext'
import AgentPipeline from '../components/Agent/AgentPipeline'
import AgentResultPanel from '../components/Agent/AgentResultPanel'
import ChatPanel from '../components/Agent/ChatPanel'
import VisionPanel from '../components/Agent/VisionPanel'

const { Title, Text, Paragraph } = Typography

const Hero = styled(Card)`
  border-radius: 20px;
  border: none;
  background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 55%, #a855f7 100%);
  margin-bottom: 20px;
  overflow: hidden;
  position: relative;

  &::after {
    content: '';
    position: absolute;
    right: -80px;
    top: -80px;
    width: 280px;
    height: 280px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.08);
  }

  .ant-card-body { padding: 28px; position: relative; z-index: 1; }
  h2, h3, h4, .ant-typography { color: #fff !important; }
`

const GoalRow = styled.div`
  display: flex;
  gap: 12px;
  margin-top: 18px;
  flex-wrap: wrap;

  .ant-input-affix-wrapper {
    background: rgba(255, 255, 255, 0.16);
    border: 1px solid rgba(255, 255, 255, 0.3);
    max-width: 460px;
    flex: 1 1 260px;
  }
  .ant-input { background: transparent; color: #fff; }
  .ant-input::placeholder { color: rgba(255, 255, 255, 0.65); }
`

const GlassTag = styled(Tag)`
  background: rgba(255, 255, 255, 0.18) !important;
  border: 1px solid rgba(255, 255, 255, 0.3) !important;
  color: #fff !important;
  font-weight: 500;
`

const StatPill = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 13.5px;
`

const EventLine = styled.div`
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  line-height: 1.8;
  color: #4b5563;
  display: flex;
  gap: 8px;

  .t { color: #9ca3af; flex-shrink: 0; }
  .k { flex-shrink: 0; font-weight: 700; }
`

const EVENT_META = {
  run_start: { label: '协同启动', color: '#6366f1' },
  agent_start: { label: '智能体唤醒', color: '#0ea5e9' },
  agent_thought: { label: '推理', color: '#8b5cf6' },
  tool_call: { label: '工具调用', color: '#f59e0b' },
  handoff: { label: '上下文交接', color: '#14b8a6' },
  agent_result: { label: '产出', color: '#10b981' },
  agent_done: { label: '完成', color: '#9ca3af' },
  run_done: { label: '协同结束', color: '#6366f1' },
  error: { label: '错误', color: '#ef4444' },
}

const AgentCenterPage = () => {
  const { agents, pipeline, status, run, startRun, stopRun, agentContext, speak, refreshBriefing } = useAgent()
  const [goal, setGoal] = useState('生成今日健康简报与干预方案')
  const [tab, setTab] = useState('result')
  const [logMode, setLogMode] = useState('summary')

  const running = run.status === 'running'
  const riskItems = run.agents?.sentinel?.result?.risks || []

  // 把事件流里的交接记录按「接收方」归并，供协同图直接展示「上游交接了什么」
  const handoffs = React.useMemo(() => {
    const map = {}
    for (const e of run.events || []) {
      if (e.type === 'handoff' && e.to) map[e.to] = e
    }
    return map
  }, [run.events])

  const handleStart = () => {
    setTab('result')
    startRun(goal)
  }

  const speakBriefing = () => {
    const steward = run.agents?.steward?.result || run.summary
    if (!steward) return
    const actions = (steward.actions || []).map((a) => a.title).join('；')
    speak(`${steward.headline}。${steward.briefing}${actions ? `今天要做：${actions}` : ''}`)
  }

  return (
    <div>
      {/* ------------------------------ 顶部控制台 ------------------------------ */}
      <Hero>
        <Space size={10} wrap style={{ marginBottom: 12 }}>
          <GlassTag icon={<ExperimentOutlined />}>多智能体协同</GlassTag>
          {status.online ? (
            status.modelConfigured ? (
              <GlassTag icon={<ThunderboltFilled />}>大模型已接入 · {status.model}</GlassTag>
            ) : (
              <GlassTag icon={<ThunderboltFilled />}>本地推理引擎（未配置 Key）</GlassTag>
            )
          ) : (
            <GlassTag icon={<DisconnectOutlined />}>智能体服务未启动</GlassTag>
          )}
          <GlassTag icon={<ApiOutlined />}>{agents.length} 个智能体</GlassTag>
        </Space>

        <Title level={2} style={{ margin: 0 }}>迈康智能体中心</Title>
        <Paragraph style={{ margin: '8px 0 0', opacity: 0.92, fontSize: 15, maxWidth: 720 }}>
          六个智能体分工协作：体征分析 → 风险预警 → 方案规划 → 汇总编排，
          全程自主决策、相互传递上下文，并能调用工具真实生成预警与提醒。
        </Paragraph>

        <GoalRow>
          <Input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="告诉智能体这次要解决什么问题…"
            onPressEnter={() => !running && handleStart()}
            disabled={running}
          />
          {running ? (
            <Button size="large" danger onClick={stopRun}>停止协同</Button>
          ) : (
            <Button
              type="primary"
              size="large"
              icon={<PlayCircleFilled />}
              onClick={handleStart}
              style={{ background: '#fff', color: '#6d28d9', fontWeight: 700, border: 'none' }}
            >
              启动协同
            </Button>
          )}
          <Tooltip title="重新计算健康晨报（本地算法，不消耗模型额度）">
            <Button
              size="large"
              icon={<ReloadOutlined />}
              onClick={refreshBriefing}
              style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}
            >
              刷新晨报
            </Button>
          </Tooltip>
        </GoalRow>

        <Space size={10} wrap style={{ marginTop: 16 }}>
          <StatPill>
            <ClockCircleOutlined /> 记录天数 {agentContext.records.length}
          </StatPill>
          {run.finishedAt && (
            <StatPill>
              <ThunderboltFilled /> 本轮耗时 {((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s
            </StatPill>
          )}
          {run.alerts?.length > 0 && (
            <StatPill style={{ background: 'rgba(239,68,68,0.35)' }}>
              <Badge status="error" /> 自主触发预警 {run.alerts.length} 条
            </StatPill>
          )}
          {run.reminders?.length > 0 && (
            <StatPill style={{ background: 'rgba(16,185,129,0.3)' }}>
              <Badge status="success" /> 生成提醒 {run.reminders.length} 条
            </StatPill>
          )}
          {run.agents?.steward?.result && (
            <Button
              size="small"
              icon={<SoundOutlined />}
              onClick={speakBriefing}
              style={{ background: 'rgba(255,255,255,0.2)', color: '#fff', border: 'none', borderRadius: 999, height: 34 }}
            >
              朗读简报
            </Button>
          )}
        </Space>
      </Hero>

      {!status.online && (
        <Alert
          type="warning"
          showIcon
          style={{ borderRadius: 12, marginBottom: 16 }}
          message="未检测到智能体服务"
          description="请先在项目目录执行 npm run dev（或 npm run server）启动 Express 智能体服务，端口 3001。"
        />
      )}

      {/* ------------------------------ 协同可视化 ------------------------------ */}
      <Card
        title={
          <Space>
            <ExperimentOutlined style={{ color: '#6366f1' }} />
            <span>智能体协同过程</span>
            {running && <Badge status="processing" text="推理中" />}
          </Space>
        }
        extra={
          <Space>
            <Segmented
              size="small"
              value={logMode}
              onChange={setLogMode}
              options={[
                { label: '卡片', value: 'summary' },
                { label: '事件流', value: 'log' },
              ]}
            />
          </Space>
        }
        style={{ borderRadius: 16, marginBottom: 20 }}
      >
        {logMode === 'summary' ? (
          <AgentPipeline pipeline={pipeline} agents={run.agents} order={run.order} runStatus={run.status} handoffs={handoffs} />
        ) : (
          <div style={{ maxHeight: 320, overflowY: 'auto', background: '#fafafa', borderRadius: 12, padding: 14 }}>
            {run.events.length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无事件，点击「启动协同」开始" />
            )}
            {run.events.map((e, i) => {
              const meta = EVENT_META[e.type] || { label: e.type, color: '#9ca3af' }
              const detail =
                e.type === 'agent_start' ? e.name
                : e.type === 'agent_thought' ? e.text
                : e.type === 'tool_call' ? `${e.name} → ${e.result}`
                : e.type === 'handoff' ? e.reason
                : e.type === 'agent_result' ? `结构化产出（${e.durationMs}ms）`
                : e.type === 'run_start' ? `目标：${e.goal}`
                : e.type === 'run_done' ? `预警 ${e.alerts?.length || 0} 条 / 提醒 ${e.reminders?.length || 0} 条`
                : e.message || ''
              return (
                <EventLine key={i}>
                  <span className="t">#{String(i + 1).padStart(2, '0')}</span>
                  <span className="k" style={{ color: meta.color }}>[{meta.label}]</span>
                  <span style={{ wordBreak: 'break-word' }}>{detail}</span>
                </EventLine>
              )
            })}
          </div>
        )}
      </Card>

      {/* ------------------------------ 三大功能区 ------------------------------ */}
      <Card style={{ borderRadius: 16 }} styles={{ body: { paddingTop: 8 } }}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'result',
              label: (
                <span>
                  <ProfileOutlined /> 协同结果
                  {riskItems.length > 0 && <Badge count={riskItems.length} style={{ marginLeft: 6, backgroundColor: '#ef4444' }} />}
                </span>
              ),
              children: <AgentResultPanel run={run} agents={agents} />,
            },
            {
              key: 'chat',
              label: (
                <span>
                  <MessageOutlined /> 智能体对话
                </span>
              ),
              children: <ChatPanel />,
            },
            {
              key: 'vision',
              label: (
                <span>
                  <PictureOutlined /> 图像解读
                </span>
              ),
              children: <VisionPanel />,
            },
          ]}
        />
      </Card>
    </div>
  )
}

export default AgentCenterPage
