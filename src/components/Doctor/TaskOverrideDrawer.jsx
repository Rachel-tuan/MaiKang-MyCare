/**
 * 迈康 MyCare · 医生端「今日任务」调整抽屉（Step 11 · Phase 1）
 * ===========================================================================
 * 职责：让医生在**规则已生成的任务**上调整参数（目标值 / 监测时段），并留下调整依据。
 *
 * 不可违背的边界：
 *   · 可调整项与取值范围**全部来自后端下发的 overrideContract**，
 *     前端**不得自行硬编码枚举或阈值**（避免前后端各写一套）。
 *   · 第一版**不允许停用任何任务**（D4）：主诊断监测项与非主诊断项均显示禁用态与明确文案，
 *     且后端会独立硬拒绝 —— 前端禁用只是体验，不是准入。
 *   · 提交前展示 **diff 二次确认**；`basis`（调整依据）必填 4–200 字。
 *   · 医学阈值（血压/血糖控制目标）**不在本抽屉内**，也不允许被调整。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Drawer, Button, Space, Typography, Tag, Input, InputNumber, Checkbox, Alert, Spin, Modal, Empty, Divider, message } from 'antd'
import { EditOutlined, WarningOutlined, CheckCircleOutlined } from '@ant-design/icons'
import styled from 'styled-components'

import { getPatientTasks, putTaskOverrides, deleteTaskOverride, OVERRIDE_ERROR_HINT } from '../../services/doctorApi'
import { SLOT_LABEL_ZH } from '../../utils/taskOverride'
import { hasHypertension, hasDiabetes, hasDisease, DISEASE_KEYWORD } from '../../utils/disease'

const { Text, Title } = Typography
const { TextArea } = Input

const TaskRow = styled.div`
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 12px;
  background: ${({ $editable }) => ($editable ? '#fff' : '#f8fafc')};

  .task-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .task-title {
    font-weight: 600;
    font-size: 15px;
  }
  .task-meta {
    color: #64748b;
    font-size: 12.5px;
    margin-top: 4px;
  }
  .task-edit {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed #e5e7eb;
  }
  .slot-group {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
`

/** 主诊断监测项判定（与后端 isPrimaryMonitorTask 同口径；仅用于展示禁用文案） */
function isPrimaryMonitor(taskId, patient) {
  const primary = String(patient?.medical?.primaryDisease || '')
  const diseases = patient?.diseases || []
  if (taskId === 'bp_monitor') return primary.includes('高血压') || hasHypertension(diseases)
  if (taskId === 'bg_monitor') return primary.includes('糖尿病') || hasDiabetes(diseases)
  if (taskId === 'weight_record') return primary.includes('肥胖') || hasDisease(diseases, DISEASE_KEYWORD.obesity)
  return false
}

