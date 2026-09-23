/**
 * 迈康 MyCare · 医生端「待审核 · 任务调整申请」列表（Step 11 · Phase 2）
 * ===========================================================================
 * 职责：把患者与「方案规划」智能体对话产生的调整申请，变成医生可签字的申请单。
 *
 * 三条不可违背的边界：
 *   · 【同意】/【修改后生效】都会走后端**同一把尺子**（`validateOverridePackage`）——
 *     前端只能用后端下发的 `overrideContract` 渲染合法选项，**不得自行硬编码枚举/阈值**。
 *   · 【驳回】必须填写理由，且**患者端任务零变化**（后端只改提案行）。
 *   · 列表只展示「任务的参数」调整（目标值 / 测量时段），医学阈值不在其中。
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Card,
  Button,
  Space,
  Tag,
  Typography,
  Empty,
  Spin,
  Modal,
  Input,
  InputNumber,
  Checkbox,
  Alert,
  message,
} from 'antd'
import {
  CheckOutlined,
  EditOutlined,
  CloseOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import styled from 'styled-components'

import { getTaskProposals, reviewTaskProposal, getPatientTasks, OVERRIDE_ERROR_HINT } from '../../services/doctorApi'

const { Text, Paragraph } = Typography
const { TextArea } = Input

const TASK_LABEL = Object.freeze({
  steps: '每日步数',
  exercise: '运动时长',
  bp_monitor: '血压测量',
  bg_monitor: '血糖测量',
  weight_record: '体重记录',
})
const FIELD_LABEL = Object.freeze({ target: '目标', slots: '测量时段', enabled: '启用状态' })

/**
 * 该申请是否为「新增监测项」。
 * Step 12 起语义变更：医生「同意」= **真正启用该监测域**（患者今日任务立即出现该项，
 * 且该维度计入评分适用维度）。与参数调整的差别只剩「可编辑字段」与「无 diff 可显示」。
 */
const isMonitorRequest = (item) => item?.type === 'monitor_request'

/** 该条目在「修改后生效」弹窗里可编辑的字段：新增监测类固定为测量时段 slots */
const editableFieldOf = (item) => (isMonitorRequest(item) ? 'slots' : item?.field)

const Item = styled(Card)`
  margin-bottom: 12px;

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .who {
    font-weight: 700;
    font-size: 15px;
  }
  .quote {
    margin: 10px 0;
    padding: 8px 12px;
    border-left: 3px solid #d9d9d9;
    background: #fafafa;
    color: #475569;
    font-size: 13px;
    border-radius: 0 6px 6px 0;
    line-height: 1.6;
  }
  .diff {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 13.5px;
  }
  .old {
    color: #94a3b8;
    text-decoration: line-through;
  }
  .new {
    color: #b45309;
    font-weight: 700;
  }
  .reason {
    margin-top: 6px;
    font-size: 12.5px;
    color: #64748b;
    line-height: 1.5;
  }
  .actions {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed #e5e7eb;
  }
`

/** 目标值可读文案（步数带千分位，与首页 / 患者端口径一致） */
function fmt(taskId, field, value) {
  if (Array.isArray(value)) return value.length ? value.join('、') : '—'
  if (value === null || value === undefined) return '—'
  if (field === 'target') {
    if (taskId === 'steps') return `${Number(value).toLocaleString('zh-CN')} 步`
    if (taskId === 'exercise') return `${value} 分钟`
  }
  return String(value)
}

