/**
 * 迈康 MyCare · 患者端「已提交医生审核」卡片（Step 11 · Phase 2）
 * ===========================================================================
 * 定位：把「与方案规划智能体的对话」变成一张**需要医生签字的申请单**的
 *      患者侧回执 —— 只说明「申请已提交」，**不承诺生效**。
 *
 * 不可违背的文案口径：
 *   · 必须明确「医生确认后才会生效」——避免患者误以为任务已经改掉；
 *   · 必须显示**当前值 → 建议值**的对照（当前值由后端注入，非模型产出）；
 *   · 不出现任何医学阈值相关字样（阈值请求根本不会生成提案）。
 */
import React from 'react'
import { Tag, Typography } from 'antd'
import { ClockCircleOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import styled from 'styled-components'

const { Text } = Typography

/** 任务名与字段名的展示映射（只在此处定义） */
const TASK_LABEL = Object.freeze({
  steps: '每日步数',
  exercise: '运动时长',
  bp_monitor: '血压测量',
  bg_monitor: '血糖测量',
  weight_record: '体重记录',
})

const FIELD_LABEL = Object.freeze({
  target: '目标',
  slots: '测量时段',
  enabled: '启用状态',
})

const Box = styled.div`
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid #fde68a;
  background: #fffbeb;
  /* 气泡是 white-space: pre-wrap，卡片内必须复位，否则 JSX 缩进换行会被原样渲染 */
  white-space: normal;

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 13.5px;
    color: #b45309;
    margin-bottom: 8px;
  }
  .item {
    padding: 8px 0;
    border-top: 1px dashed #fde68a;

    &:first-of-type {
      border-top: none;
    }
  }
  .item-task {
    font-size: 13px;
    color: #1f2937;
    font-weight: 600;
  }
  .item-diff {
    font-size: 13px;
    color: #6b7280;
    margin-top: 2px;
  }
  .item-reason {
    font-size: 12.5px;
    color: #92400e;
    margin-top: 4px;
    line-height: 1.5;
  }
  .foot {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed #fde68a;
    font-size: 12px;
    color: #a16207;
    line-height: 1.5;
  }
`

/** 目标值的可读文案（步数带千分位，与首页口径一致） */
function formatValue(taskId, field, value) {
  if (Array.isArray(value)) return value.length ? value.join('、') : '—'
  if (value === null || value === undefined) return '—'
  if (field === 'target') {
    if (taskId === 'steps') return `${Number(value).toLocaleString('zh-CN')} 步`
    if (taskId === 'exercise') return `${value} 分钟`
  }
  return String(value)
}

const TaskProposalCard = ({ proposal }) => {
  const items = Array.isArray(proposal?.proposals) ? proposal.proposals : []
  if (!items.length) return null

  return (
    <Box data-testid="task-proposal-card">
      <div className="head">
        <ClockCircleOutlined />
        已提交医生审核
        <Tag color="orange" style={{ marginLeft: 4 }}>
          待审核
        </Tag>
      </div>

      {items.map((p, i) => {
        const taskName = p.label ? `${p.label}监测` : TASK_LABEL[p.taskId] || p.taskId
        const isMonitorRequest = p.type === 'monitor_request'
        if (isMonitorRequest) {
          /* 申请新增监测项：覆盖层无权新建任务域，故**没有**「当前值 → 建议值」对照，
             只用一句话说清楚「申请了什么、由谁定」。 */
          return (
            <div className="item" key={`${p.taskId}-${p.field}-${i}`}>
              <div className="item-task">申请新增：{taskName}</div>
              <div className="item-diff">系统不会自行新增监测任务，是否纳入由医生判断。</div>
              {p.reason ? <div className="item-reason">{p.reason}</div> : null}
            </div>
          )
        }
        const fieldName = FIELD_LABEL[p.field] || p.field
        return (
          <div className="item" key={`${p.taskId}-${p.field}-${i}`}>
            <div className="item-task">
              {taskName}
              <Text type="secondary" style={{ fontWeight: 400, marginLeft: 6, fontSize: 12.5 }}>
                {fieldName}
              </Text>
            </div>
            <div className="item-diff">
              {formatValue(p.taskId, p.field, p.currentValue)} →{' '}
              <Text strong style={{ color: '#b45309' }}>
                {formatValue(p.taskId, p.field, p.proposedValue)}
              </Text>
            </div>
            {p.reason ? <div className="item-reason">依据：{p.reason}</div> : null}
          </div>
        )
      })}

      <div className="foot">
        <SafetyCertificateOutlined style={{ marginRight: 4 }} />
        {items.some((p) => p.type === 'monitor_request') ? (
          <>
            新增监测需医生评估，<b>当前任务保持不变</b>。
          </>
        ) : (
          <>
            医生确认后才会生效，<b>当前任务保持不变</b>。
          </>
        )}
        {proposal?.filteredCount > 0
          ? `另有 ${proposal.filteredCount} 项请求不符合调整范围，未提交。`
          : ''}
      </div>
    </Box>
  )
}

export default TaskProposalCard
