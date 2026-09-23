import React, { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Table,
  Button,
  Input,
  Select,
  Space,
  Typography,
  Row,
  Col,
  Statistic,
  Alert,
  Modal,
  Form,
  message,
  Tag,
  Tabs,
  Timeline,
  Avatar,
  Divider
} from 'antd'
import {
  UserOutlined,
  SearchOutlined,
  EyeOutlined,
  EditOutlined,
  AlertOutlined,
  BarChartOutlined,
  TeamOutlined,
  SafetyOutlined,
  MedicineBoxOutlined,
  HeartOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ExperimentOutlined,
  StepForwardOutlined,
  ScheduleOutlined
} from '@ant-design/icons'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import styled from 'styled-components'
import { getDoctorPatients } from '../services/patientApi'
import { addDoctorNote, getPatientDoctorNotes } from '../services/doctorApi'
import TaskOverrideDrawer from '../components/Doctor/TaskOverrideDrawer'
import ProposalReviewList from '../components/Doctor/ProposalReviewList'
import { ALERT_LEVEL } from '../utils/clinicalRules'
import { hasHypertension, hasDiabetes, hasDisease, DISEASE_KEYWORD } from '../utils/disease'

const { Title, Text, Paragraph } = Typography
const { Option } = Select
const { TextArea } = Input

const PageContainer = styled.div`
  padding: 24px;
  max-width: 1400px;
  margin: 0 auto;
  
  @media (max-width: 768px) {
    padding: 16px;
  }
`

const StatsCard = styled(Card)`
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  text-align: center;
  
  .ant-statistic-title {
    color: #64748b;
  }
  
  .ant-statistic-content {
    color: #1e293b;
  }
`

const PatientCard = styled(Card)`
  border-radius: 12px;
  margin-bottom: 16px;
  cursor: pointer;
  transition: all 0.3s ease;
  
  &:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    transform: translateY(-2px);
  }
  
  .patient-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  
  .patient-info {
    flex: 1;
  }
  
  .patient-status {
    display: flex;
    gap: 8px;
  }
  
  .health-indicators {
    display: flex;
    gap: 16px;
    margin-top: 12px;
  }
  
  .indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 14px;
  }
`

const AlertCard = styled(Card)`
  border-radius: 12px;
  border-left: 4px solid #ef4444;
  margin-bottom: 16px;
  
  &.warning {
    border-left-color: #f59e0b;
  }
  
  &.info {
    border-left-color: #3b82f6;
  }
`

/** 医生端固定身份（v2 设定书：医生姓名一律取固定值，不得读取患者 user.name） */
const DOCTOR = Object.freeze({
  name: '李医生',
  title: '主任医师',
  department: '全科',
  display: '李医生｜主任医师·全科',
})

/** 医生账号 id：医生端患者列表经 doctor_patient_relations 从数据库查询 */
const DOCTOR_ID = 'doc_li'

/** 产品预警等级 → 展示色（提示 / 关注 / 预警 / 紧急） */
const LEVEL_COLOR = { 提示: 'blue', 关注: 'gold', 预警: 'orange', 紧急: 'red' }

const todayKey = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 控制状态摘要（医学控制指标，与产品预警等级分开表述） */
const controlSummary = (patient) => {
  const s = patient.evaluation?.stats || {}
  const diseases = patient.diseases || []
  if (hasHypertension(diseases) && s.bloodPressure) {
    return `血压达标率 ${s.bloodPressure.complianceRate}%（${s.bloodPressure.compliantDays}/${s.bloodPressure.totalDays} 天）`
  }
  if (hasDiabetes(diseases) && s.bloodSugar) {
    return `空腹血糖达标率 ${s.bloodSugar.complianceRate}%（演示判定阈值 ${s.bloodSugar.threshold} mmol/L）`
  }
  if (s.weightBehavior) {
    return `7 天体重净变化 ${s.weightBehavior.netChange} kg（含水分与测量波动）`
  }
  return '—'
}

