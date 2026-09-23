import React, { useState, useEffect } from 'react'
import {
  Card,
  Form,
  Input,
  Button,
  Switch,
  Select,
  InputNumber,
  Upload,
  Avatar,
  Space,
  Typography,
  Row,
  Col,
  Divider,
  message,
  Modal,
  List,
  Tag,
  Statistic
} from 'antd'
import {
  UserOutlined,
  EditOutlined,
  SettingOutlined,
  UploadOutlined,
  SoundOutlined,
  EyeOutlined,
  MobileOutlined,
  SafetyOutlined,
  HistoryOutlined,
  TrophyOutlined,
  HeartOutlined,
  LogoutOutlined,
  CameraOutlined,
  FormOutlined
} from '@ant-design/icons'
import styled from 'styled-components'
import { useNavigate } from 'react-router-dom'
import { useUser } from '../contexts/UserContext'
import { getProfile } from '../services/patientApi'
import ProfileSetupModal from '../components/Patient/ProfileSetupModal'
import { useHealthData } from '../contexts/HealthDataContext'

const { Title, Text, Paragraph } = Typography
const { Option } = Select

const PageContainer = styled.div`
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
  
  @media (max-width: 768px) {
    padding: 16px;
  }
`

const ProfileCard = styled(Card)`
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  margin-bottom: 24px;
  
  .profile-header {
    text-align: center;
    padding: 24px 0;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    border-radius: 12px 12px 0 0;
    margin: -24px -24px 24px -24px;
    color: white;
    
    .profile-avatar {
      margin-bottom: 16px;
    }
    
    .profile-name {
      color: white;
      margin-bottom: 8px;
    }
    
    .profile-level {
      color: rgba(255, 255, 255, 0.8);
    }
  }
`

const SettingsCard = styled(Card)`
  border-radius: 12px;
  margin-bottom: 24px;
  
  .setting-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 0;
    border-bottom: 1px solid #f0f0f0;
    
    &:last-child {
      border-bottom: none;
    }
    
    .setting-label {
      display: flex;
      align-items: center;
      gap: 8px;
      
      .setting-icon {
        color: #6366f1;
      }
    }
  }
`

const StatsCard = styled(Card)`
  border-radius: 12px;
  text-align: center;
  
  .ant-statistic-title {
    color: #64748b;
  }
  
  .ant-statistic-content {
    color: #1e293b;
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
  
  &.danger {
    background: #ef4444;
    border-color: #ef4444;
    
    &:hover {
      background: #dc2626;
      border-color: #dc2626;
    }
  }
`

