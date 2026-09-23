/**
 * 智能体协同结果展示
 * 把四个智能体的结构化产出渲染为可读的界面
 */
import React from 'react'
import { Tabs, Card, Tag, Row, Col, Progress, Empty, Space, Typography, List, Alert, Statistic, Divider } from 'antd'
import styled from 'styled-components'
import {
  RiseOutlined,
  FallOutlined,
  MinusOutlined,
  ThunderboltFilled,
  BellFilled,
  CheckCircleFilled,
  ClockCircleOutlined,
  HeartFilled,
  CoffeeOutlined,
  MedicineBoxOutlined,
  AimOutlined,
} from '@ant-design/icons'

const { Title, Text, Paragraph } = Typography

const LEVEL_COLOR = {
  // 产品预警等级词表（提示 / 关注 / 预警 / 紧急）—— 非医学危险分层
  紧急: '#ef4444',
  预警: '#f97316',
  关注: '#f59e0b',
  提示: '#10b981',
  critical: '#ef4444',
  high: '#f97316',
  medium: '#f59e0b',
  low: '#10b981',
}

const HeadlineCard = styled(Card)`
  border-radius: 16px;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  border: none;

  .ant-card-body { padding: 24px; }
  h3, .ant-typography { color: #fff !important; }
`

const ActionItem = styled.div`
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: #fff;
  border: 1px solid #f0f0f0;
  margin-bottom: 10px;
  border-left: 4px solid ${(p) => p.$color};
`

const RiskItem = styled.div`
  padding: 14px;
  border-radius: 12px;
  background: ${(p) => `${p.$color}0d`};
  border: 1px solid ${(p) => `${p.$color}33`};
  margin-bottom: 10px;
`

const IndicatorRow = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid #f5f5f5;

  &:last-child { border-bottom: none; }
`

const PlanBlock = styled.div`
  padding: 14px 16px;
  border-radius: 12px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  height: 100%;
