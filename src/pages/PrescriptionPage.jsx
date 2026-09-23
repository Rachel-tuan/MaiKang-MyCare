/**
 * 迈康 MyCare · 个性化健康建议（六智能体协同）
 * ===========================================================================
 * 本页不再是「前端一张静态模板」，而是**六个智能体协同产出**的可追溯结果：
 *
 *   ① 体征分析智能体   现状盘点（均值 / 趋势 / 达标率）
 *   ② 多模态识别智能体 用药与化验解读（药物用途与注意事项）
 *   ③ 风险预警智能体   产品预警等级 + 运动与生活禁忌
 *   ④ 方案规划智能体   运动 / 饮食 / 用药建议主体（结合生活画像做个性化）
 *   ⑤ 情感陪伴智能体   坚持策略、鼓励与「做不到时的退路方案」
 *   ⑥ 健康管家智能体   汇总成文（监测 / 运动 / 饮食 / 用药四条要点）
 *
 * 红线：
 *   · 页面**不做任何阈值判断**：达标率、预警等级全部来自后端确定性规则；
 *   · 智能体只产出「建议文本」，不写库、不改今日任务、不改医学阈值；
 *   · 表单只补档案（身高 / 体重 / 年龄 / 性别 / 疾病），保存后医生端可见。
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card,
  Button,
  Form,
  Input,
  Select,
  InputNumber,
  Radio,
  Divider,
  Typography,
  Space,
  Alert,
  Spin,
  Tag,
  Empty,
  Badge
} from 'antd'
import {
  HeartOutlined,
  ThunderboltOutlined,
  AppleOutlined,
  MedicineBoxOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  LoadingOutlined,
  ExperimentOutlined
} from '@ant-design/icons'
import styled from 'styled-components'
import { useUser } from '../contexts/UserContext'
import { useHealthData } from '../contexts/HealthDataContext'
import { useAgent } from '../contexts/AgentContext'
import { runCarePlan } from '../services/agentApi'
import { getProfile, updateProfile } from '../services/patientApi'

const { Title, Text, Paragraph } = Typography

/** 表单英文枚举 → 应用内中文规范值（档案与规则按中文疾病关键字匹配） */
const DISEASE_LABEL = {
  hypertension: '高血压',
  diabetes: '糖尿病',
  obesity: '肥胖症',
  hyperlipidemia: '高血脂',
  coronary_heart_disease: '冠心病',
}
const GENDER_LABEL = { male: '男', female: '女' }
const DISEASE_ENUM_BY_LABEL = {
  高血压: 'hypertension',
  糖尿病: 'diabetes',
  肥胖症: 'obesity',
  高血脂: 'hyperlipidemia',
  冠心病: 'coronary_heart_disease',
}

const PageContainer = styled.div`
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;

  @media (max-width: 768px) {
    padding: 16px;
  }
`

const PrescriptionCard = styled(Card)`
  margin-bottom: 24px;
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);

  .ant-card-head {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    border-radius: 12px 12px 0 0;

    .ant-card-head-title {
      color: white;
      font-size: 18px;
      font-weight: bold;
    }
  }
`

const FormCard = styled(Card)`
  margin-bottom: 24px;
  border-radius: 12px;

  .ant-form-item-label > label {
    font-size: 16px;
    font-weight: 600;
  }
`

const PrescriptionSection = styled.div`
  margin-bottom: 24px;

  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;

    .section-icon {
      font-size: 20px;
      color: #6366f1;
    }

    .section-title {
      font-size: 18px;
      font-weight: bold;
      margin: 0;
    }
  }

  .prescription-content {
    background: #f8fafc;
    padding: 16px;
    border-radius: 8px;
    border-left: 4px solid #6366f1;
  }
`

const ActionButton = styled(Button)`
  height: 48px;
  font-size: 16px;
  font-weight: 600;
  border-radius: 8px;

  &.primary {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    border: none;

    &:hover {
      background: linear-gradient(135deg, #5855eb 0%, #7c3aed 100%);
    }
  }
`

const StatusTag = styled(Tag)`
  font-size: 14px;
  padding: 4px 12px;
  border-radius: 16px;
`

