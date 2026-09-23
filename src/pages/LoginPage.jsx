import React, { useState, useEffect } from 'react'
import {
  Card,
  Form,
  Input,
  Button,
  Typography,
  Space,
  Divider,
  message,
  Tabs,
  InputNumber,
  Select,
  Checkbox,
  Modal,
  Alert,
  Tag
} from 'antd'
import {
  UserOutlined,
  LockOutlined,
  MobileOutlined,
  SafetyOutlined,
  HeartOutlined,
  FileProtectOutlined,
  SolutionOutlined
} from '@ant-design/icons'
import styled from 'styled-components'
import { useNavigate } from 'react-router-dom'
import { useUser } from '../contexts/UserContext'
import { listPatients } from '../services/patientApi'

const { Title, Text, Paragraph } = Typography
const { Option } = Select

/** 用户协议 / 隐私政策版本号（展示用） */
const POLICY_VERSION = 'v1.0 · 2026-09'

const LoginContainer = styled.div`
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
`

const LoginCard = styled(Card)`
  width: 100%;
  max-width: 540px;
  border-radius: 16px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  
  .ant-card-body {
    padding: 40px;
    
    @media (max-width: 768px) {
      padding: 24px;
    }
  }
`

const LogoSection = styled.div`
  text-align: center;
  margin-bottom: 24px;
  
  .logo-icon {
    font-size: 64px;
    color: #6366f1;
    margin-bottom: 16px;
  }
  
  .logo-title {
    color: #1e293b;
    margin-bottom: 8px;
  }
  
  .logo-subtitle {
    color: #64748b;
    font-size: 16px;
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

/** 应用功能说明（写在示范病例入口上方，供用户与评委快速了解） */
const FeatureIntro = styled.div`
  margin-bottom: 20px;
  padding: 16px 18px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px solid #e9e6ff;
  text-align: left;

  .intro-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 700;
    color: #1e293b;
    margin-bottom: 8px;
  }

  .intro-tag {
    font-size: 12px;
    font-weight: 400;
  }

  p {
    margin: 0 0 6px;
    font-size: 13.5px;
    line-height: 1.75;
    color: #475569;

    &:last-of-type {
      margin-bottom: 0;
    }
  }

  b {
    color: #4f46e5;
    font-weight: 600;
  }
`

const DemoSection = styled.div`
  margin-bottom: 24px;

  .demo-title {
    font-size: 14px;
    color: #64748b;
    margin-bottom: 10px;
    text-align: center;
  }

  .demo-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }

  .demo-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 10px;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    background: #f8fafc;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    transition: all 0.2s ease;

    &:hover {
      border-color: #6366f1;
      background: #eef2ff;
      transform: translateY(-1px);
    }

    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .demo-name {
      font-size: 15px;
      font-weight: 600;
      color: #1e293b;
    }

    .demo-disease {
      font-size: 12px;
      color: #6366f1;
    }

    .demo-meta {
      font-size: 12px;
      color: #94a3b8;
    }
  }

  .demo-hint {
    margin-top: 10px;
    font-size: 12.5px;
    color: #94a3b8;
    text-align: center;
    line-height: 1.6;
  }
`

const FeatureList = styled.div`
  margin-top: 24px;
  
  .feature-item {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    color: #64748b;
    font-size: 14px;
    
    .feature-icon {
      color: #6366f1;
    }
  }
`

/** 协议 / 政策正文容器 */
const PolicyBody = styled.div`
  max-height: 52vh;
  overflow-y: auto;
  padding-right: 6px;

  h4 {
    margin: 18px 0 6px;
    font-size: 15px;
    color: #1e293b;

    &:first-of-type {
      margin-top: 0;
    }
  }

  p,
  li {
    font-size: 13.5px;
    line-height: 1.8;
    color: #475569;
  }

  ul {
    margin: 6px 0 0;
    padding-left: 20px;
  }

  .policy-meta {
    font-size: 12.5px;
    color: #94a3b8;
    margin-bottom: 12px;
  }