`

const TrendIcon = ({ direction, improving }) => {
  const color = improving === true ? '#10b981' : improving === false ? '#ef4444' : '#9ca3af'
  if (direction === 'rising') return <RiseOutlined style={{ color }} />
  if (direction === 'falling') return <FallOutlined style={{ color }} />
  return <MinusOutlined style={{ color }} />
}

const PRIORITY = {
  high: { color: '#ef4444', label: '优先' },
  medium: { color: '#f59e0b', label: '建议' },
  low: { color: '#10b981', label: '日常' },
}

const AgentResultPanel = ({ run, agents = [] }) => {
  const vitals = run.agents?.vitals?.result
  const sentinel = run.agents?.sentinel?.result
  const planner = run.agents?.planner?.result
  const steward = run.agents?.steward?.result || run.summary

  const vacant = (text) => (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} style={{ padding: '40px 0' }} />
  )

  /* ------------------------------ 今日简报 ------------------------------ */
  const briefTab = steward ? (
    <div>
      <HeadlineCard style={{ marginBottom: 16 }}>
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Tag color="rgba(255,255,255,0.25)" style={{ color: '#fff', border: 'none' }}>
            {run.engine === 'deepseek' ? 'DeepSeek 驱动' : '本地推理引擎'}
            {run.alerts?.length ? ` · ${run.alerts.length} 条预警` : ''}
          </Tag>
          <Title level={4} style={{ margin: 0 }}>{steward.headline}</Title>
          <Paragraph style={{ margin: 0, opacity: 0.92, fontSize: 15 }}>{steward.briefing}</Paragraph>
        </Space>
      </HeadlineCard>

      {steward.actions?.length > 0 && (
        <>
          <Text strong style={{ fontSize: 16 }}>今天要做的几件事</Text>
          <div style={{ marginTop: 12 }}>
            {steward.actions.map((a, i) => {
              const p = PRIORITY[a.priority] || PRIORITY.low
              return (
                <ActionItem key={i} $color={p.color}>
                  <CheckCircleFilled style={{ color: p.color, fontSize: 20, marginTop: 2 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>
                      {a.title}
                      <Tag color={p.color} style={{ marginLeft: 8, fontSize: 11 }}>{p.label}</Tag>
                    </div>
                    <div style={{ fontSize: 13, color: '#6b7280', marginTop: 3 }}>
                      {a.time ? `${a.time} · ` : ''}{a.detail}
                    </div>
                  </div>
                </ActionItem>
              )
            })}
          </div>
        </>
      )}

      {steward.encouragement && (
        <Alert
          type="success"
          showIcon
          icon={<HeartFilled />}
          style={{ marginTop: 16, borderRadius: 12 }}
          message={steward.encouragement}
        />
      )}

      {run.alerts?.length > 0 && (
        <Alert
          type="error"
          showIcon
          icon={<BellFilled />}
          style={{ marginTop: 12, borderRadius: 12 }}
          message={`智能体已自主触发 ${run.alerts.length} 条预警`}
          description={
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {run.alerts.map((a) => (
                <li key={a.id}>
                  {a.title} —— 已推送至 {a.notify?.map((n) => ({ self: '本人', family: '家属', doctor: '医生' })[n]).join('、')}
                </li>
              ))}
            </ul>
          }
        />
      )}

      {steward.disclaimer && (
        <Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
          {steward.disclaimer}
        </Paragraph>
      )}
    </div>
  ) : (
    vacant('点击「启动协同」后，健康管家会汇总各智能体结论生成今日简报')
  )

  /* ------------------------------ 体征分析 ------------------------------ */
  const vitalsTab = vitals ? (
    <div>
      <Paragraph style={{ fontSize: 15, color: '#4b5563' }}>{vitals.summary}</Paragraph>

      {(vitals.indicators || []).map((ind, i) => {
        const rate = parseFloat(String(ind.达标率 || ind.complianceRate || '0').replace('%', ''))
        const color = rate >= 80 ? '#10b981' : rate >= 50 ? '#f59e0b' : '#ef4444'
        const latestNum = Number(ind.latest)
        const meanNum = Number(ind.mean)
        const rising = latestNum > meanNum
        return (
          <IndicatorRow key={i}>
            <div style={{ width: 96, flexShrink: 0 }}>
              <div style={{ fontWeight: 600, color: '#1f2937' }}>{ind.indicator}</div>
              <Text type="secondary" style={{ fontSize: 11 }}>{ind.unit}</Text>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Progress
                percent={rate}
                strokeColor={color}
                size="small"
                format={(p) => <span style={{ fontSize: 12, color: '#6b7280' }}>{p}%</span>}
              />
              <div style={{ fontSize: 12, color: '#9ca3af', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span>最新 <b style={{ color: '#374151' }}>{ind.latest}</b></span>
                <span>均值 {ind.mean}</span>
                <span>
                  <TrendIcon direction={ind.trend?.includes('上升') ? 'rising' : ind.trend?.includes('下降') ? 'falling' : 'stable'} improving={ind.improving} />
                  {' '}{ind.trend}
                </span>
                {ind.最长连续异常 > 0 && <span style={{ color: '#f97316' }}>最长连续异常 {ind.最长连续异常} 天</span>}
              </div>
            </div>
          </IndicatorRow>
        )
      })}

      <Row gutter={16} style={{ marginTop: 20 }}>
        {vitals.highlights?.length > 0 && (
          <Col xs={24} md={12}>
            <PlanBlock>
              <Text strong style={{ color: '#10b981' }}><RiseOutlined /> 改善中的指标</Text>
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, color: '#4b5563', fontSize: 13.5, lineHeight: 1.9 }}>
                {vitals.highlights.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            </PlanBlock>
          </Col>
        )}
        {vitals.concerns?.length > 0 && (
          <Col xs={24} md={12}>
            <PlanBlock>
              <Text strong style={{ color: '#ef4444' }}><FallOutlined /> 需要关注的指标</Text>
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, color: '#4b5563', fontSize: 13.5, lineHeight: 1.9 }}>
                {vitals.concerns.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </PlanBlock>
          </Col>
        )}
      </Row>
    </div>
  ) : (
    vacant('体征分析智能体尚未运行')
  )

  /* ------------------------------ 风险预警 ------------------------------ */
  const sentinelTab = sentinel ? (
    <div>
      <Alert
        type={
          ['紧急', '预警'].includes(sentinel.highestLevel)
            ? 'error'
            : sentinel.highestLevel === '关注'
              ? 'warning'
              : 'success'
        }
        showIcon
        style={{ borderRadius: 12, marginBottom: 16 }}
        message={`综合风险等级：${sentinel.highestLevel}`}
        description={`共命中 ${sentinel.riskCount} 条风险规则；通知对象：${
          (sentinel.notifyTargets || []).map((n) => ({ self: '本人', family: '家属', doctor: '家庭医生' })[n]).join('、') || '无'
        }`}
      />

      {(sentinel.risks || []).length === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未检出风险，各项指标处于安全范围" />
      )}

      {(sentinel.risks || []).map((r, i) => {
        const color = LEVEL_COLOR[r.level] || '#9ca3af'
        return (
          <RiskItem key={i} $color={color}>
            <Space size={8} style={{ marginBottom: 6 }}>
              <Tag color={color} style={{ margin: 0, fontWeight: 700 }}>{r.level}</Tag>
              <Text strong style={{ fontSize: 15 }}>{r.title}</Text>
            </Space>
            <div style={{ fontSize: 13.5, color: '#4b5563', marginBottom: 6 }}>
              <b>判定依据：</b>{r.basis}
            </div>
            <div style={{ fontSize: 13.5, color: '#1f2937', background: '#fff', padding: '8px 12px', borderRadius: 8 }}>
              <ThunderboltFilled style={{ color: '#f59e0b', marginRight: 6 }} />
              <b>立即行动：</b>{r.action}
            </div>
          </RiskItem>
        )
      })}

      {run.alerts?.length > 0 && (
        <>
          <Divider orientation="left" style={{ fontSize: 14 }}>本次自主触发的预警</Divider>
          <List
            size="small"
            dataSource={run.alerts}
            renderItem={(a) => (
              <List.Item>
                <Space>
                  <BellFilled style={{ color: LEVEL_COLOR[a.level] || '#f59e0b' }} />
                  <Text strong>{a.title}</Text>
                  <Tag color={LEVEL_COLOR[a.level]}>
                    {(a.notify || []).map((n) => ({ self: '本人', family: '家属', doctor: '医生' })[n]).join('、')}
                  </Tag>
                </Space>
              </List.Item>
            )}
          />
        </>
      )}
    </div>
  ) : (
    vacant('风险预警智能体尚未运行')
  )

  /* ------------------------------ 干预方案 ------------------------------ */
  const plannerTab = planner ? (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <PlanBlock>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Text strong style={{ fontSize: 15 }}><ThunderboltFilled style={{ color: '#10b981', marginRight: 6 }} />运动建议</Text>
              <Statistic title="运动类型" value={planner.exercise?.type} valueStyle={{ fontSize: 18, fontWeight: 700 }} />
              <Space size={16} wrap>
                <Statistic title="单次时长" value={planner.exercise?.duration} suffix="分钟" valueStyle={{ fontSize: 16 }} />
                <Statistic title="强度" value={planner.exercise?.intensity} valueStyle={{ fontSize: 16 }} />
              </Space>
              <div style={{ fontSize: 13.5, color: '#4b5563' }}>频次：{planner.exercise?.frequency}</div>
              {planner.exercise?.note && (
                <Alert type="info" showIcon message={planner.exercise.note} style={{ borderRadius: 8, fontSize: 12.5 }} />
              )}
            </Space>
          </PlanBlock>
        </Col>

        <Col xs={24} md={12}>
          <PlanBlock>
            <Text strong style={{ fontSize: 15 }}><CoffeeOutlined style={{ color: '#f59e0b', marginRight: 6 }} />饮食方案</Text>
            <div style={{ marginTop: 10 }}>
              <Text type="secondary" style={{ fontSize: 12.5 }}>限制项</Text>
              <ul style={{ margin: '4px 0 12px', paddingLeft: 18, color: '#ef4444', fontSize: 13.5, lineHeight: 1.8 }}>
                {(planner.diet?.restrictions || []).map((d, i) => <li key={i}>{d}</li>)}
              </ul>
              <Text type="secondary" style={{ fontSize: 12.5 }}>推荐做法</Text>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: '#10b981', fontSize: 13.5, lineHeight: 1.8 }}>
                {(planner.diet?.recommendations || []).map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          </PlanBlock>
        </Col>

        <Col xs={24} md={12}>
          <PlanBlock>
            <Text strong style={{ fontSize: 15 }}><MedicineBoxOutlined style={{ color: '#6366f1', marginRight: 6 }} />用药提醒</Text>
            <div style={{ marginTop: 10 }}>
              {(planner.medicationReminders || []).map((m, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: i < planner.medicationReminders.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                  <ClockCircleOutlined style={{ color: '#6366f1', marginTop: 3 }} />
                  <div>
                    <b style={{ color: '#1f2937' }}>{m.name}</b>
                    <Tag color="blue" style={{ marginLeft: 8, fontSize: 11 }}>{m.time}</Tag>
                    <div style={{ fontSize: 12.5, color: '#6b7280', marginTop: 2 }}>{m.tip}</div>
                  </div>
                </div>
              ))}
              {!planner.medicationReminders?.length && <Text type="secondary">无需特别提醒</Text>}
            </div>
          </PlanBlock>
        </Col>

        <Col xs={24} md={12}>
          <PlanBlock>
            <Text strong style={{ fontSize: 15 }}><AimOutlined style={{ color: '#ef4444', marginRight: 6 }} />量化目标</Text>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                ['每日步数', `${planner.goals?.steps} 步`],
                ['收缩压目标', planner.goals?.systolicTarget],
                ['舒张压目标', planner.goals?.diastolicTarget],
                ['血糖目标', planner.goals?.bloodSugarTarget],
                ['体重目标', planner.goals?.weightTarget],
                ['记录要求', planner.goals?.recordStreak],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, gap: 12 }}>
                    <Text type="secondary">{k}</Text>
                    <Text strong style={{ textAlign: 'right' }}>{v}</Text>
                  </div>
                ))}
            </div>
          </PlanBlock>
        </Col>
      </Row>

      {planner.followUp && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16, borderRadius: 12 }}
          message="随访建议"
          description={planner.followUp}
        />
      )}
      {planner.disclaimer && (
        <Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
          {planner.disclaimer}
        </Paragraph>
      )}
    </div>
  ) : (
    vacant('方案规划智能体尚未运行')
  )

  return (
    <Tabs
      defaultActiveKey="brief"
      items={[
        { key: 'brief', label: '今日简报', children: briefTab },
        { key: 'vitals', label: '体征分析', children: vitalsTab },
        { key: 'risk', label: `风险预警${sentinel?.riskCount ? ` (${sentinel.riskCount})` : ''}`, children: sentinelTab },
        { key: 'plan', label: '干预方案', children: plannerTab },
      ]}
    />
  )
}

export default AgentResultPanel