const ProposalReviewList = ({ doctorId = 'doc_li', patients = [], onChanged }) => {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState([])
  const [busy, setBusy] = useState(false)

  // 驳回弹窗
  const [rejectTarget, setRejectTarget] = useState(null)
  const [rejectReason, setRejectReason] = useState('')

  // 修改后生效弹窗
  const [modifyTarget, setModifyTarget] = useState(null) // { proposal, item }
  const [modifyValue, setModifyValue] = useState(null)
  const [contract, setContract] = useState(null)
  const [contractLoading, setContractLoading] = useState(false)

  const nameOf = useCallback(
    (patientId) => patients.find((p) => p.id === patientId)?.name || patientId,
    [patients]
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getTaskProposals(doctorId, { status: 'pending' })
      setItems(res.proposals || [])
    } catch (e) {
      message.error(`调整申请加载失败：${e.message}`)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [doctorId])

  useEffect(() => {
    load()
  }, [load])

  const afterReview = async (tip) => {
    message.success(tip)
    await load()
    if (typeof onChanged === 'function') onChanged()
  }

  /* ------------------------- 同意 ------------------------- */
  const handleApprove = async (proposal) => {
    setBusy(true)
    try {
      await reviewTaskProposal(doctorId, proposal.proposalId, { decision: 'approve' })
      await afterReview(
        isMonitorRequest((proposal.proposals || [])[0])
          ? '已同意，该监测项已加入患者的每日任务，并计入当日健康评分'
          : '已同意申请，患者今日任务已更新'
      )
    } catch (e) {
      message.error(OVERRIDE_ERROR_HINT[e.code] || e.message)
    } finally {
      setBusy(false)
    }
  }

  /* ------------------------- 驳回 ------------------------- */
  const submitReject = async () => {
    if (!rejectTarget) return
    const reason = rejectReason.trim()
    if (reason.length < 4) {
      message.warning('请填写驳回理由（至少 4 字）')
      return
    }
    setBusy(true)
    try {
      await reviewTaskProposal(doctorId, rejectTarget.proposalId, { decision: 'reject', reason })
      setRejectTarget(null)
      setRejectReason('')
      await afterReview('已驳回申请，患者今日任务未发生变化')
    } catch (e) {
      message.error(OVERRIDE_ERROR_HINT[e.code] || e.message)
    } finally {
      setBusy(false)
    }
  }

  /* --------------------- 修改后生效 --------------------- */
  const openModify = async (proposal, item) => {
    setModifyTarget({ proposal, item })
    if (isMonitorRequest(item)) {
      // 新增监测类：没有 proposedValue，编辑的是测量时段；默认值由后端契约字典给出
      setModifyValue([])
    } else {
      setModifyValue(Array.isArray(item.proposedValue) ? item.proposedValue.slice() : item.proposedValue)
    }
    setContract(null)
    setContractLoading(true)
    try {
      // 合法选项一律取后端下发的契约字典，前端不硬编码枚举
      const res = await getPatientTasks(doctorId, proposal.patientId)
      setContract(res.overrideContract || null)
      if (isMonitorRequest(item)) {
        // 默认勾选规则库的默认时段（与后端「未指定 slots 时回落默认」的取值一致）
        const spec = res.overrideContract?.addableMonitorTasks?.[item.taskId]
        setModifyValue(Array.isArray(spec?.defaultSlots) ? spec.defaultSlots.slice() : [])
      }
    } catch (e) {
      message.error(`可调整范围加载失败：${e.message}`)
    } finally {
      setContractLoading(false)
    }
  }

  const submitModify = async () => {
    if (!modifyTarget) return
    const { proposal, item } = modifyTarget
    const field = editableFieldOf(item)
    if (isMonitorRequest(item) && (!Array.isArray(modifyValue) || modifyValue.length === 0)) {
      message.error('请至少选择一个测量时段')
      return
    }
    setBusy(true)
    try {
      await reviewTaskProposal(doctorId, proposal.proposalId, {
        decision: 'modify',
        overrides: { [item.taskId]: { [field]: modifyValue } },
        reason: isMonitorRequest(item)
          ? `医生指定测量时段后生效（${(modifyValue || []).join('、')}）`
          : `医生调整后生效（原申请：${fmt(item.taskId, item.field, item.proposedValue)}）`,
      })
      setModifyTarget(null)
      await afterReview('已按修改后的值生效')
    } catch (e) {
      message.error(OVERRIDE_ERROR_HINT[e.code] || e.message)
    } finally {
      setBusy(false)
    }
  }

  const renderEditor = () => {
    const item = modifyTarget?.item
    if (!item) return null
    if (editableFieldOf(item) === 'slots') {
      if (contractLoading) return <Spin />
      const spec = contract?.fields?.[item.taskId]?.fields?.slots
      const options = spec?.enum || item.currentValue || []
      return (
        <div>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            可选时段（来自后端下发的可调整范围）
          </Text>
          <div style={{ marginTop: 8 }}>
            <Checkbox.Group
              value={Array.isArray(modifyValue) ? modifyValue : []}
              onChange={(v) => setModifyValue(v)}
              options={options.map((s) => ({ label: s, value: s }))}
            />
          </div>
        </div>
      )
    }
    const spec = contract?.fields?.[item.taskId]?.fields?.[item.field]
    const range = spec?.range || (item.taskId === 'steps' ? [1000, 20000] : [5, 180])
    return (
      <div>
        <Text type="secondary" style={{ fontSize: 12.5 }}>
          允许范围：{range[0]} – {range[1]}
          {spec?.multipleOf ? `（且为 ${spec.multipleOf} 的整数倍）` : ''}
        </Text>
        <div style={{ marginTop: 8 }}>
          <InputNumber
            value={modifyValue}
            onChange={setModifyValue}
            min={range[0]}
            max={range[1]}
            step={spec?.multipleOf || 1}
            style={{ width: 200 }}
            addonAfter={item.taskId === 'steps' ? '步' : '分钟'}
          />
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text type="secondary">
          患者在对话中提出的申请，需医生审核后才会生效；<b>审核前患者端任务保持不变</b>。
          「申请新增监测」类同意后，该监测项会<b>加入患者的每日任务并计入当日健康评分</b>；
          如需指定测量时段，请用「修改后生效」。
        </Text>
        <Button icon={<ReloadOutlined />} onClick={load} size="small">
          刷新
        </Button>
      </div>

      {items.length === 0 ? (
        <Empty description="暂无待审核的任务调整申请" />
      ) : (
        items.map((proposal) => (
          <Item key={proposal.proposalId} size="small">
            <div className="head">
              <span className="who">
                {proposal.patientName || nameOf(proposal.patientId)}
                <Text type="secondary" style={{ fontWeight: 400, fontSize: 12.5, marginLeft: 8 }}>
                  {proposal.patientId}
                </Text>
              </span>
              <Space size={6}>
                {proposal.patientAuthorized === false && (
                  <Tag color="default">待授权 · 健康数据暂不可见</Tag>
                )}
                <Tag icon={<ClockCircleOutlined />} color="orange">
                  待审核
                </Tag>
                {proposal.agentId ? <Tag color="green">方案规划智能体提交</Tag> : null}
              </Space>
            </div>

            {proposal.utterance ? <div className="quote">“{proposal.utterance}”</div> : null}

            {(proposal.proposals || []).map((item, i) => (
              <div key={`${item.taskId}-${item.field}-${i}`} style={{ marginTop: i ? 10 : 0 }}>
                {isMonitorRequest(item) ? (
                  /* 申请新增监测项：没有「当前值 → 建议值」——它不在既有任务里，故无 diff 可显示。
                     同意后由后端写入 addedTasks 覆盖包，患者端出现该监测任务。 */
                  <div className="diff">
                    <Tag color="purple">申请新增监测</Tag>
                    <span className="new">{item.label || TASK_LABEL[item.taskId] || item.taskId}</span>
                    <Text type="secondary" style={{ fontSize: 12.5 }}>
                      同意后加入患者每日任务（测量时段取规则库默认值），并计入当日健康评分
                    </Text>
                  </div>
                ) : (
                  <div className="diff">
                    <Tag color="blue">{TASK_LABEL[item.taskId] || item.taskId}</Tag>
                    <span>{FIELD_LABEL[item.field] || item.field}</span>
                    <span className="old">{fmt(item.taskId, item.field, item.currentValue)}</span>
                    <span>→</span>
                    <span className="new">{fmt(item.taskId, item.field, item.proposedValue)}</span>
                  </div>
                )}
                {item.reason ? <div className="reason">申请依据：{item.reason}</div> : null}
              </div>
            ))}

            <div className="actions">
              <Space wrap>
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={busy}
                  onClick={() => handleApprove(proposal)}
                >
                  同意
                </Button>
                <Button
                  icon={<EditOutlined />}
                  disabled={busy}
                  onClick={() => openModify(proposal, (proposal.proposals || [])[0])}
                >
                  修改后生效
                </Button>
                <Button
                  danger
                  icon={<CloseOutlined />}
                  disabled={busy}
                  onClick={() => {
                    setRejectTarget(proposal)
                    setRejectReason('')
                  }}
                >
                  驳回
                </Button>
              </Space>
            </div>
          </Item>
        ))
      )}

      {/* 驳回 */}
      <Modal
        title="驳回调整申请"
        open={Boolean(rejectTarget)}
        onCancel={() => setRejectTarget(null)}
        onOk={submitReject}
        okText="确认驳回"
        okButtonProps={{ danger: true, loading: busy }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="驳回不会改变患者今日任务"
          description="患者会收到一条含驳回理由的医生建议。"
        />
        <TextArea
          rows={3}
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="请填写驳回理由（4–200 字），患者可见"
          maxLength={200}
        />
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
          当前 {rejectReason.trim().length} / 200
        </Paragraph>
      </Modal>

      {/* 修改后生效 */}
      <Modal
        title="修改后生效"
        open={Boolean(modifyTarget)}
        onCancel={() => setModifyTarget(null)}
        onOk={submitModify}
        okText="确认生效"
        confirmLoading={busy}
      >
        {modifyTarget ? (
          <div>
            <Paragraph type="secondary" style={{ fontSize: 13 }}>
              {modifyTarget.proposal.patientName || nameOf(modifyTarget.proposal.patientId)} ·{' '}
              {TASK_LABEL[modifyTarget.item.taskId] || modifyTarget.item.taskId}
              {isMonitorRequest(modifyTarget.item) ? (
                <>：申请新增该监测项 —— 请指定测量时段</>
              ) : (
                <>
                  {' '}
                  {FIELD_LABEL[modifyTarget.item.field]}：申请为{' '}
                  <Text delete>
                    {fmt(modifyTarget.item.taskId, modifyTarget.item.field, modifyTarget.item.proposedValue)}
                  </Text>
                </>
              )}
            </Paragraph>
            {renderEditor()}
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message="生效值仍需通过后端校验"
              description="越界或非法取值会被后端直接拒绝，患者端任务不会发生变化。"
            />
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

export default ProposalReviewList