`

const LoginPage = () => {
  const navigate = useNavigate()
  const [loginForm] = Form.useForm()
  const [registerForm] = Form.useForm()
  const [forgotForm] = Form.useForm()
  const [activeTab, setActiveTab] = useState('login')
  const [loading, setLoading] = useState(false)
  const [demoEntries, setDemoEntries] = useState([])

  // 三个「实体」弹窗：用户协议 / 隐私政策 / 忘记密码
  const [agreementOpen, setAgreementOpen] = useState(false)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [forgotOpen, setForgotOpen] = useState(false)
  const [forgotLoading, setForgotLoading] = useState(false)

  const { login, register, resetPassword } = useUser()

  // 示范入口来自后端数据库（/api/patients），不再读取 demoPatients.js
  useEffect(() => {
    let cancelled = false
    listPatients()
      .then((list) => {
        if (!cancelled) setDemoEntries(list)
      })
      .catch(() => {
        if (!cancelled) setDemoEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 示范病例一键进入（张建国 / 李秀英 / 王建军）—— 属于免注册的例外入口 */
  const handleDemoLogin = async (patientId) => {
    setLoading(true)
    try {
      const result = await login({ patientId })
      if (result.success) {
        message.success(`已进入${result.user.name}的示范档案`)
        navigate('/')
      } else {
        message.error(result.error || '进入示范病例失败，请重试')
      }
    } catch (error) {
      message.error('进入示范病例失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  /**
   * 登录。
   * 三位示范病例可直接进入；其他账号必须**先注册**，
   * 未注册的用户名会得到明确提示，不会回落到任何默认患者。
   */
  const handleLogin = async (values) => {
    setLoading(true)
    try {
      const result = await login({ username: values.username, password: values.password })
      if (result.success) {
        message.success(`登录成功，已载入${result.user.name}的档案`)
        navigate('/')
      } else {
        message.error(result.error || '登录失败，请检查用户名和密码')
      }
    } catch (error) {
      message.error('登录失败，请检查用户名和密码')
    } finally {
      setLoading(false)
    }
  }

  /**
   * 注册。
   * 注册成功后**不自动登录**：切回登录页签并回填用户名，
   * 由用户用新账号登录，确保「先注册，后才能登录」。
   */
  const handleRegister = async (values) => {
    setLoading(true)
    try {
      const userData = {
        id: Date.now(),
        name: values.name,
        username: values.username,
        password: values.password,
        age: values.age,
        gender: values.gender,
        phone: values.phone,
        height: values.height,
        weight: values.weight,
        diseases: values.diseases || [],
        emergencyContact: values.emergencyContact
      }

      const result = await register(userData)
      if (!result.success) {
        message.error(result.error || '注册失败，请重试')
        return
      }

      message.success('注册成功！请使用新账号登录（新档案从零开始，登录后记录第一条数据即可看到趋势与预警）')
      setActiveTab('login')
      loginForm.setFieldsValue({ username: result.username })
      registerForm.resetFields()
    } catch (error) {
      message.error('注册失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  /** 忘记密码 → 校验用户名 + 注册手机号后重置本机账号密码 */
  const handleForgotPassword = async (values) => {
    setForgotLoading(true)
    try {
      const result = await resetPassword({
        username: values.forgotUsername,
        phone: values.forgotPhone,
        newPassword: values.newPassword
      })
      if (!result.ok) {
        message.error(result.message || '重置失败，请重试')
        return
      }
      message.success('密码已重置，请使用新密码登录')
      forgotForm.resetFields()
      setForgotOpen(false)
      setActiveTab('login')
      loginForm.setFieldsValue({ username: result.username })
    } catch (error) {
      message.error('重置失败，请重试')
    } finally {
      setForgotLoading(false)
    }
  }

  const renderLoginForm = () => (
    <Form
      form={loginForm}
      layout="vertical"
      onFinish={handleLogin}
      size="large"
    >
      <Form.Item
        label="用户名"
        name="username"
        rules={[{ required: true, message: '请输入用户名' }]}
      >
        <Input
          prefix={<UserOutlined />}
          placeholder="请输入用户名"
          autoComplete="username"
        />
      </Form.Item>

      <Form.Item
        label="密码"
        name="password"
        rules={[{ required: true, message: '请输入密码' }]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="请输入密码"
          autoComplete="current-password"
        />
      </Form.Item>

      <Form.Item>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Checkbox>记住密码</Checkbox>
          <Button
            type="link"
            style={{ padding: 0 }}
            onClick={() => setForgotOpen(true)}
          >
            忘记密码？
          </Button>
        </div>
      </Form.Item>

      <Form.Item style={{ marginBottom: 12 }}>
        <ActionButton
          type="primary"
          htmlType="submit"
          loading={loading}
          className="primary"
          block
        >
          登录
        </ActionButton>
      </Form.Item>

      <Alert
        type="info"
        showIcon
        style={{ borderRadius: 8, fontSize: 12.5 }}
        message="尚未注册的账号无法登录"
        description="上方三位示范病例可一键进入；其他账号请先到「注册」页签完成注册。注册会在数据库中为你建立一份空白健康档案，登录后录入的血压、血糖等数据才会产生趋势与预警。"
      />
    </Form>
  )

  const renderRegisterForm = () => (
    <Form
      form={registerForm}
      layout="vertical"
      onFinish={handleRegister}
      size="large"
    >
      <Form.Item
        label="姓名"
        name="name"
        rules={[{ required: true, message: '请输入姓名' }]}
      >
        <Input
          prefix={<UserOutlined />}
          placeholder="请输入真实姓名"
        />
      </Form.Item>

      <Form.Item
        label="用户名"
        name="username"
        rules={[
          { required: true, message: '请输入用户名' },
          { min: 3, message: '用户名至少 3 位' }
        ]}
      >
        <Input
          prefix={<UserOutlined />}
          placeholder="请设置用户名（用于后续登录）"
          autoComplete="username"
        />
      </Form.Item>

      <Form.Item
        label="密码"
        name="password"
        rules={[
          { required: true, message: '请输入密码' },
          { min: 6, message: '密码至少6位' }
        ]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="请设置密码"
          autoComplete="new-password"
        />
      </Form.Item>

      <Form.Item
        label="确认密码"
        name="confirmPassword"
        dependencies={['password']}
        rules={[
          { required: true, message: '请确认密码' },
          ({ getFieldValue }) => ({
            validator(_, value) {
              if (!value || getFieldValue('password') === value) {
                return Promise.resolve()
              }
              return Promise.reject(new Error('两次输入的密码不一致'))
            },
          }),
        ]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="请再次输入密码"
          autoComplete="new-password"
        />
      </Form.Item>

      <Form.Item
        label="手机号"
        name="phone"
        rules={[
          { required: true, message: '请输入手机号' },
          { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号' }
        ]}
      >
        <Input
          prefix={<MobileOutlined />}
          placeholder="请输入手机号（用于找回密码）"
        />
      </Form.Item>

      <div style={{ display: 'flex', gap: 16 }}>
        <Form.Item
          label="年龄"
          name="age"
          style={{ flex: 1 }}
          rules={[{ required: true, message: '请输入年龄' }]}
        >
          <InputNumber
            style={{ width: '100%' }}
            placeholder="年龄"
            min={18}
            max={120}
          />
        </Form.Item>

        <Form.Item
          label="性别"
          name="gender"
          style={{ flex: 1 }}
          rules={[{ required: true, message: '请选择性别' }]}
        >
          <Select placeholder="请选择性别">
            <Option value="male">男</Option>
            <Option value="female">女</Option>
          </Select>
        </Form.Item>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <Form.Item
          label="身高 (cm)"
          name="height"
          style={{ flex: 1 }}
        >
          <InputNumber
            style={{ width: '100%' }}
            placeholder="身高"
            min={100}
            max={250}
          />
        </Form.Item>

        <Form.Item
          label="体重 (kg)"
          name="weight"
          style={{ flex: 1 }}
        >
          <InputNumber
            style={{ width: '100%' }}
            placeholder="体重"
            min={30}
            max={200}
            step={0.1}
          />
        </Form.Item>
      </div>

      <Form.Item
        label="慢性疾病"
        name="diseases"
      >
        <Select
          mode="multiple"
          placeholder="请选择您的慢性疾病（可选）"
          allowClear
        >
          <Option value="hypertension">高血压</Option>
          <Option value="diabetes">糖尿病</Option>
          <Option value="obesity">肥胖症</Option>
          <Option value="hyperlipidemia">高血脂</Option>
          <Option value="coronary_heart_disease">冠心病</Option>
        </Select>
      </Form.Item>

      <Form.Item
        label="紧急联系人"
        name="emergencyContact"
      >
        <Input
          placeholder="紧急联系人姓名和电话（可选）"
        />
      </Form.Item>

      <Form.Item
        name="agreement"
        valuePropName="checked"
        rules={[
          {
            validator: (_, value) =>
              value ? Promise.resolve() : Promise.reject(new Error('请先阅读并同意用户协议与隐私政策')),
          },
        ]}
      >
        <Checkbox>
          我已阅读并同意{' '}
          <Button
            type="link"
            style={{ padding: 0 }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setAgreementOpen(true)
            }}
          >
            用户协议
          </Button>{' '}
          和{' '}
          <Button
            type="link"
            style={{ padding: 0 }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setPrivacyOpen(true)
            }}
          >
            隐私政策
          </Button>
        </Checkbox>
      </Form.Item>

      <Form.Item>
        <ActionButton
          type="primary"
          htmlType="submit"
          loading={loading}
          className="primary"
          block
        >
          注册
        </ActionButton>
      </Form.Item>
    </Form>
  )

  return (
    <LoginContainer>
      <LoginCard>
        <LogoSection>
          <div className="logo-icon">
            <HeartOutlined />
          </div>
          <Title level={2} className="logo-title">
            迈康 MyCare
          </Title>
          <Paragraph className="logo-subtitle">
            老年慢病多智能体协同健康管理平台
          </Paragraph>
        </LogoSection>

        {/* 应用功能说明：适用人群 / 管理指标 / 判定方式 / 激励 / 效果目标 */}
        <FeatureIntro>
          <div className="intro-title">
            <SolutionOutlined style={{ color: '#6366f1' }} />
            这个应用能做什么
            <Tag color="purple" className="intro-tag">功能说明</Tag>
          </div>
          <p>
            <b>适用人群：</b>面向需要长期居家管理的老年慢病人群，适用于高血压、糖尿病、超重肥胖等慢性病患者及其家属。
          </p>
          <p>
            <b>管理指标：</b>围绕血压、空腹血糖、体重与腰围、步数、运动时长、睡眠以及长期用药等核心指标，支持每日一键记录与趋势追踪。
          </p>
          <p>
            <b>判定方式：</b>所有数值与预警等级均由内置确定性健康规则引擎（13 条演示规则）统一计算，AI 智能体只负责解读与建议表达，不会自行改写阈值、等级或达标率。
          </p>
          <p>
            <b>激励与提醒：</b>坚持记录会累积连续天数与健康勋章；出现异常趋势时自动生成预警，供本人、家属与医生查看，外部通知需本人授权确认后才发送。
          </p>
          <p>
            <b>预期效果：</b>帮助患者把血压、血糖稳定在个体化目标范围内，改善体重与运动习惯，形成可持续的自我健康管理闭环。
          </p>
        </FeatureIntro>

        <DemoSection>
          <div className="demo-title">一键进入示范病例</div>
          {demoEntries.length > 0 ? (
            <div className="demo-grid">
              {demoEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="demo-card"
                  disabled={loading}
                  onClick={() => handleDemoLogin(entry.id)}
                >
                  <span className="demo-name">{entry.name}</span>
                  <span className="demo-disease">{entry.disease}</span>
                  <span className="demo-meta">
                    {entry.gender} · {entry.age} 岁
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              示范病例加载中… 若长时间无响应，请确认后端服务（:3001）已启动
            </div>
          )}
          <div className="demo-hint">
            以上三位示范病例免注册，可直接进入；其他账号请先注册，注册成功后再登录
          </div>
        </DemoSection>

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          centered
          size="large"
          items={[
            { key: 'login', label: '登录', children: renderLoginForm() },
            { key: 'register', label: '注册', children: renderRegisterForm() },
          ]}
        />

        <FeatureList>
          <div className="feature-item">
            <SafetyOutlined className="feature-icon" />
            <Text>基于医学指南参考的健康管理</Text>
          </div>
          <div className="feature-item">
            <HeartOutlined className="feature-icon" />
            <Text>个性化健康建议生成</Text>
          </div>
          <div className="feature-item">
            <UserOutlined className="feature-icon" />
            <Text>老年友好的界面设计</Text>
          </div>
        </FeatureList>

        <Divider />

        <div style={{ textAlign: 'center' }}>
          <Space size={4} wrap style={{ justifyContent: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              © 2026 迈康 MyCare 团队. 保留所有权利.
            </Text>
          </Space>
          <div style={{ marginTop: 6 }}>
            <Space size={12}>
              <Button type="link" size="small" onClick={() => setAgreementOpen(true)}>
                用户协议
              </Button>
              <Button type="link" size="small" onClick={() => setPrivacyOpen(true)}>
                隐私政策
              </Button>
            </Space>
          </div>
        </div>

        {/* ---------------- 用户协议（实体） ---------------- */}
        <Modal
          title={
            <Space>
              <FileProtectOutlined style={{ color: '#6366f1' }} />
              迈康 MyCare 用户协议
            </Space>
          }
          open={agreementOpen}
          onCancel={() => setAgreementOpen(false)}
          footer={[
            <Button key="close" onClick={() => setAgreementOpen(false)}>
              我已阅读
            </Button>,
          ]}
          width={640}
        >
          <PolicyBody>
            <div className="policy-meta">版本 {POLICY_VERSION}　生效日期：2026 年 9 月 1 日</div>

            <h4>一、服务说明</h4>
            <p>
              迈康 MyCare 是一款面向老年慢病人群的<b>健康管理辅助工具</b>，提供健康数据记录、趋势分析、
              风险提示、健康建议与家庭 / 医生协同查看等功能。本平台不提供在线诊疗服务，
              不构成医疗诊断或用药决策依据。
            </p>

            <h4>二、账号规则（先注册，后才能登录）</h4>
            <ul>
              <li>页面提供的三位示范病例为演示账号，可一键进入，无需注册。</li>
              <li>除示范病例外，<b>其他账号必须先在「注册」页签完成注册，注册成功后才能登录</b>；未注册的用户名无法登录。</li>
              <li>注册会在患者库中为您建立一份<b>空白健康档案</b>：档案初始没有历史指标与预警，血压、血糖、体重等数据均由您自己记录后产生。</li>
              <li>注册信息中的用户名与手机号用于登录与找回密码，请确保真实有效；用户名注册后不可重复使用。</li>
              <li>请妥善保管账号密码。本平台不会以任何形式向您索取密码。</li>
            </ul>

            <h4>三、使用规范</h4>
            <ul>
              <li>您应保证录入的健康数据真实、准确；错误的记录可能导致建议与预警出现偏差。</li>
              <li>不得利用本平台从事任何违法违规活动，不得干扰平台正常运行。</li>
              <li>平台给出的健康建议仅供参考，具体诊疗方案请以执业医师的当面诊断为准。</li>
            </ul>

            <h4>四、风险与免责</h4>
            <p>
              平台的预警与建议均由确定性规则引擎依据您录入的数据自动计算，AI 智能体仅负责把结果转述为自然语言。
              当出现「紧急」等级提示或明显身体不适时，请立即就医，不要依赖平台提示。
            </p>

            <h4>五、协议变更</h4>
            <p>
              平台可能根据功能调整更新本协议，更新后会在本页面公示版本号；继续使用即视为接受更新后的协议。
            </p>
          </PolicyBody>
        </Modal>

        {/* ---------------- 隐私政策（实体） ---------------- */}
        <Modal
          title={
            <Space>
              <SafetyOutlined style={{ color: '#10b981' }} />
              迈康 MyCare 隐私政策
            </Space>
          }
          open={privacyOpen}
          onCancel={() => setPrivacyOpen(false)}
          footer={[
            <Button key="close" onClick={() => setPrivacyOpen(false)}>
              我已阅读
            </Button>,
          ]}
          width={640}
        >
          <PolicyBody>
            <div className="policy-meta">版本 {POLICY_VERSION}　生效日期：2026 年 9 月 1 日</div>

            <h4>一、我们收集哪些信息</h4>
            <ul>
              <li><b>账号信息：</b>您在注册时填写的姓名、用户名、手机号、年龄、性别、身高、体重、慢性疾病与紧急联系人。</li>
              <li><b>健康数据：</b>您主动录入的血压、血糖、体重、步数、运动时长、睡眠与用药等信息。</li>
              <li>除上述信息外，平台不采集通讯录、位置、相册等与健康管理无关的信息。</li>
            </ul>

            <h4>二、信息如何存储</h4>
            <ul>
              <li>
                <b>健康数据</b>保存在本平台的服务端数据库中，用于趋势分析、规则判定与预警生成；
                自助注册的账号会在患者库中建立一份仅属于自己的档案。
              </li>
              <li>
                <b>账号凭据</b>同样保存在服务端：密码仅以 <b>scrypt 加盐哈希</b>形式存储，
                不保存明文，平台任何界面都无法还原您的密码。
              </li>
              <li>
                浏览器本地只保存<b>登录状态与界面偏好</b>（用于刷新后保持登录），
                不保存任何健康数据，也不保存账号密码。
              </li>
            </ul>

            <h4>三、信息如何使用</h4>
            <ul>
              <li>用于生成健康评分、趋势曲线、健康建议与风险预警。</li>
              <li>用于在您授权并确认后，向您指定的紧急联系人或医生同步必要信息。</li>
              <li><b>外发保护：</b>预警信息默认只记录不外发；如需通知家属或医生，必须同时满足「联系人已授权」与「本人点击确认」两个条件。</li>
            </ul>

            <h4>四、信息共享与对外提供</h4>
            <p>
              除法律法规要求或您明确授权外，平台不会向任何第三方出售、出租或共享您的个人信息与健康数据。
            </p>

            <h4>五、您的权利</h4>
            <ul>
              <li>您可以随时查看、修正自己录入的健康数据。</li>
              <li>您可以在「我的」页面退出登录，退出后本机不再保留登录态。</li>
              <li>如需删除账号或注销数据，可通过平台底部的「联系我们」提出申请。</li>
            </ul>

            <h4>六、安全提示</h4>
            <p>
              请勿在公共设备上保存登录状态。本平台为演示环境，请不要录入真实身份证明类敏感信息。
            </p>
          </PolicyBody>
        </Modal>

        {/* ---------------- 忘记密码（实体：可自助重置本机账号密码） ---------------- */}
        <Modal
          title={
            <Space>
              <LockOutlined style={{ color: '#f59e0b' }} />
              找回密码
            </Space>
          }
          open={forgotOpen}
          onCancel={() => setForgotOpen(false)}
          footer={null}
          width={480}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16, borderRadius: 8, fontSize: 12.5 }}
            message="示范病例无需密码"
            description="上方三位示范病例可一键进入，不涉及密码。以下重置流程适用于您自行注册的账号。"
          />
          <Form
            form={forgotForm}
            layout="vertical"
            onFinish={handleForgotPassword}
            size="large"
          >
            <Form.Item
              label="注册用户名"
              name="forgotUsername"
              rules={[{ required: true, message: '请输入注册时使用的用户名' }]}
            >
              <Input prefix={<UserOutlined />} placeholder="请输入注册用户名" />
            </Form.Item>

            <Form.Item
              label="注册手机号"
              name="forgotPhone"
              rules={[
                { required: true, message: '请输入注册时填写的手机号' },
                { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号' }
              ]}
            >
              <Input prefix={<MobileOutlined />} placeholder="用于核验身份" />
            </Form.Item>

            <Form.Item
              label="新密码"
              name="newPassword"
              rules={[
                { required: true, message: '请输入新密码' },
                { min: 6, message: '密码至少6位' }
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="请设置新密码" />
            </Form.Item>

            <Form.Item
              label="确认新密码"
              name="confirmNewPassword"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: '请确认新密码' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('newPassword') === value) {
                      return Promise.resolve()
                    }
                    return Promise.reject(new Error('两次输入的密码不一致'))
                  },
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="请再次输入新密码" />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              <ActionButton
                type="primary"
                htmlType="submit"
                loading={forgotLoading}
                className="primary"
                block
              >
                重置密码
              </ActionButton>
            </Form.Item>
          </Form>
        </Modal>
      </LoginCard>
    </LoginContainer>
  )
}

export default LoginPage