const TaskOverrideDrawer = ({ open, patient, doctorId = 'doc_li', onClose, onSaved }) => {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [state, setState] = useState(null)
  const [draft, setDraft] = useState({}) // { [taskId]: { target?, slots? } }
  const [basis, setBasis] = useState('')

  const load = useCallback(async () => {
    if (!patient?.id) return
    setLoading(true)
    try {
      const res = await getPatientTasks(doctorId, patient.id)
      setState(res)
      // 用当前生效覆盖回填草稿，便于医生在既有调整上继续改
      setDraft(JSON.parse(JSON.stringify(res.overrides || {})))
    } catch (e) {
      message.error(`读取今日任务失败：${e.message}`)
      setState(null)
    } finally {
      setLoading(false)
    }
  }, [doctorId, patient?.id])

  useEffect(() => {
    if (open) {
      setBasis('')
      load()
    } else {
      setState(null)
      setDraft({})
    }
  }, [open, load])

  const contract = state?.overrideContract
  const editableIds = contract?.taskIds || []

  /** 草稿与生效值的差异（用于 diff 二次确认与是否有变更判定） */
  const diff = useMemo(() => {
    if (!state) return []
    const rows = []
    for (const task of state.tasks || []) {
      const ov = draft[task.taskId]
      if (!ov) continue
      if (Number.isInteger(ov.target) && ov.target !== task.target) {
        rows.push({ taskId: task.taskId, title: task.title, field: '目标值', from: `${task.target}`, to: `${ov.target}` })
      }
      if (Array.isArray(ov.slots)) {
        const fromSlots = (task.slots || []).map((s) => SLOT_LABEL_ZH[s.slot] || s.slot).join('、')
        const toSlots = ov.slots.map((s) => SLOT_LABEL_ZH[s] || s).join('、')
        if (fromSlots !== toSlots) {
          rows.push({ taskId: task.taskId, title: task.title, field: '监测时段', from: fromSlots, to: toSlots })
        }
      }
    }
    return rows
  }, [state, draft])

  const setField = (taskId, patch) => {
    setDraft((prev) => {
      const next = { ...prev, [taskId]: { ...(prev[taskId] || {}), ...patch } }
      if (!next[taskId] || Object.keys(next[taskId]).length === 0) delete next[taskId]
      return next
    })
  }

  const handleSubmit = async () => {
    if (!diff.length) return message.warning('尚未修改任何任务参数')
    const trimmed = basis.trim()
    if (trimmed.length < 4) return message.warning('请填写调整依据（4–200 字）')

    // —— diff 二次确认 ——
    Modal.confirm({
      title: '确认调整今日任务？',
      width: 520,
      icon: <WarningOutlined style={{ color: '#f59e0b' }} />,
      content: (
        <div>
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary">患者 「{patient?.name}」 的今日任务将发生以下变化：</Text>
          </div>
          {diff.map((d) => (
            <div key={`${d.taskId}_${d.field}`} style={{ marginBottom: 4 }}>
              <Text strong>{d.title}</Text>
              <Text type="secondary"> · {d.field}：</Text>
              <Text delete>{d.from}</Text>
              <Text> → </Text>
              <Text strong style={{ color: '#1677ff' }}>{d.to}</Text>
            </div>
          ))}
          <Divider style={{ margin: '10px 0' }} />
          <div>
            <Text type="secondary">调整依据：</Text>
            <Text>{trimmed}</Text>
          </div>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              规则仍是任务的唯一生成者：本次调整只改参数，不会新增或删除任务项，也不触碰任何医学阈值。
            </Text>
          </div>
        </div>
      ),
      okText: '确认调整',
      cancelText: '再想想',
      onOk: async () => {
        setSaving(true)
        try {
          await putTaskOverrides(doctorId, patient.id, { overrides: draft, basis: trimmed })
          message.success('已保存，患者端今日任务已同步生效')
          await load()
          setBasis('')
          if (onSaved) onSaved()
        } catch (e) {
          message.error(`${OVERRIDE_ERROR_HINT[e.code] || '保存失败'}：${e.message}`)
        } finally {
          setSaving(false)
        }
      },
    })
  }

  const handleRevoke = (taskId, title) => {
    Modal.confirm({
      title: `撤销「${title}」的调整？`,
      content: '撤销后该任务将回落到规则原始值。',
      okText: '确认撤销',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteTaskOverride(doctorId, patient.id, taskId)
          message.success('已撤销，已回落规则值')
          await load()
          if (onSaved) onSaved()
        } catch (e) {
          message.error(`撤销失败：${e.message}`)
        }
      },
    })
  }

  const renderEditor = (task) => {
    /**
     * ⚠️ 契约字典是**双层 fields**：外层 `fields` 是「可覆盖任务字典」，
     *    内层 `fields` 才是该任务的「字段契约」（见 taskOverride.js 的 TASK_OVERRIDE_CONTRACT）。
     *    少取一层 → `spec.target` / `spec.slots` 恒为 undefined → 编辑器**静默不渲染**
     *    （任务行照常显示、保存按钮恒禁用、无任何报错）。实测被验收脚本抓到。
     */
    const spec = contract?.fields?.[task.taskId]?.fields
    if (!spec || !Object.keys(spec).length) return null
    const ov = draft[task.taskId] || {}

    // —— 数值目标型（steps / exercise）——
    if (spec.target) {
      return (
        <div className="task-edit">
          <Space align="center" wrap>
            <Text type="secondary">目标值</Text>
            <InputNumber
              min={spec.target.range[0]}
              max={spec.target.range[1]}
              step={spec.target.multipleOf || 1}
              value={Number.isInteger(ov.target) ? ov.target : task.target}
              onChange={(v) => setField(task.taskId, { target: Number.isInteger(v) ? v : undefined })}
              addonAfter={task.unit}
              style={{ width: 190 }}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              允许范围 {spec.target.range[0]}–{spec.target.range[1]}
              {spec.target.multipleOf ? `，需为 ${spec.target.multipleOf} 的整数倍` : ''}
            </Text>
          </Space>
        </div>
      )
    }

    // —— 时段型（bp_monitor / bg_monitor）：改时段 = 改频次 ——
    if (spec.slots) {
      const current = Array.isArray(ov.slots) ? ov.slots : (task.slots || []).map((s) => s.slot)
      return (
        <div className="task-edit">
          <Text type="secondary">监测时段（选中项数即当日频次）</Text>
          <div className="slot-group" style={{ marginTop: 8 }}>
            <Checkbox.Group
              value={current}
              onChange={(vals) => setField(task.taskId, { slots: vals.length ? vals : undefined })}
              options={spec.slots.enum.map((s) => ({ label: SLOT_LABEL_ZH[s] || s, value: s }))}
            />
          </div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            当前频次 {task.target} 次/日；时段数量变化后频次同步变化
          </Text>
        </div>
      )
    }
    return null
  }

  const renderTask = (task) => {
    const editable = editableIds.includes(task.taskId)
    const ov = task.override
    const ovDraft = draft[task.taskId]
    const primary = isPrimaryMonitor(task.taskId, patient)

    return (
      <TaskRow key={task.taskId} $editable={editable}>
        <div className="task-head">
          <div>
            <span className="task-title">{task.title}</span>
            <span style={{ marginLeft: 8 }}>
              <Tag color="blue">{task.target} {task.unit}</Tag>
              <Tag>{`进度 ${task.done}/${task.target}`}</Tag>
              {task.actualCount !== task.done && <Tag color="cyan">{`实际 ${task.actualCount}`}</Tag>}
              {ov && <Tag color="gold" icon={<EditOutlined />}>医生已调整</Tag>}
              {ovDraft && <Tag color="processing">待保存</Tag>}
            </span>
            <div className="task-meta">{task.reason}</div>
            {ov?.basis && (
              <div className="task-meta">
                调整依据：{ov.basis}
                {ov.at ? `（${String(ov.at).slice(0, 16)}）` : ''}
              </div>
            )}
          </div>
          <Space>
            {editable && ov && (
              <Button size="small" danger type="link" onClick={() => handleRevoke(task.taskId, task.title)}>
                撤销调整
              </Button>
            )}
            {!editable && (
              <Tag color="default">
                {contract?.notOverridableTaskIds?.includes(task.taskId)
                  ? '当前版本不支持调整该任务'
                  : '该任务今日未生成，不可调整'}
              </Tag>
            )}
          </Space>
        </div>

        {editable && renderEditor(task)}

        {editable && (
          <div style={{ marginTop: 10 }}>
            <Space size={6} wrap>
              <WarningOutlined style={{ color: '#94a3b8' }} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                停用任务：
                {primary ? '当前版本不允许停用主诊断监测项' : '当前版本不支持停用任务'}
              </Text>
            </Space>
          </div>
        )}
      </TaskRow>
    )
  }

  return (
    <Drawer
      title={`今日任务调整 · ${patient?.name || ''}`}
      open={open}
      onClose={onClose}
      width={620}
      extra={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            loading={saving}
            disabled={!diff.length}
            onClick={handleSubmit}
          >
            保存调整{diff.length ? `（${diff.length}）` : ''}
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14, borderRadius: 10 }}
        message="规则是今日任务的唯一生成者"
        description="医生只能调整「规则今日已经生成的任务」的参数（目标值 / 监测时段），不能新增或删除任务项，也不能修改任何医学阈值。"
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : !state ? (
        <Empty description="未能读取今日任务" />
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              生成日期：{state.date}
              {state.overridePackage?.reviewedBy ? ` · 当前生效调整由 ${state.overridePackage.reviewedBy} 于 ${String(state.overridePackage.reviewedAt || '').slice(0, 16)} 提交` : ' · 当前无生效调整'}
            </Text>
          </div>

          {(state.tasks || []).map(renderTask)}

          <Title level={5} style={{ marginTop: 18 }}>
            调整依据（必填）
          </Title>
          <TextArea
            rows={3}
            maxLength={200}
            showCount
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
            placeholder="例：患者主诉膝关节疼痛，近 7 日步数 3,000–4,000，先下调目标"
          />
          <div style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              依据会随患者端任务卡一并展示，患者可见。
            </Text>
          </div>
        </>
      )}
    </Drawer>
  )
}

export default TaskOverrideDrawer