const ProfilePage = () => {
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const [editMode, setEditMode] = useState(false)
  const [logoutModalVisible, setLogoutModalVisible] = useState(false)

  /** 健康档案（落库的完整档案：紧急联系人 / 疾病分级 / 生活画像 / 控制目标 / 用药） */
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [profileRaw, setProfileRaw] = useState(null)

  const {
    user,
    elderlyMode,
    voiceEnabled,
    updateUserInfo,
    updateSettings,
    logout,
    getUserLevel
  } = useUser()

  const { userBadges, healthRecords, getHealthScore } = useHealthData()

  const userLevel = getUserLevel()
  const healthScore = getHealthScore()
  const totalRecords = healthRecords.length
  const totalBadges = userBadges.length

  const patientId = user?.user_id || user?.patient_id || null

  /** 读取完整档案（用于「我的健康档案」编辑弹窗预填） */
  const loadProfile = () => {
    if (!patientId) return
    getProfile(patientId)
      .then((d) => setProfileRaw(d?.profile || null))
      .catch(() => {
        /* 档案读取失败不影响本页其它内容 */
      })
  }

  useEffect(() => {
    loadProfile()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId])

  const handleSaveProfile = async (values) => {
    try {
      await updateUserInfo(values)
      message.success('个人信息更新成功')
      setEditMode(false)
    } catch (error) {
      message.error('更新失败，请重试')
    }
  }

  const handleSettingChange = (key, value) => {
    updateSettings({ [key]: value })
    message.success('设置已更新')
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
    message.success('已安全退出')
  }

  const handleAvatarUpload = (info) => {
    if (info.file.status === 'done') {
      message.success('头像上传成功')
      // 这里应该处理头像上传逻辑
    } else if (info.file.status === 'error') {
      message.error('头像上传失败')
    }
  }

  const renderProfileHeader = () => (
    <div className="profile-header">
      <div className="profile-avatar">
        <Upload
          name="avatar"
          listType="picture-card"
          className="avatar-uploader"
          showUploadList={false}
          onChange={handleAvatarUpload}
          disabled={!editMode}
        >
          <Avatar size={80} icon={<UserOutlined />} />
          {editMode && (
            <div style={{ marginTop: 8 }}>
              <CameraOutlined />
            </div>
          )}
        </Upload>
      </div>
      <Title level={3} className="profile-name">
        {user?.name || '用户'}
      </Title>
      <div className="profile-level">
        <Space>
          <TrophyOutlined />
          <Text className="profile-level">
            {userLevel?.unavailable
              ? '积分与等级待启用'
              : `${userLevel?.title || '健康新手'}（等级 ${userLevel?.level}）`}
          </Text>
        </Space>
      </div>
    </div>
  )

  const renderBasicInfo = () => (
    <Card title="基本信息" extra={
      <Button
        type="link"
        icon={<EditOutlined />}
        onClick={() => setEditMode(!editMode)}
      >
        {editMode ? '取消编辑' : '编辑信息'}
      </Button>
    }>
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSaveProfile}
        initialValues={user}
        disabled={!editMode}
      >
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item
              label="姓名"
              name="name"
              rules={[{ required: true, message: '请输入姓名' }]}
            >
              <Input placeholder="请输入姓名" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              label="年龄"
              name="age"
              rules={[{ required: true, message: '请输入年龄' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                placeholder="请输入年龄"
                min={18}
                max={120}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item
              label="性别"
              name="gender"
              rules={[{ required: true, message: '请选择性别' }]}
            >
              <Select placeholder="请选择性别">
                <Option value="male">男</Option>
                <Option value="female">女</Option>
              </Select>
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              label="联系电话"
              name="phone"
            >
              <Input placeholder="请输入联系电话" />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item
              label="身高 (cm)"
              name="height"
            >
              <InputNumber
                style={{ width: '100%' }}
                placeholder="请输入身高"
                min={100}
                max={250}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              label="体重 (kg)"
              name="weight"
            >
              <InputNumber
                style={{ width: '100%' }}
                placeholder="请输入体重"
                min={30}
                max={200}
                step={0.1}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          label="慢性疾病"
          name="diseases"
        >
          <Select
            mode="multiple"
            placeholder="请选择您的慢性疾病"
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
          <Input placeholder="请输入紧急联系人信息" />
        </Form.Item>

        {editMode && (
          <Form.Item>
            <Space>
              <ActionButton
                type="primary"
                htmlType="submit"
                className="primary"
              >
                保存信息
              </ActionButton>
              <Button onClick={() => setEditMode(false)}>
                取消
              </Button>
            </Space>
          </Form.Item>
        )}
      </Form>
    </Card>
  )

  const renderSettings = () => (
    <SettingsCard title="应用设置">
      <div className="setting-item">
        <div className="setting-label">
          <EyeOutlined className="setting-icon" />
          <div>
            <Text strong>老年友好模式</Text>
            <br />
            <Text type="secondary">大字体、高对比度界面</Text>
          </div>
        </div>
        <Switch
          checked={elderlyMode}
          onChange={(checked) => handleSettingChange('elderlyMode', checked)}
        />
      </div>

      <div className="setting-item">
        <div className="setting-label">
          <SoundOutlined className="setting-icon" />
          <div>
            <Text strong>语音播报</Text>
            <br />
            <Text type="secondary">重要操作语音提示</Text>
          </div>
        </div>
        <Switch
          checked={voiceEnabled}
          onChange={(checked) => handleSettingChange('voiceEnabled', checked)}
        />
      </div>

      <div className="setting-item">
        <div className="setting-label">
          <MobileOutlined className="setting-icon" />
          <div>
            <Text strong>消息推送</Text>
            <br />
            <Text type="secondary">健康提醒和任务通知</Text>
          </div>
        </div>
        <Switch defaultChecked />
      </div>

      <div className="setting-item">
        <div className="setting-label">
          <SafetyOutlined className="setting-icon" />
          <div>
            <Text strong>数据同步</Text>
            <br />
            <Text type="secondary">自动同步健康数据</Text>
          </div>
        </div>
        <Switch defaultChecked />
      </div>
    </SettingsCard>
  )

  const renderStats = () => (
    <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="健康评分"
            value={healthScore}
            suffix="分"
            prefix={<HeartOutlined style={{ color: '#ef4444' }} />}
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="记录天数"
            value={totalRecords}
            suffix="天"
            prefix={<HistoryOutlined style={{ color: '#6366f1' }} />}
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="获得勋章"
            value={totalBadges}
            suffix="个"
            prefix={<TrophyOutlined style={{ color: '#f59e0b' }} />}
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="当前等级"
            value={userLevel?.unavailable ? '待启用' : userLevel?.level}
            prefix={<UserOutlined style={{ color: '#8b5cf6' }} />}
          />
        </StatsCard>
      </Col>
    </Row>
  )

  const renderRecentBadges = () => (
    <Card title="最近获得的勋章" style={{ marginBottom: 24 }}>
      {userBadges.length > 0 ? (
        <List
          dataSource={userBadges.slice(0, 5)}
          renderItem={badge => (
            <List.Item>
              <List.Item.Meta
                avatar={<TrophyOutlined style={{ color: '#f59e0b', fontSize: 20 }} />}
                title={badge.badgeType}
                description={new Date(badge.earnedDate).toLocaleDateString()}
              />
              <Tag color="gold">已获得</Tag>
            </List.Item>
          )}
        />
      ) : (
        <Text type="secondary">暂无获得的勋章</Text>
      )}
    </Card>
  )

  return (
    <PageContainer>
      <Title level={2}>
        <UserOutlined style={{ color: '#6366f1', marginRight: 8 }} />
        个人中心
      </Title>

      <ProfileCard>
        {renderProfileHeader()}
        {renderStats()}
      </ProfileCard>

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={14}>
          {renderBasicInfo()}
        </Col>
        <Col xs={24} lg={10}>
          {renderSettings()}
          {renderRecentBadges()}
        </Col>
      </Row>

      {/* 健康档案入口：落库的完整档案，六个智能体与医生端都读它 */}
      <Card
        style={{
          marginTop: 24,
          borderRadius: 16,
          border: '1px solid #c7d2fe',
          background: 'linear-gradient(135deg, #eef2ff 0%, #faf5ff 100%)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <FormOutlined style={{ fontSize: 28, color: '#6366f1', lineHeight: '32px' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: '#1f2233', marginBottom: 6 }}>我的健康档案</div>
            <div style={{ color: '#6b7280', lineHeight: 1.8, marginBottom: 14 }}>
              紧急联系人、疾病诊断与分级、心血管危险分层、生活画像、控制目标与用药计划。
              这些内容会直接决定医生端「患者详情」能看到什么，以及智能体给出的建议是否贴合您本人。
            </div>
            <Button type="primary" icon={<FormOutlined />} onClick={() => setProfileModalOpen(true)}>
              {profileRaw && (profileRaw.lifestyle?.diet || (profileRaw.contacts || []).length) ? '查看并修改档案' : '去完善档案'}
            </Button>
          </div>
        </div>
      </Card>

      {/* 隐私授权入口：由患者本人决定哪位医生可以查看自己的健康档案 */}
      <Card
        style={{
          marginTop: 24,
          borderRadius: 16,
          border: '1px solid #ddd6fe',
          background: 'linear-gradient(135deg, #f8f9ff 0%, #f5f3ff 100%)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <SafetyOutlined style={{ fontSize: 28, color: '#6366f1', lineHeight: '32px' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: '#1f2233', marginBottom: 6 }}>
              我的医疗团队与隐私授权
            </div>
            <div style={{ color: '#6b7280', lineHeight: 1.8, marginBottom: 14 }}>
              只有您点过「同意」的医生，才能在医生端看到您的健康档案。您可以随时停止授权。
            </div>
            <Button type="primary" icon={<SafetyOutlined />} onClick={() => navigate('/care-team')}>
              查看并管理授权
            </Button>
          </div>
        </div>
      </Card>

      <Card style={{ textAlign: 'center', marginTop: 24 }}>
        <Space size="large">
          <Button
            type="link"
            onClick={() => navigate('/data-record')}
          >
            数据记录
          </Button>
          <Button
            type="link"
            onClick={() => navigate('/badges')}
          >
            我的勋章
          </Button>
          <Button
            type="link"
            onClick={() => navigate('/prescription')}
          >
            健康建议
          </Button>
        </Space>

        <Divider />

        <ActionButton
          type="primary"
          danger
          icon={<LogoutOutlined />}
          onClick={() => setLogoutModalVisible(true)}
          className="danger"
        >
          退出登录
        </ActionButton>
      </Card>

      <Modal
        title="确认退出"
        open={logoutModalVisible}
        onOk={handleLogout}
        onCancel={() => setLogoutModalVisible(false)}
        okText="确认退出"
        cancelText="取消"
        okButtonProps={{ danger: true }}
      >
        <p>确定要退出登录吗？</p>
      </Modal>

      {/* 健康档案编辑：保存即写库（patients / contacts / conditions / lifestyle / targets / medications） */}
      <ProfileSetupModal
        open={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        patientId={patientId}
        profile={profileRaw}
        onSaved={() => loadProfile()}
      />
    </PageContainer>
  )
}

export default ProfilePage