const AgentRow = styled.div`
  padding: 12px 14px;
  border-radius: 12px;
  margin-bottom: 10px;
  border: 1px solid ${(p) => (p.$state === 'done' ? '#bbf7d0' : p.$state === 'running' ? '#c7d2fe' : '#eef0f4')};
  background: ${(p) => (p.$state === 'done' ? '#f6ffed' : p.$state === 'running' ? '#f5f6ff' : '#fafafa')};

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .body {
    margin-top: 8px;
    font-size: 13px;
    color: #475569;
    line-height: 1.7;
  }
  .k {
    color: #94a3b8;
  }
`

/** 智能体产出 → 一行摘要（页面上不展开原始 JSON） */
function summarizeResult(id, data) {
  if (!data || typeof data !== 'object') return null
  switch (id) {
    case 'vitals':
      return data.summary
        ? `${data.summary}${(data.indicators || []).length ? `（${(data.indicators || []).length} 项指标）` : ''}`
        : null
    case 'vision':
      return data.summary
    case 'sentinel':
      return data.highestLevel
        ? `产品预警等级：${data.highestLevel}；命中 ${data.riskCount ?? (data.risks || []).length} 条规则${
            (data.restrictions || []).length ? `；禁忌 ${(data.restrictions || []).length} 项` : ''
          }`
        : null
    case 'planner':
      return data.exercise
        ? `${data.exercise.type || '运动方案'} ${data.exercise.duration || ''} 分钟 · ${
            data.exercise.frequency || ''
          }；饮食建议 ${(data.diet?.recommendations || []).length + (data.diet?.restrictions || []).length} 条`
        : data.summary || null
    case 'companion':
      return data.encouragement || data.message || null
    case 'steward':
      return data.headline || data.summary || null
    default:
      return data.summary || null
  }
}

/** 智能体思考/工具记录 → 可读文本 */
function thoughtText(t) {
  if (!t) return ''
  return typeof t === 'string' ? t : JSON.stringify(t)
}

