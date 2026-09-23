import React, { useState, useEffect } from 'react'
import {
  Card,
  Button,
  Form,
  InputNumber,
  DatePicker,
  Select,
  Space,
  Typography,
  Row,
  Col,
  Statistic,
  Alert,
  message,
  Tabs,
  Timeline
} from 'antd'
import {
  PlusOutlined,
  BarChartOutlined,
  HeartOutlined,
  ExperimentOutlined,
  DashboardOutlined,
  StepForwardOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  MinusOutlined
} from '@ant-design/icons'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts'
import styled from 'styled-components'
import dayjs from 'dayjs'
import { useSearchParams } from 'react-router-dom'
import { useHealthData } from '../contexts/HealthDataContext'
import { BP_SLOT_OPTIONS, GLUCOSE_MEASURE_TYPES, SLOT_LABEL_ZH } from '../utils/dailyTasks'

const { Title, Text } = Typography
const { Option } = Select

const PageContainer = styled.div`
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
  
  @media (max-width: 768px) {
    padding: 16px;
  }
`

const StatsCard = styled(Card)`
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  margin-bottom: 16px;
  
  .ant-statistic-title {
    font-size: 14px;
    color: #64748b;
  }
  
  .ant-statistic-content {
    font-size: 24px;
    font-weight: bold;
  }
`

const ChartCard = styled(Card)`
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  margin-bottom: 24px;
  
  .chart-container {
    height: 300px;
    margin-top: 16px;
  }
`

const RecordForm = styled(Card)`
  border-radius: 12px;
  margin-bottom: 24px;
  
  .ant-form-item-label > label {
    font-size: 16px;
    font-weight: 600;
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

const TrendIcon = styled.div`
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
  color: ${props => props.trend === 'up' ? '#ef4444' : props.trend === 'down' ? '#22c55e' : '#6b7280'};