const DoctorPage = () => {
  const [activeTab, setActiveTab] = useState('patients')
  const [selectedPatient, setSelectedPatient] = useState(null)
  const [patientModalVisible, setPatientModalVisible] = useState(false)
  const [noteModalVisible, setNoteModalVisible] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [form] = Form.useForm()

  // 患者列表：经 doctor_patient_relations 从数据库查询（/api/doctors/:id/patients），
  // 不再硬编码患者名单，也不读 demoPatients.js。
  const [patients, setPatients] = useState([])
  const [loadingPatients, setLoadingPatients] = useState(true)
  /** 审结提案后自增 → 触发患者列表（含 pendingProposalCount 角标）重新拉取 */
  const [reloadPatientsToken, setReloadPatientsToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoadingPatients(true)
    getDoctorPatients(DOCTOR_ID)
      .then((res) => {
        if (!cancelled) setPatients(res.patients || [])
      })
      .catch((e) => {
        if (!cancelled) {
          setPatients([])
          message.error(`患者数据加载失败：${e.message}`)
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPatients(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadPatientsToken])

  /**
   * 医生建议（Step 11 · Phase 1 · D8）
   * ------------------------------------------------------------------
   * 此前这里是 `useState([两条写死的假数据])` —— 提示「添加成功」但刷新即丢，
   * doctor_notes 表 0 行。现改为**真落库**并按患者按需读取：
   *   写 → POST /api/doctors/:doctorId/patients/:patientId/notes
   *   读 → GET  /api/patients/:patientId/doctor-notes
   */
  const [notesByPatient, setNotesByPatient] = useState({})
  const [taskDrawerVisible, setTaskDrawerVisible] = useState(false)

  const loadNotes = useCallback(async (patientId) => {
    if (!patientId) return
    try {
      const res = await getPatientDoctorNotes(patientId, { limit: 50 })
      setNotesByPatient((prev) => ({ ...prev, [patientId]: res.notes || [] }))
    } catch (e) {
      message.error(`医生建议加载失败：${e.message}`)
    }
  }, [])

  const doctorNotes = Object.values(notesByPatient).flat()

  const getStatusColor = (status) => {
    const colors = {
      good: 'green',
      normal: 'blue',
      attention: 'orange',
      danger: 'red'
    }
    return colors[status] || 'default'
  }

  // 患者卡片/列表的状态标签统一使用产品预警词表（提示 / 关注 / 预警 / 紧急），
  // 不使用「高危 / 危险」等判定用语；医生侧医学结论另在档案口径卡片中单独呈现。
  const getStatusText = (status) => {
    const texts = {
      good: '良好',
      normal: '提示',
      attention: '预警',
      danger: '紧急',
    }
    return texts[status] || '未知'
  }

  // 病名统一使用中文规范病名（「原发性高血压」「2 型糖尿病」「肥胖症」），
  // 此处仅保留历史英文键的映射以兼容旧数据。
  const getDiseaseText = (disease) => {
    const legacyTexts = {
      hypertension: '高血压',
      diabetes: '糖尿病',
      obesity: '肥胖症',
      hyperlipidemia: '高血脂'
    }
    return legacyTexts[disease] || disease
  }

  const filteredPatients = patients.filter(patient => {
    const matchesSearch = patient.name.toLowerCase().includes(searchText.toLowerCase())
    const matchesFilter = filterStatus === 'all' || patient.status === filterStatus
    return matchesSearch && matchesFilter
  })

  /** 落库预警总数（优先 alertRecords，回落规则派生视图） */
  const alertTotal = patients.reduce(
    (n, p) => n + (Array.isArray(p.alertRecords) && p.alertRecords.length ? p.alertRecords.length : (p.alerts || []).length),
    0
  )

  /**
   * 待审核任务调整申请总数（Step 11 · Phase 2）
   * ----------------------------------------------------------------
   * 来源是后端 `countPendingProposals()` 聚合出的 `pendingProposalCount`；
   * 前端**不自行统计**提案，避免与后端口径漂移。
   */
  const pendingProposalTotal = patients.reduce((n, p) => n + (Number(p.pendingProposalCount) || 0), 0)

  const handleViewPatient = (patient) => {
    setSelectedPatient(patient)
    setPatientModalVisible(true)
    loadNotes(patient.id)
  }

  const handleAddNote = (patient) => {
    setSelectedPatient(patient)
    setNoteModalVisible(true)
  }

  /** 打开「今日任务」调整抽屉（规则生成 + 医生覆盖层） */
  const handleOpenTasks = (patient) => {
    setSelectedPatient(patient)
    setTaskDrawerVisible(true)
  }

  const handleSaveNote = async (values) => {
    if (!selectedPatient?.id) return
    try {
      await addDoctorNote(DOCTOR_ID, selectedPatient.id, {
        content: values.content,
        noteType: '建议',
        priority: '中',
      })
      await loadNotes(selectedPatient.id)
      message.success('医生建议已保存（已落库，患者端可见）')
      setNoteModalVisible(false)
      form.resetFields()
    } catch (error) {
      message.error(`保存失败：${error.message}`)
    }
  }

  const renderOverviewStats = () => (
    <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="管理患者"
            value={patients.length}
            prefix={<TeamOutlined style={{ color: '#6366f1' }} />}
            suffix="人"
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="需关注"
            value={patients.filter(p => p.status === 'attention' || p.status === 'danger').length}
            prefix={<AlertOutlined style={{ color: '#ef4444' }} />}
            suffix="人"
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="今日记录"
            value={patients.filter(p => p.lastRecord === todayKey()).length}
            prefix={<CheckCircleOutlined style={{ color: '#22c55e' }} />}
            suffix="人"
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="医生备注"
            value={doctorNotes.length}
            prefix={<EditOutlined style={{ color: '#8b5cf6' }} />}
            suffix="条"
          />
        </StatsCard>
      </Col>
    </Row>
  )

  const renderPatientList = () => (
    <div>
      {/* 隐私授权说明：本列表**只包含患者已同意授权**的账号。
          可见性唯一取决于 doctor_patient_relations.is_active = 1 ——
          注册时只建立关联（is_active = 0），患者在「我的 → 我的医疗团队」点「同意」后才为 1。
          患者随时可撤回，撤回后此处立即不再显示该患者。 */}
      <Alert
        type="info"
        showIcon
        icon={<SafetyOutlined />}
        style={{ marginBottom: 16, borderRadius: 12 }}
        message="仅显示已授权患者"
        description="只有当患者本人在「我的医疗团队」中点击「同意」后，其档案才会出现在这里；患者随时可以停止授权，停止后本列表立即不再显示该患者。"
      />
      {loadingPatients && patients.length === 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16, borderRadius: 10 }}
          message="正在从数据库加载患者列表…"
        />
      )}
      <div style={{ marginBottom: 16 }}>
        <Space size="middle">
          <Input
            placeholder="搜索患者姓名"
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 200 }}
          />
          <Select
            value={filterStatus}
            onChange={setFilterStatus}
            style={{ width: 120 }}
          >
            <Option value="all">全部状态</Option>
            <Option value="good">良好</Option>
            <Option value="normal">提示</Option>
            <Option value="attention">预警</Option>
            <Option value="danger">紧急</Option>
          </Select>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        {filteredPatients.map(patient => (
          <Col xs={24} sm={12} lg={8} key={patient.id}>
            <PatientCard>
              <div className="patient-header">
                <Avatar size={48} icon={<UserOutlined />} />
                <div className="patient-info">
                  <Text strong style={{ fontSize: 16 }}>{patient.name}</Text>
                  <br />
                  <Text type="secondary">{patient.age}岁 | {patient.gender === 'male' ? '男' : '女'}</Text>
                </div>
                <div className="patient-status">
                  <Tag color={getStatusColor(patient.status)}>
                    {getStatusText(patient.status)}
                  </Tag>
                </div>
              </div>

              <div>
                <Text type="secondary">疾病：</Text>
                <Space wrap>
                  {patient.diseases.map(disease => (
                    <Tag key={disease} color="blue">
                      {getDiseaseText(disease)}
                    </Tag>
                  ))}
                </Space>
              </div>

              <div className="health-indicators">
                <div className="indicator">
                  <HeartOutlined style={{ color: '#ef4444' }} />
                  <Text>{patient.recentData.bloodPressure.systolic}/{patient.recentData.bloodPressure.diastolic}</Text>
                </div>
                <div className="indicator">
                  <ExperimentOutlined style={{ color: '#f59e0b' }} />
                  <Text>{patient.recentData.bloodSugar}</Text>
                </div>
                <div className="indicator">
                  <StepForwardOutlined style={{ color: '#22c55e' }} />
                  <Text>{patient.recentData.steps}</Text>
                </div>
              </div>

              <Divider style={{ margin: '12px 0' }} />

              <Space wrap>
                <Button
                  type="primary"
                  icon={<EyeOutlined />}
                  onClick={() => handleViewPatient(patient)}
                >
                  查看详情
                </Button>
                <Button
                  icon={<ScheduleOutlined />}
                  onClick={() => handleOpenTasks(patient)}
                >
                  今日任务
                </Button>
                <Button
                  icon={<EditOutlined />}
                  onClick={() => handleAddNote(patient)}
                >
                  添加备注
                </Button>
              </Space>
            </PatientCard>
          </Col>
        ))}
      </Row>
    </div>
  )

  /**
   * 健康预警。
   * 优先展示后端 alerts 表的**落库记录**（Step 5：确定性规则命中后由智能体运行落库）；
   * 若尚无落库记录，则回落到规则派生视图（evaluation.matched），保证页面不空白。
   */
  const renderAlerts = () => {
    const rows = patients.flatMap((patient) => {
      const persisted = Array.isArray(patient.alertRecords) ? patient.alertRecords : []
      if (persisted.length) {
        return persisted.map((a) => ({
          key: `${patient.id}_${a.alertId}`,
          patientName: patient.name,
          level: a.level,
          ruleId: a.ruleId,
          title: a.title,
          detail: a.detail,
          action: a.action,
          createdAt: a.createdAt,
          persisted: true,
        }))
      }
      return (patient.alerts || []).map((a, i) => ({
        key: `${patient.id}_fallback_${i}`,
        patientName: patient.name,
        legacyType: a.type,
        detail: a.message,
        persisted: false,
      }))
    })

    if (!rows.length) {
      return (
        <Alert
          type="info"
          showIcon
          style={{ borderRadius: 10 }}
          message="暂无落库预警"
          description="预警会在智能体协同运行后，由确定性规则引擎判定并落库（患者端「一键启动多智能体协同」）。"
        />
      )
    }

    return (
      <div>
        <Text type="secondary" style={{ fontSize: 13 }}>
          数据来源：alerts 表（确定性规则引擎判定后落库；AI 只做表达，不参与阈值 / 等级判定）
        </Text>
        <div style={{ marginTop: 12 }}>
          {rows.map((alert) => {
            const cls = alert.persisted
              ? alert.level === '紧急'
                ? ''
                : alert.level === '预警'
                  ? 'warning'
                  : 'info'
              : alert.legacyType
            const iconColor = alert.persisted
              ? alert.level === '紧急'
                ? '#ef4444'
                : alert.level === '预警'
                  ? '#f59e0b'
                  : '#3b82f6'
              : alert.legacyType === 'danger'
                ? '#ef4444'
                : alert.legacyType === 'warning'
                  ? '#f59e0b'
                  : '#3b82f6'
            return (
              <AlertCard key={alert.key} className={cls}>
                <Space align="start">
                  <ExclamationCircleOutlined style={{ color: iconColor, marginTop: 3 }} />
                  <div>
                    <Space size={8} wrap>
                      <Text strong>{alert.patientName}</Text>
                      {alert.persisted && alert.level && (
                        <Tag color={LEVEL_COLOR[alert.level] || 'default'} style={{ fontWeight: 700 }}>
                          {alert.level}
                        </Tag>
                      )}
                      {alert.ruleId && <Tag>{alert.ruleId}</Tag>}
                      {alert.title && <Text strong>{alert.title}</Text>}
                    </Space>
                    <div>
                      <Text>{alert.detail}</Text>
                    </div>
                    {alert.action && (
                      <div>
                        <Text type="secondary">建议：{alert.action}</Text>
                      </div>
                    )}
                    {alert.persisted && alert.createdAt && (
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          落库时间：{alert.createdAt}
                        </Text>
                      </div>
                    )}
                  </div>
                </Space>
              </AlertCard>
            )
          })}
        </div>
      </div>
    )
  }

  const renderAnalytics = () => (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card title="患者状态分布" style={{ borderRadius: 12 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Statistic
                title="良好"
                value={patients.filter(p => p.status === 'good').length}
                valueStyle={{ color: '#22c55e' }}
              />
            </Col>
            <Col span={12}>
              <Statistic
                title="提示"
                value={patients.filter(p => p.status === 'normal').length}
                valueStyle={{ color: '#3b82f6' }}
              />
            </Col>
            <Col span={12}>
              <Statistic
                title="预警"
                value={patients.filter(p => p.status === 'attention').length}
                valueStyle={{ color: '#f59e0b' }}
              />
            </Col>
            <Col span={12}>
              <Statistic
                title="紧急"
                value={patients.filter(p => p.status === 'danger').length}
                valueStyle={{ color: '#ef4444' }}
              />
            </Col>
          </Row>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card title="疾病类型分布" style={{ borderRadius: 12 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Statistic
                title="高血压"
                value={patients.filter(p => hasHypertension(p.diseases)).length}
                suffix="人"
              />
            </Col>
            <Col span={12}>
              <Statistic
                title="糖尿病"
                value={patients.filter(p => hasDiabetes(p.diseases)).length}
                suffix="人"
              />
            </Col>
            <Col span={12}>
              <Statistic
                title="肥胖症"
                value={patients.filter(p => hasDisease(p.diseases, DISEASE_KEYWORD.obesity)).length}
                suffix="人"
              />
            </Col>
            <Col span={12}>
              <Statistic
                title="血脂异常"
                value={patients.filter(p => hasDisease(p.diseases, DISEASE_KEYWORD.dyslipidemia)).length}
                suffix="人"
              />
            </Col>
          </Row>
        </Card>
      </Col>
    </Row>
  )

  return (
    <PageContainer>
      <Title level={2}>
        <MedicineBoxOutlined style={{ color: '#6366f1', marginRight: 8 }} />
        医生工作台
      </Title>
      <Paragraph type="secondary" style={{ fontSize: 16 }}>
        患者健康数据管理与分析平台
      </Paragraph>

      <Paragraph style={{ marginTop: -8 }}>
        <Tag color="geekblue">{DOCTOR.display}</Tag>
        <Text type="secondary">患者 → 健康数据 → AI 辅助分析 → 医生查看 / 复核 → 健康管理</Text>
      </Paragraph>

      {renderOverviewStats()}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        size="large"
        items={[
          { key: 'patients', label: '患者管理', children: renderPatientList() },
          {
            key: 'alerts',
            label: `健康预警${alertTotal ? ` (${alertTotal})` : ''}`,
            children: renderAlerts(),
          },
          { key: 'analytics', label: '数据分析', children: renderAnalytics() },
          {
            // Step 11 · Phase 2：患者对话产出的任务调整申请（审核前患者端任务零变化）
            key: 'proposals',
            label: `待审核${pendingProposalTotal ? ` (${pendingProposalTotal})` : ''}`,
            children: (
              <ProposalReviewList
                doctorId={DOCTOR_ID}
                patients={patients}
                onChanged={() => setReloadPatientsToken((n) => n + 1)}
              />
            ),
          },
        ]}
      />

      {/* 患者详情模态框 */}
      <Modal
        title={`患者详情 - ${selectedPatient?.name}`}
        open={patientModalVisible}
        onCancel={() => setPatientModalVisible(false)}
        footer={null}
        width={800}
      >
        {selectedPatient && (
          <div>
            <Row gutter={16}>
              <Col span={12}>
                <Card title="基本信息" size="small">
                  <p><strong>姓名：</strong>{selectedPatient.name}</p>
                  <p><strong>年龄：</strong>{selectedPatient.age}岁</p>
                  <p><strong>性别：</strong>{selectedPatient.gender === 'male' ? '男' : '女'}</p>
                  <p><strong>联系电话：</strong>{selectedPatient.phone}</p>
                  <p><strong>紧急联系人：</strong>{selectedPatient.emergencyContact}</p>
                </Card>
              </Col>
              <Col span={12}>
                <Card title="最新数据" size="small">
                  <p><strong>血压：</strong>{selectedPatient.recentData.bloodPressure.systolic}/{selectedPatient.recentData.bloodPressure.diastolic} mmHg</p>
                  <p><strong>血糖：</strong>{selectedPatient.recentData.bloodSugar} mmol/L</p>
                  <p><strong>体重：</strong>{selectedPatient.recentData.weight} kg</p>
                  <p><strong>步数：</strong>{selectedPatient.recentData.steps} 步</p>
                  <p><strong>最后记录：</strong>{selectedPatient.lastRecord}</p>
                </Card>
              </Col>
            </Row>

            <Card title="档案口径（医学诊断与产品预警分离）" style={{ marginTop: 16 }} size="small">
              <Row gutter={16}>
                <Col span={6}>
                  <Text type="secondary">疾病诊断（医生给出）</Text>
                  <div>
                    <Text strong>
                      {selectedPatient.medical.primaryDisease}
                      {selectedPatient.medical.diseaseGrade
                        ? `（${selectedPatient.medical.diseaseGrade}）`
                        : ''}
                    </Text>
                  </div>
                </Col>
                <Col span={6}>
                  <Text type="secondary">心血管危险分层（医生给出）</Text>
                  <div>
                    <Text strong>{selectedPatient.medical.riskStratification}</Text>
                  </div>
                </Col>
                <Col span={6}>
                  <Text type="secondary">控制状态</Text>
                  <div>
                    <Text strong>{controlSummary(selectedPatient)}</Text>
                  </div>
                </Col>
                <Col span={6}>
                  <Text type="secondary">产品预警等级（系统给出）</Text>
                  <div>
                    <Tag
                      color={
                        selectedPatient.evaluation.highestLevel === 'emergency'
                          ? 'red'
                          : selectedPatient.evaluation.highestLevel === 'alert'
                            ? 'orange'
                            : selectedPatient.evaluation.highestLevel === 'watch'
                              ? 'gold'
                              : 'blue'
                      }
                    >
                      {ALERT_LEVEL[selectedPatient.evaluation.highestLevel].label}
                    </Tag>
                  </div>
                </Col>
              </Row>
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">{selectedPatient.medical.demoThresholdNote}</Text>
              </div>
            </Card>

            <Card
              title="AI 触发规则（确定性判定，最多展示 5 条）"
              style={{ marginTop: 16 }}
              size="small"
            >
              {selectedPatient.evaluation.matched.slice(0, 5).map((rule) => (
                <div key={rule.ruleId} style={{ marginBottom: 8 }}>
                  <Tag
                    color={
                      rule.level === 'emergency'
                        ? 'red'
                        : rule.level === 'alert'
                          ? 'orange'
                          : rule.level === 'watch'
                            ? 'gold'
                            : 'blue'
                    }
                  >
                    {rule.ruleId}
                  </Tag>
                  <Text strong>{rule.name}</Text>
                  <Text type="secondary">（{rule.levelLabel}）</Text>
                  <div>
                    <Text type="secondary">{rule.basis}</Text>
                  </div>
                </div>
              ))}
            </Card>

            <Card title="生活画像（AI 个性化建议依据）" style={{ marginTop: 16 }} size="small">
              <Row gutter={16}>
                <Col span={8}>
                  <Text type="secondary">饮食习惯</Text>
                  <div>{selectedPatient.lifestyle.diet}</div>
                </Col>
                <Col span={8}>
                  <Text type="secondary">运动习惯</Text>
                  <div>{selectedPatient.lifestyle.exercise}</div>
                </Col>
                <Col span={8}>
                  <Text type="secondary">睡眠</Text>
                  <div>{selectedPatient.lifestyle.sleep}</div>
                </Col>
              </Row>
              <div style={{ marginTop: 12 }}>
                <Text type="secondary">最大困难：</Text>
                <Text>{selectedPatient.lifestyle.biggestDifficulty}</Text>
                <Text type="secondary" style={{ marginLeft: 16 }}>
                  AI 沟通风格：
                </Text>
                <Text>{selectedPatient.lifestyle.aiStyle}</Text>
              </div>
            </Card>

            <Card title="医生建议（已落库）" style={{ marginTop: 16 }} size="small">
              {(() => {
                const rows = (notesByPatient[selectedPatient.id] || []).slice()
                if (!rows.length) {
                  return (
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      暂无建议。点击患者卡片上的「添加备注」写下第一条 —— 保存后会写入 doctor_notes 表，患者端同步可见。
                    </Text>
                  )
                }
                return (
                  <Timeline
                    items={rows.map((note) => ({
                      key: note.noteId,
                      children: (
                        <div>
                          <Text>{note.content}</Text>
                          <br />
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {String(note.createdAt || '').slice(0, 16)} ·{' '}
                            {[note.doctorName, note.doctorTitle, note.doctorDepartment].filter(Boolean).join(' · ')}
                            {' · '}
                            {note.isRead ? '患者已读' : '患者未读'}
                          </Text>
                        </div>
                      ),
                    }))}
                  />
                )
              })()}
            </Card>
          </div>
        )}
      </Modal>

      {/* 添加备注模态框 */}
      <Modal
        title={`添加医生建议 - ${selectedPatient?.name}`}
        open={noteModalVisible}
        onCancel={() => setNoteModalVisible(false)}
        onOk={() => form.submit()}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} onFinish={handleSaveNote} layout="vertical">
          <Form.Item
            label="建议内容"
            name="content"
            rules={[{ required: true, message: '请输入建议内容' }]}
          >
            <TextArea
              rows={4}
              placeholder="请输入给患者的建议..."
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 今日任务调整抽屉（Step 11 · Phase 1）：规则生成 + 医生覆盖层 */}
      <TaskOverrideDrawer
        open={taskDrawerVisible}
        patient={selectedPatient}
        doctorId={DOCTOR_ID}
        onClose={() => setTaskDrawerVisible(false)}
        onSaved={() => {
          // 任务调整可能带来建议通知；刷新该患者建议列表
          if (selectedPatient?.id) loadNotes(selectedPatient.id)
        }}
      />
    </PageContainer>
  )
}

export default DoctorPage