const PrescriptionPage = () => {
  const [form] = Form.useForm()
  const [running, setRunning] = useState(false)
  const [agentStates, setAgentStates] = useState({})
  const [carePlan, setCarePlan] = useState(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileRaw, setProfileRaw] = useState(null)
  const { user } = useUser()
  const { getActivePrescriptions } = useHealthData()
  const { agents } = useAgent()

  const patientId = user?.user_id || user?.patient_id || null
  const abortRef = useRef(null)

  /** 六智能体在本页的固定顺序（与后端 CARE_PLAN_PIPELINE 一致） */
  const CARE_ORDER = ['vitals', 'vision', 'sentinel', 'planner', 'companion', 'steward']

  const agentMeta = useCallback(
    (id) => {
      const hit = (agents || []).find((a) => a.id === id)
      return hit || { id, name: id, icon: '🤖', role: '', color: '#6366f1' }
    },
    [agents]
  )

  /* ---------------- 加载档案：预填表单 + 作为六智能体的输入 ---------------- */
  const reloadProfile = useCallback(() => {
    if (!patientId) return
    getProfile(patientId)
      .then((d) => setProfileRaw(d?.profile || null))
      .catch(() => {
        /* 档案读取失败不影响页面其它部分 */
      })
  }, [patientId])

  useEffect(() => {
    reloadProfile()
  }, [reloadProfile])

  useEffect(() => {
    if (user) {
      form.setFieldsValue({
        height: user.height,
        weight: user.weight,
        age: user.age,
        gender: user.gender === '男' ? 'male' : user.gender === '女' ? 'female' : user.gender,
        diseases: (user.disease_types || user.diseases || []).map((d) => DISEASE_ENUM_BY_LABEL[d]).filter(Boolean),
      })
    }
  }, [user, form])

  /** 卸载时中断流式请求，避免离开页面后仍在消费事件 */
  useEffect(() => () => abortRef.current?.(), [])

  const handleGenerate = async (values) => {
    if (!patientId) return
    setRunning(true)
    setCarePlan(null)
    setAgentStates({})

    try {
      /* ① 先把表单里变化的档案字段落库（身高 / 体重 / 年龄 / 性别 / 疾病）——
            这样智能体读到的是**真实档案**，而不是只存在于页面上的临时输入。 */
      const currentDiseases = (profileRaw?.conditions || []).map((c) => c.diseaseName).sort()
      const nextDiseases = (values.diseases || []).map((d) => DISEASE_LABEL[d] || d).sort()
      const identityChanged =
        Number(values.height) !== Number(user?.height) ||
        Number(values.age) !== Number(user?.age) ||
        (GENDER_LABEL[values.gender] || values.gender) !== user?.gender
      const diseasesChanged = JSON.stringify(currentDiseases) !== JSON.stringify(nextDiseases)

      if (identityChanged || diseasesChanged) {
        setSavingProfile(true)
        const payload = {
          identity: {
            gender: values.gender,
            age: values.age,
            height: values.height,
          },
        }
        if (diseasesChanged) {
          payload.conditions = nextDiseases.map((d, i) => ({
            diseaseName: d,
            diseaseGrade: i === 0 ? profileRaw?.conditions?.[0]?.diseaseGrade || null : null,
            durationText: i === 0 ? profileRaw?.conditions?.[0]?.durationText || null : null,
            riskStratification: i === 0 ? profileRaw?.conditions?.[0]?.riskStratification || null : null,
            comorbidities: [],
          }))
        }
        try {
          await updateProfile(patientId, payload)
        } catch {
          /* 档案写入失败不阻断建议生成 */
        } finally {
          setSavingProfile(false)
        }
      }

      /* ② 六智能体协同 */
      abortRef.current = runCarePlan(
        { patientId, goal: '生成个性化健康管理建议（运动 / 饮食 / 用药与坚持策略）' },
        {
          onEvent: (e) => {
            if (e.type === 'agent_start') {
              setAgentStates((prev) => ({ ...prev, [e.agentId]: { status: 'running', thoughts: [], tools: [] } }))
            } else if (e.type === 'agent_thought') {
              setAgentStates((prev) => {
                const cur = prev[e.agentId] || { status: 'running', thoughts: [], tools: [] }
                return { ...prev, [e.agentId]: { ...cur, thoughts: [...cur.thoughts, e.text] } }
              })
            } else if (e.type === 'tool_call') {
              setAgentStates((prev) => {
                const cur = prev[e.agentId] || { status: 'running', thoughts: [], tools: [] }
                return { ...prev, [e.agentId]: { ...cur, tools: [...cur.tools, `${e.name} → ${e.result ?? ''}`] } }
              })
            } else if (e.type === 'agent_result') {
              setAgentStates((prev) => ({
                ...prev,
                [e.agentId]: { ...(prev[e.agentId] || { thoughts: [], tools: [] }), status: 'done', result: e.data, degraded: e.degraded },
              }))
            } else if (e.type === 'agent_done') {
              setAgentStates((prev) => ({
                ...prev,
                [e.agentId]: { ...(prev[e.agentId] || { thoughts: [], tools: [] }), status: 'done' },
              }))
            } else if (e.type === 'run_done') {
              setCarePlan(e.carePlan || null)
            } else if (e.type === 'error') {
              // 错误交给 onError/onClose 收敛，这里只记录
              console.warn('care-plan error:', e.message)
            }
          },
          onError: () => {
            setRunning(false)
          },
          onClose: () => {
            setRunning(false)
          },
        }
      )
    } catch {
      setRunning(false)
    }
  }

  /** 已有健康建议（历史处方）——保留展示，避免用户以为记录丢了 */
  const legacy = getActivePrescriptions()

  const renderAgentPanel = () => (
    <Card
      title={
        <Space>
          <ExperimentOutlined style={{ color: '#6366f1' }} />
          <span>六智能体协同过程</span>
          {running && <Badge status="processing" text="协同中" />}
        </Space>
      }
      extra={
        <Text type="secondary" style={{ fontSize: 12.5 }}>
          体征盘点 → 用药解读 → 风险与禁忌 → 个性化方案 → 坚持策略 → 汇总成文
        </Text>
      }
      style={{ borderRadius: 12, marginBottom: 24 }}
    >
      {CARE_ORDER.map((id) => {
        const meta = agentMeta(id)
        const st = agentStates[id] || {}
        const state = st.status || 'idle'
        return (
          <AgentRow key={id} $state={state}>
            <div className="head">
              <span style={{ fontSize: 18 }}>{meta.icon}</span>
              <Text strong style={{ fontSize: 15 }}>
                {meta.name}
              </Text>
              <Tag color="blue">{meta.role}</Tag>
              {state === 'running' && <Badge status="processing" text="推理中" />}
              {state === 'done' && (
                <Tag icon={<CheckCircleOutlined />} color="success">
                  已完成{st.degraded ? '（本地推理引擎）' : ''}
                </Tag>
              )}
              {state === 'idle' && (
                <Tag icon={<ClockCircleOutlined />} color="default">
                  等待
                </Tag>
              )}
            </div>
            <div className="body">
              {st.tools?.length ? (
                <div>
                  <span className="k">工具调用：</span>
                  {st.tools.join('；')}
                </div>
              ) : null}
              {st.thoughts?.length ? (
                <div>
                  <span className="k">推理：</span>
                  {st.thoughts.slice(-2).map(thoughtText).join(' / ')}
                </div>
              ) : null}
              {state === 'done' && (
                <div>
                  <span className="k">产出：</span>
                  {summarizeResult(id, st.result) || '已产出'}
                </div>
              )}
            </div>
          </AgentRow>
        )
      })}
    </Card>
  )

  const renderCarePlan = () => {
    if (!carePlan) return null
    const plan = carePlan.plan || {}
    const vision = carePlan.medication || {}
    const companion = carePlan.companion || {}
    return (
      <PrescriptionCard title="您的个性化健康建议（六智能体协同产出）">
        <div style={{ marginBottom: 16 }}>
          <Space wrap>
            <StatusTag color="green">
              <CheckCircleOutlined /> 本次由 6 个智能体协同生成
            </StatusTag>
            {carePlan.riskLevel && (
              <StatusTag color={carePlan.riskLevel === '紧急' ? 'red' : carePlan.riskLevel === '预警' ? 'orange' : 'blue'}>
                产品预警等级：{carePlan.riskLevel}
              </StatusTag>
            )}
            <Text type="secondary">{new Date().toLocaleString('zh-CN')}</Text>
          </Space>
        </div>

        <Alert
          type="info"
          showIcon
          style={{ borderRadius: 10, marginBottom: 18 }}
          message={<span style={{ fontSize: 16, fontWeight: 700 }}>{carePlan.headline || '健康管理建议'}</span>}
          description={<span style={{ lineHeight: 1.9 }}>{carePlan.summary}</span>}
        />

        {/* 汇总要点（健康管家智能体） */}
        {carePlan.keyPoints?.length ? (
          <PrescriptionSection>
            <div className="section-header">
              <ThunderboltOutlined className="section-icon" />
              <Title level={4} className="section-title">
                今天可以做的事
              </Title>
            </div>
            <div className="prescription-content">
              {carePlan.keyPoints.map((k, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <Space align="start">
                    <Tag color="purple">{k.area}</Tag>
                    <div>
                      <Text strong>{k.advice}</Text>
                      {k.why ? (
                        <>
                          <br />
                          <Text type="secondary" style={{ fontSize: 12.5 }}>
                            {k.why}
                          </Text>
                        </>
                      ) : null}
                    </div>
                  </Space>
                </div>
              ))}
            </div>
          </PrescriptionSection>
        ) : null}

        {/* 运动（方案规划智能体） */}
        {plan.exercise ? (
          <PrescriptionSection>
            <div className="section-header">
              <ThunderboltOutlined className="section-icon" />
              <Title level={4} className="section-title">
                运动建议
              </Title>
              <Text type="secondary" style={{ fontSize: 12.5 }}>
                来自方案规划智能体
              </Text>
            </div>
            <div className="prescription-content">
              <Text strong>{plan.exercise.type || '—'}</Text>
              <br />
              <Text>
                {plan.exercise.duration ? `${plan.exercise.duration} 分钟` : ''} | {plan.exercise.frequency || ''}
              </Text>
              {plan.exercise.intensity ? (
                <>
                  <br />
                  <Text type="secondary">强度：{plan.exercise.intensity}</Text>
                </>
              ) : null}
              {plan.exercise.note ? (
                <>
                  <br />
                  <Text type="secondary">执行要点：{plan.exercise.note}</Text>
                </>
              ) : null}
            </div>
          </PrescriptionSection>
        ) : null}

        {/* 运动与生活禁忌（风险预警智能体） */}
        {carePlan.restrictions?.length ? (
          <PrescriptionSection>
            <div className="section-header">
              <MedicineBoxOutlined className="section-icon" style={{ color: '#ef4444' }} />
              <Title level={4} className="section-title">
                当前状态下不宜做的事
              </Title>
              <Text type="secondary" style={{ fontSize: 12.5 }}>
                来自风险预警智能体
              </Text>
            </div>
            <div className="prescription-content" style={{ borderLeftColor: '#ef4444' }}>
              {carePlan.restrictions.map((r, i) => (
                <div key={i}>· {typeof r === 'string' ? r : r.title || JSON.stringify(r)}</div>
              ))}
            </div>
          </PrescriptionSection>
        ) : null}

        {/* 饮食（方案规划智能体） */}
        {plan.diet && (plan.diet.restrictions?.length || plan.diet.recommendations?.length) ? (
          <PrescriptionSection>
            <div className="section-header">
              <AppleOutlined className="section-icon" />
              <Title level={4} className="section-title">
                饮食建议
              </Title>
              <Text type="secondary" style={{ fontSize: 12.5 }}>
                来自方案规划智能体
              </Text>
            </div>
            <div className="prescription-content">
              {[...(plan.diet.restrictions || []).map((r) => ({ kind: '限制', text: r })), ...(plan.diet.recommendations || []).map((r) => ({ kind: '建议', text: r }))].map(
                (it, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <Tag color={it.kind === '限制' ? 'red' : 'green'}>{it.kind}</Tag>
                    {it.text}
                  </div>
                )
              )}
              {plan.personalization?.length ? (
                <>
                  <Divider style={{ margin: '12px 0' }} plain>
                    <Text type="secondary" style={{ fontSize: 12.5 }}>
                      结合您的生活画像
                    </Text>
                  </Divider>
                  {plan.personalization.map((p, i) => (
                    <div key={i} style={{ marginBottom: 6 }}>
                      · {typeof p === 'string' ? p : p.text || JSON.stringify(p)}
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          </PrescriptionSection>
        ) : null}

        {/* 用药（多模态识别智能体） */}
        <PrescriptionSection>
          <div className="section-header">
            <MedicineBoxOutlined className="section-icon" />
            <Title level={4} className="section-title">
              用药提醒
            </Title>
            <Text type="secondary" style={{ fontSize: 12.5 }}>
              来自多模态识别智能体
            </Text>
          </div>
          <div className="prescription-content">
            {vision.summary ? (
              <Text type="secondary" style={{ display: 'block', marginBottom: 10 }}>
                {vision.summary}
              </Text>
            ) : null}
            {(vision.medications || []).length ? (
              (vision.medications || []).map((m, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <Text strong>{m.name}</Text>
                  <br />
                  <Text>{m.purpose}</Text>
                  {m.caution ? (
                    <>
                      <br />
                      <Text type="secondary">{m.caution}</Text>
                    </>
                  ) : null}
                </div>
              ))
            ) : (
              <Text type="secondary">档案中暂无用药记录，建议在「我的 → 我的健康档案」中补充。</Text>
            )}
            {(vision.warnings || []).length ? (
              <>
                <Divider style={{ margin: '12px 0' }} plain>
                  <Text type="secondary" style={{ fontSize: 12.5 }}>
                    需要留意
                  </Text>
                </Divider>
                {vision.warnings.map((w, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    · {typeof w === 'string' ? w : JSON.stringify(w)}
                  </div>
                ))}
              </>
            ) : null}
            {vision.disclaimer ? (
              <Alert type="warning" showIcon style={{ marginTop: 10, borderRadius: 8 }} message={vision.disclaimer} />
            ) : null}
          </div>
        </PrescriptionSection>

        {/* 坚持策略（情感陪伴智能体） */}
        {companion.message ? (
          <PrescriptionSection>
            <div className="section-header">
              <HeartOutlined className="section-icon" style={{ color: '#f59e0b' }} />
              <Title level={4} className="section-title">
                怎么坚持下去
              </Title>
              <Text type="secondary" style={{ fontSize: 12.5 }}>
                来自情感陪伴智能体
              </Text>
            </div>
            <div className="prescription-content" style={{ borderLeftColor: '#f59e0b' }}>
              <Paragraph style={{ marginBottom: 8 }}>{companion.message}</Paragraph>
              {companion.habitTip ? (
                <div style={{ marginBottom: 6 }}>
                  <Tag color="gold">最容易做到</Tag>
                  {companion.habitTip}
                </div>
              ) : null}
              {companion.whenTired ? (
                <div>
                  <Tag color="default">做不到时的退路</Tag>
                  {companion.whenTired}
                </div>
              ) : null}
            </div>
          </PrescriptionSection>
        ) : null}

        <Alert
          type="warning"
          showIcon
          style={{ borderRadius: 10 }}
          message={carePlan.disclaimer || '本建议不能替代医生诊断，用药调整请遵医嘱。'}
        />
      </PrescriptionCard>
    )
  }

  return (
    <PageContainer>
      <Title level={2}>
        <HeartOutlined style={{ color: '#6366f1', marginRight: 8 }} />
        个性化健康建议
      </Title>
      <Paragraph type="secondary" style={{ fontSize: 16 }}>
        由<b>六个智能体协同</b>生成：体征分析 → 多模态识别 → 风险预警 → 方案规划 → 情感陪伴 → 健康管家汇总。
        达标率与预警等级由项目内确定性规则计算，智能体只负责解释与建议。
      </Paragraph>

      <FormCard title="基本信息（会写入您的健康档案）" size="small">
        <Form form={form} layout="vertical" onFinish={handleGenerate} size="large">
          <Form.Item
            label="身高 (cm)"
            name="height"
            rules={[
              { required: true, message: '请输入身高' },
              { type: 'number', min: 100, max: 250, message: '请输入有效身高' },
            ]}
          >
            <InputNumber style={{ width: '100%' }} placeholder="请输入身高" min={100} max={250} />
          </Form.Item>

          <Form.Item
            label="年龄"
            name="age"
            rules={[
              { required: true, message: '请输入年龄' },
              { type: 'number', min: 18, max: 120, message: '请输入有效年龄' },
            ]}
          >
            <InputNumber style={{ width: '100%' }} placeholder="请输入年龄" min={18} max={120} />
          </Form.Item>

          <Form.Item label="性别" name="gender" rules={[{ required: true, message: '请选择性别' }]}>
            <Radio.Group>
              <Radio value="male">男</Radio>
              <Radio value="female">女</Radio>
            </Radio.Group>
          </Form.Item>

          <Form.Item
            label="慢性疾病"
            name="diseases"
            rules={[{ required: true, message: '请选择您的慢性疾病' }]}
            extra="修改疾病谱会同步写入健康档案，并影响智能体的方案要点。"
          >
            <Select
              mode="multiple"
              placeholder="请选择您的慢性疾病"
              allowClear
              options={[
                { value: 'hypertension', label: '高血压' },
                { value: 'diabetes', label: '糖尿病' },
                { value: 'obesity', label: '肥胖症' },
                { value: 'hyperlipidemia', label: '高血脂' },
                { value: 'coronary_heart_disease', label: '冠心病' },
              ]}
            />
          </Form.Item>

          <Form.Item>
            <Space size="middle" style={{ width: '100%' }} wrap>
              <ActionButton
                type="primary"
                htmlType="submit"
                loading={running || savingProfile}
                className="primary"
                icon={<ThunderboltOutlined />}
              >
                生成健康建议（六智能体协同）
              </ActionButton>
              {carePlan && (
                <ActionButton icon={<ReloadOutlined />} onClick={() => form.submit()} loading={running}>
                  重新生成
                </ActionButton>
              )}
            </Space>
          </Form.Item>
        </Form>
      </FormCard>

      {running || Object.keys(agentStates).length > 0 ? renderAgentPanel() : null}

      {running && !carePlan ? (
        <Card style={{ borderRadius: 12, marginBottom: 24, textAlign: 'center' }}>
          <Spin indicator={<LoadingOutlined style={{ fontSize: 26 }} spin />} />
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">六个智能体正在协同，通常需要十几秒…</Text>
          </div>
        </Card>
      ) : null}

      {renderCarePlan()}

      {!carePlan && !running ? (
        <PrescriptionCard title="您的健康建议">
          <Empty
            description={
              <span>
                还没有生成建议。填好上面的基本信息后，点「生成健康建议」，
                <br />
                六个智能体将协同产出一份基于您真实档案与记录的建议。
              </span>
            }
          />
          {legacy.length ? (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12, borderRadius: 8 }}
              message={`历史记录中有 ${legacy.length} 条更早的健康建议（生成于 ${new Date(
                legacy[0].createdAt || Date.now()
              ).toLocaleDateString('zh-CN')}）`}
            />
          ) : null}
        </PrescriptionCard>
      ) : null}
    </PageContainer>
  )
}

export default PrescriptionPage