`

/**
 * 首页「今日任务」卡片点击后要定位的录入项。
 * key = URL 上的 ?focus=xxx，value = 表单字段 name（两者同名，便于对着 Form.Item 核对）。
 * 只做定位与聚焦，**不预填任何数值** —— 数值必须由用户自己录入，规则判定才成立。
 */
const FOCUS_FIELD_LABEL = {
  systolic: '收缩压 / 舒张压',
  bloodSugar: '血糖',
  weight: '体重',
  steps: '步数',
  exerciseMinutes: '运动时长',
}

const DataRecordPage = () => {
  const [form] = Form.useForm()
  const [activeTab, setActiveTab] = useState('record')
  const [selectedMetric, setSelectedMetric] = useState('bloodPressure')
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    healthRecords,
    addHealthRecord,
    appendReading,
    dailyTasks,
    getRecentHealthData,
    getDailyHealthData,
    getHealthTrends
  } = useHealthData()

  // 时段选项：**UI 显示「午后」，落库值仍是「下午」**（数据库 CHECK 枚举只有「下午」）。
  const slotOptions = BP_SLOT_OPTIONS.map((s) => ({ label: SLOT_LABEL_ZH[s] || s, value: s }))

  // 今日已测明细（来自今日任务派生视图，读的是 *_readings 事实层）
  const todayBpReadings = dailyTasks?.readings?.bloodPressure || []
  const todayBgReadings = dailyTasks?.readings?.bloodGlucose || []

  const [recentData, setRecentData] = useState([])
  const [todayData, setTodayData] = useState(null)
  const [trends, setTrends] = useState({})

  // 统一从趋势对象中取百分比变化量（正数=上升，负数=下降）
  const trendDelta = (key) => trends?.[key]?.change ?? 0

  useEffect(() => {
    // 加载最近30天数据
    const recent = getRecentHealthData(30)
    setRecentData(recent)

    // 加载今日数据
    const today = getDailyHealthData(dayjs().format('YYYY-MM-DD'))
    setTodayData(today)

    // 计算趋势
    const healthTrends = getHealthTrends()
    setTrends(healthTrends)
  }, [healthRecords, getRecentHealthData, getDailyHealthData, getHealthTrends])

  /* -------------------------------------------------------------------------
   * 今日任务卡片 → /data-record?focus=<字段名>
   * 只负责「切到数据记录页签 + 聚焦对应输入框 + 滚动到位」，**不预填数值**。
   * ------------------------------------------------------------------------- */
  const focusKey = searchParams.get('focus')

  useEffect(() => {
    if (!focusKey || !FOCUS_FIELD_LABEL[focusKey]) return
    setActiveTab('record')
    // 等页签切换与表单挂载完成后再聚焦
    const timer = setTimeout(() => {
      const instance = form.getFieldInstance(focusKey)
      if (instance && typeof instance.focus === 'function') instance.focus()
      document
        .getElementById('health-record-form')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      message.info(`请填写「${FOCUS_FIELD_LABEL[focusKey]}」`)
      // 消费掉参数：这样再次点击同一张任务卡仍会触发一次定位
      setSearchParams({}, { replace: true })
    }, 120)
    return () => clearTimeout(timer)
  }, [focusKey, form, setSearchParams])

  const handleSubmit = async (values) => {
    try {
      const date = values.date.format('YYYY-MM-DD')
      const hasBp = values.systolic || values.diastolic
      const hasBg = values.bloodSugar
      const dailyFields = {
        steps: values.steps,
        weight: values.weight,
        heartRate: values.heartRate,
        exerciseMinutes: values.exerciseMinutes,
      }
      const hasDaily = Object.values(dailyFields).some((v) => v !== undefined && v !== null && v !== '')

      // 收缩压 / 舒张压必须成对录入，且收缩压 > 舒张压（后端同样会拒收）
      if (hasBp && (!values.systolic || !values.diastolic)) {
        message.error('收缩压与舒张压需同时填写')
        return
      }
      if (values.systolic && values.diastolic && values.systolic <= values.diastolic) {
        message.error('收缩压必须大于舒张压，请核对后重新录入')
        return
      }
      if (hasBg && !values.measureType) {
        message.error('请选择血糖测量类型（空腹 / 餐后2h / 随机 / 睡前）')
        return
      }

      /* ① 血压 / 血糖 → 追加到**事实层**（一天多次测量：每次新增一条，历史永不覆盖） */
      let appended = 0
      if (hasBp) {
        await appendReading('blood_pressure', {
          date,
          systolic: values.systolic,
          diastolic: values.diastolic,
          // 未选时段时留空，后端按 measured_at 反推展示归属
          slot: values.bpSlot || undefined,
        })
        appended += 1
      }
      if (hasBg) {
        await appendReading('blood_glucose', {
          date,
          value: values.bloodSugar,
          measureType: values.measureType,
        })
        appended += 1
      }

      /* ② 步数 / 体重 / 心率 / 运动时长 → 仍走**日粒度**记录（一天一行，同日 UPSERT） */
      if (hasDaily) {
        await addHealthRecord({ date, ...dailyFields })
      }

      if (appended) {
        message.success(`本次测量已追加 ${appended} 条（同日多次测量互不覆盖）`)
      } else {
        message.success('健康数据已写入数据库')
      }
      form.resetFields()
      // 写入后由 HealthDataContext 重新从后端拉取，本页 useEffect 依赖 healthRecords 自动刷新
    } catch (error) {
      message.error(`记录失败：${error.message || '请重试'}`)
    }
  }

  const getTrendIcon = (trend) => {
    if (trend > 0) return <ArrowUpOutlined />
    if (trend < 0) return <ArrowDownOutlined />
    return <MinusOutlined />
  }

  const formatChartData = (data, metric) => {
    return data.map(item => ({
      date: dayjs(item.date).format('MM/DD'),
      value: metric === 'bloodPressure'
        ? item.bloodPressure?.systolic || 0
        : metric === 'bloodSugar'
          ? item.bloodSugar || 0
          : metric === 'weight'
            ? item.weight || 0
            : metric === 'steps'
              ? item.steps || 0
              : item.heartRate || 0
    }))
  }

  const getMetricColor = (metric) => {
    const colors = {
      bloodPressure: '#ef4444',
      bloodSugar: '#f59e0b',
      weight: '#8b5cf6',
      steps: '#22c55e',
      heartRate: '#ec4899'
    }
    return colors[metric] || '#6366f1'
  }

  const renderStatsCards = () => (
    <Row gutter={[16, 16]}>
      <Col xs={12} sm={8} md={6}>
        <StatsCard>
          <Statistic
            title="今日步数"
            value={todayData?.steps || 0}
            prefix={<StepForwardOutlined style={{ color: '#22c55e' }} />}
            suffix={
              <TrendIcon trend={trendDelta('steps') > 0 ? 'up' : trendDelta('steps') < 0 ? 'down' : 'stable'}>
                {getTrendIcon(trendDelta('steps'))}
              </TrendIcon>
            }
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={8} md={6}>
        <StatsCard>
          <Statistic
            title="血压 (mmHg)"
            value={todayData?.bloodPressure?.systolic || 0}
            prefix={<HeartOutlined style={{ color: '#ef4444' }} />}
            suffix={
              <TrendIcon trend={trends.bloodPressure > 0 ? 'up' : trends.bloodPressure < 0 ? 'down' : 'stable'}>
                {getTrendIcon(trends.bloodPressure)}
              </TrendIcon>
            }
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={8} md={6}>
        <StatsCard>
          <Statistic
            title="血糖 (mmol/L)"
            value={todayData?.bloodSugar || 0}
            precision={1}
            prefix={<ExperimentOutlined style={{ color: '#f59e0b' }} />}
            suffix={
              <TrendIcon trend={trends.bloodSugar > 0 ? 'up' : trends.bloodSugar < 0 ? 'down' : 'stable'}>
                {getTrendIcon(trends.bloodSugar)}
              </TrendIcon>
            }
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={8} md={6}>
        <StatsCard>
          <Statistic
            title="体重 (kg)"
            value={todayData?.weight || 0}
            precision={1}
            prefix={<DashboardOutlined style={{ color: '#8b5cf6' }} />}
            suffix={
              <TrendIcon trend={trendDelta('weight') > 0 ? 'up' : trendDelta('weight') < 0 ? 'down' : 'stable'}>
                {getTrendIcon(trendDelta('weight'))}
              </TrendIcon>
            }
          />
        </StatsCard>
      </Col>
    </Row>
  )

  const renderChart = () => {
    const chartData = formatChartData(recentData, selectedMetric)
    const color = getMetricColor(selectedMetric)

    return (
      <ChartCard
        title={
          <Space>
            <BarChartOutlined />
            健康趋势图
            <Select
              value={selectedMetric}
              onChange={setSelectedMetric}
              style={{ marginLeft: 16 }}
            >
              <Option value="bloodPressure">血压</Option>
              <Option value="bloodSugar">血糖</Option>
              <Option value="weight">体重</Option>
              <Option value="steps">步数</Option>
              <Option value="heartRate">心率</Option>
            </Select>
          </Space>
        }
      >
        <div className="chart-container">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="value"
                stroke={color}
                fill={color}
                fillOpacity={0.3}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
    )
  }

  const renderRecordForm = () => (
    <RecordForm title="记录健康数据" id="health-record-form">
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        size="large"
        initialValues={{
          date: dayjs()
        }}
      >
        <Form.Item
          label="记录日期"
          name="date"
          rules={[{ required: true, message: '请选择日期' }]}
        >
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>

        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item
              label="步数"
              name="steps"
            >
              <InputNumber
                style={{ width: '100%' }}
                placeholder="今日步数"
                min={0}
                max={50000}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              label="运动时长 (分钟)"
              name="exerciseMinutes"
            >
              <InputNumber
                style={{ width: '100%' }}
                placeholder="运动时长"
                min={0}
                max={300}
              />
            </Form.Item>
          </Col>
        </Row>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16, borderRadius: 8, fontSize: 12.5 }}
          message="血压 / 血糖支持一天多次测量"
          description={
            todayBpReadings.length || todayBgReadings.length
              ? `今天已追加：血压 ${todayBpReadings.length} 次、血糖 ${todayBgReadings.length} 次。每次保存都会新增一条独立记录，不会覆盖此前的测量。`
              : '同一天可以测量多次，每次保存都会新增一条独立记录（历史测量永不覆盖）；步数 / 体重 / 心率仍按天保存。'
          }
        />

        <Row gutter={16}>
          <Col xs={24} sm={8}>
            <Form.Item
              label="收缩压 (mmHg)"
              name="systolic"
            >
              <InputNumber
                style={{ width: '100%' }}
                placeholder="收缩压"
                min={60}
                max={300}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item
              label="舒张压 (mmHg)"
              name="diastolic"
            >
              <InputNumber
                style={{ width: '100%' }}
                placeholder="舒张压"
                min={30}
                max={200}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item
              label="测量时段（可选）"
              name="bpSlot"
            >
              <Select
                allowClear
                placeholder="晨起 / 上午 / 午后 / 睡前"
                options={slotOptions}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col xs={24} sm={8}>
            <Form.Item
              label="血糖 (mmol/L)"
              name="bloodSugar"
            >
              <InputNumber
                style={{ width: '100%' }}
                placeholder="血糖值"
                min={1}
                max={40}
                step={0.1}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item
              label="血糖测量类型"
              name="measureType"
              extra="空腹与餐后2h 语义不同，必须选择"
            >
              <Select
                allowClear
                placeholder="请选择测量类型"
                options={GLUCOSE_MEASURE_TYPES.map((t) => ({ label: t, value: t }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item
              label="体重 (kg)"
              name="weight"
            >
              <InputNumber
                style={{ width: '100%' }}
                placeholder="体重"
                min={30}
                max={200}
                step={0.1}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          label="心率 (次/分)"
          name="heartRate"
        >
          <InputNumber
            style={{ width: '100%' }}
            placeholder="心率"
            min={40}
            max={200}
          />
        </Form.Item>

        {todayBpReadings.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Text type="secondary" style={{ fontSize: 12.5 }}>今日血压明细（来自测量事实层）：</Text>
            <Space wrap style={{ marginLeft: 8 }}>
              {todayBpReadings.map((r) => (
                <Text key={r.readingId} style={{ fontSize: 12.5 }}>
                  {dayjs(r.measuredAt).format('HH:mm')} {r.systolic}/{r.diastolic}
                  {r.slot ? `（${SLOT_LABEL_ZH[r.slot] || r.slot}）` : ''}
                </Text>
              ))}
            </Space>
          </div>
        )}

        <Form.Item>
          <ActionButton
            type="primary"
            htmlType="submit"
            className="primary"
            icon={<PlusOutlined />}
            block
          >
            保存健康数据
          </ActionButton>
        </Form.Item>
      </Form>
    </RecordForm>
  )

  const renderRecentRecords = () => (
    <Card title="最近记录" style={{ borderRadius: 12 }}>
      <Timeline
        items={recentData.slice(0, 10).map((record, index) => ({
          key: index,
          children: (
            <div>
              <Text strong>{dayjs(record.date).format('YYYY年MM月DD日')}</Text>
              <br />
              <Space wrap>
                {record.steps > 0 && <Text>步数: {record.steps}</Text>}
                {record.bloodPressure?.systolic > 0 && (
                  <Text>血压: {record.bloodPressure.systolic}/{record.bloodPressure.diastolic}</Text>
                )}
                {record.bloodSugar > 0 && <Text>血糖: {record.bloodSugar}</Text>}
                {record.weight > 0 && <Text>体重: {record.weight}kg</Text>}
              </Space>
            </div>
          )
        }))}
      />
    </Card>
  )

  return (
    <PageContainer>
      <Title level={2}>
        <BarChartOutlined style={{ color: '#6366f1', marginRight: 8 }} />
        健康数据记录
      </Title>

      {renderStatsCards()}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        size="large"
        items={[
          { key: 'record', label: '数据记录', children: renderRecordForm() },
          { key: 'chart', label: '趋势分析', children: renderChart() },
          { key: 'history', label: '历史记录', children: renderRecentRecords() },
        ]}
      />
    </PageContainer>
  )
}

export default DataRecordPage