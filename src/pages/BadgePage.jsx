import React, { useState, useEffect } from 'react'
import {
  Card,
  Typography,
  Row,
  Col,
  Progress,
  Badge,
  Space,
  Statistic,
  Timeline,
  Tabs,
  Empty,
  Button
} from 'antd'
import {
  TrophyOutlined,
  StarOutlined,
  CrownOutlined,
  FireOutlined,
  HeartOutlined,
  StepForwardOutlined,
  CalendarOutlined,
  AimOutlined,
  GiftOutlined,
  ThunderboltOutlined,
  ExperimentOutlined
} from '@ant-design/icons'
import styled from 'styled-components'
import { useUser } from '../contexts/UserContext'
import { useHealthData } from '../contexts/HealthDataContext'

const { Title, Text, Paragraph } = Typography

const PageContainer = styled.div`
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
  
  @media (max-width: 768px) {
    padding: 16px;
  }
`

const BadgeCard = styled(Card)`
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  margin-bottom: 16px;
  transition: all 0.3s ease;
  cursor: pointer;
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  }
  
  &.earned {
    background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
    border: 2px solid #f59e0b;
  }
  
  &.locked {
    opacity: 0.6;
    background: #f8fafc;
  }
  
  .badge-icon {
    font-size: 48px;
    text-align: center;
    margin-bottom: 16px;
    
    &.earned {
      color: #f59e0b;
    }
    
    &.locked {
      color: #94a3b8;
    }
  }
  
  .badge-title {
    text-align: center;
    font-size: 16px;
    font-weight: bold;
    margin-bottom: 8px;
  }
  
  .badge-description {
    text-align: center;
    color: #64748b;
    font-size: 14px;
  }
  
  .badge-progress {
    margin-top: 12px;
  }
`

const LevelCard = styled(Card)`
  border-radius: 12px;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  color: white;
  margin-bottom: 24px;
  
  .ant-card-body {
    text-align: center;
  }
  
  .level-icon {
    font-size: 64px;
    margin-bottom: 16px;
  }
  
  .level-title {
    color: white;
    font-size: 24px;
    margin-bottom: 8px;
  }
  
  .level-description {
    color: rgba(255, 255, 255, 0.8);
    font-size: 16px;
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

const BadgePage = () => {
  const [activeTab, setActiveTab] = useState('badges')
  const { user, getUserLevel } = useUser()
  const { userBadges, checkNewBadges, healthRecords } = useHealthData()

  const [badges, setBadges] = useState([])
  const [userLevel, setUserLevel] = useState(null)
  const [stats, setStats] = useState({
    earnedCount: 0,
    totalCount: 8,
    completionRate: 0,
    currentLevel: null,
    nextLevelExp: null,
    levelUnavailable: true,
    levelNote: '积分与等级将在 P1 数据表建成后启用。',
  })

  // 定义所有可能的勋章
  const allBadges = [
    {
      id: 'first_record',
      name: '初次记录',
      description: '完成第一次健康数据记录',
      icon: <StarOutlined />,
      category: 'milestone',
      requirement: '记录1次健康数据'
    },
    {
      id: 'week_streak',
      name: '坚持一周',
      description: '连续记录健康数据7天',
      icon: <CalendarOutlined />,
      category: 'streak',
      requirement: '连续记录7天'
    },
    {
      id: 'month_streak',
      name: '坚持一月',
      description: '连续记录健康数据30天',
      icon: <FireOutlined />,
      category: 'streak',
      requirement: '连续记录30天'
    },
    {
      id: 'steps_10k',
      name: '万步达人',
      description: '单日步数达到10000步',
      icon: <StepForwardOutlined />,
      category: 'exercise',
      requirement: '单日步数≥10000'
    },
    {
      id: 'exercise_week',
      name: '运动达人',
      description: '一周运动时长达到150分钟',
      icon: <ThunderboltOutlined />,
      category: 'exercise',
      requirement: '周运动时长≥150分钟'
    },
    {
      id: 'weight_loss',
      name: '减重成功',
      description: '体重下降5kg以上',
      icon: <AimOutlined />,
      category: 'health',
      requirement: '体重下降≥5kg'
    },
    {
      id: 'bp_normal',
      name: '血压稳定',
      description: '连续7天血压正常',
      icon: <HeartOutlined />,
      category: 'health',
      requirement: '连续7天血压正常'
    },
    {
      id: 'sugar_control',
      name: '血糖控制',
      description: '连续7天血糖正常',
      icon: <ExperimentOutlined />,
      category: 'health',
      requirement: '连续7天血糖正常'
    }
  ]

  useEffect(() => {
    // 检查新勋章
    checkNewBadges()

    // 获取用户等级
    const level = getUserLevel()
    setUserLevel(level)

    // 计算勋章状态和进度
    const badgeStatus = allBadges.map(badge => {
      const earned = userBadges.some(ub => (ub.id || ub.badgeId || ub.badgeType) === badge.id)
      const progress = calculateBadgeProgress(badge.id)

      return {
        ...badge,
        earned,
        progress,
        earnedDate: earned
          ? userBadges.find(ub => (ub.id || ub.badgeId || ub.badgeType) === badge.id)?.earnedDate
          : null
      }
    })

    setBadges(badgeStatus)

    // 计算统计数据
    const earnedCount = badgeStatus.filter(b => b.earned).length
    const totalCount = badgeStatus.length
    const completionRate = Math.round((earnedCount / totalCount) * 100)

    setStats({
      earnedCount,
      totalCount,
      completionRate,
      // P1 未建成：等级/积分不作为运行时数据展示，也不伪造为「等级 1」
      currentLevel: level?.level ?? null,
      nextLevelExp:
        level?.nextLevelPoints != null
          ? Math.max(level.nextLevelPoints - (level.totalPoints || 0), 0)
          : null,
      levelUnavailable: Boolean(level?.unavailable),
      levelNote: level?.note || '',
    })
  }, [userBadges, healthRecords, checkNewBadges, getUserLevel])

  const calculateBadgeProgress = (badgeId) => {
    // 根据不同勋章类型计算进度
    switch (badgeId) {
      case 'first_record':
        return healthRecords.length > 0 ? 100 : 0

      case 'week_streak':
        return Math.min((getConsecutiveDays() / 7) * 100, 100)

      case 'month_streak':
        return Math.min((getConsecutiveDays() / 30) * 100, 100)

      case 'steps_10k':
        const maxSteps = Math.max(...healthRecords.map(r => r.steps || 0))
        return Math.min((maxSteps / 10000) * 100, 100)

      case 'exercise_week':
        const weeklyExercise = getWeeklyExerciseMinutes()
        return Math.min((weeklyExercise / 150) * 100, 100)

      case 'weight_loss':
        const weightLoss = getWeightLoss()
        return Math.min((weightLoss / 5) * 100, 100)

      case 'bp_normal':
        const bpDays = getNormalBPDays()
        return Math.min((bpDays / 7) * 100, 100)

      case 'sugar_control':
        const sugarDays = getNormalSugarDays()
        return Math.min((sugarDays / 7) * 100, 100)

      default:
        return 0
    }
  }

  const getConsecutiveDays = () => {
    // 计算连续记录天数
    if (healthRecords.length === 0) return 0

    const sortedRecords = [...healthRecords].sort((a, b) => new Date(b.date) - new Date(a.date))
    let consecutive = 1

    for (let i = 1; i < sortedRecords.length; i++) {
      const current = new Date(sortedRecords[i - 1].date)
      const previous = new Date(sortedRecords[i].date)
      const diffDays = Math.floor((current - previous) / (1000 * 60 * 60 * 24))

      if (diffDays === 1) {
        consecutive++
      } else {
        break
      }
    }

    return consecutive
  }

  const getWeeklyExerciseMinutes = () => {
    const oneWeekAgo = new Date()
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)

    return healthRecords
      .filter(record => new Date(record.date) >= oneWeekAgo)
      .reduce((total, record) => total + (record.exerciseMinutes || 0), 0)
  }

  const getWeightLoss = () => {
    if (healthRecords.length < 2) return 0

    const recordsWithWeight = healthRecords.filter(r => r.weight > 0)
    if (recordsWithWeight.length < 2) return 0

    const sortedRecords = recordsWithWeight.sort((a, b) => new Date(a.date) - new Date(b.date))
    const firstWeight = sortedRecords[0].weight
    const lastWeight = sortedRecords[sortedRecords.length - 1].weight

    return Math.max(0, firstWeight - lastWeight)
  }

  const getNormalBPDays = () => {
    const recentRecords = healthRecords
      .filter(r => r.bloodPressure?.systolic > 0)
      .slice(-7)

    return recentRecords.filter(r =>
      r.bloodPressure.systolic <= 140 && r.bloodPressure.diastolic <= 90
    ).length
  }

  const getNormalSugarDays = () => {
    const recentRecords = healthRecords
      .filter(r => r.bloodSugar > 0)
      .slice(-7)

    return recentRecords.filter(r => r.bloodSugar <= 7.0).length
  }

  const renderBadgeGrid = (category) => {
    const categoryBadges = badges.filter(badge =>
      category === 'all' || badge.category === category
    )

    return (
      <Row gutter={[16, 16]}>
        {categoryBadges.map(badge => (
          <Col xs={12} sm={8} md={6} key={badge.id}>
            <BadgeCard className={badge.earned ? 'earned' : 'locked'}>
              <div className={`badge-icon ${badge.earned ? 'earned' : 'locked'}`}>
                {badge.icon}
              </div>
              <div className="badge-title">{badge.name}</div>
              <div className="badge-description">{badge.description}</div>
              {badge.earned ? (
                <div style={{ textAlign: 'center', marginTop: 12 }}>
                  <Badge status="success" text="已获得" />
                </div>
              ) : (
                <div className="badge-progress">
                  <Progress
                    percent={Math.round(badge.progress)}
                    size="small"
                    strokeColor="#6366f1"
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {badge.requirement}
                  </Text>
                </div>
              )}
            </BadgeCard>
          </Col>
        ))}
      </Row>
    )
  }

  const renderLevelCard = () => (
    <LevelCard>
      <div className="level-icon">
        <CrownOutlined />
      </div>
      {stats.levelUnavailable ? (
        <>
          <Title level={3} className="level-title">积分与等级待启用</Title>
          <div className="level-description">P1 数据表建成后开放</div>
          <div style={{ marginTop: 16 }}>
            <Text style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: 13 }}>{stats.levelNote}</Text>
          </div>
        </>
      ) : (
        <>
          <Title level={3} className="level-title">
            等级 {stats.currentLevel}
          </Title>
          <div className="level-description">
            {userLevel?.levelName || userLevel?.title || '健康新手'}
          </div>
          <div style={{ marginTop: 16 }}>
            <Progress
              percent={Math.round(userLevel?.progress || 0)}
              strokeColor="rgba(255, 255, 255, 0.8)"
              trailColor="rgba(255, 255, 255, 0.2)"
            />
            <Text style={{ color: 'rgba(255, 255, 255, 0.8)' }}>
              距离下一级还需 {stats.nextLevelExp} 经验
            </Text>
          </div>
        </>
      )}
    </LevelCard>
  )

  const renderStats = () => (
    <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="已获得勋章"
            value={stats.earnedCount}
            suffix={`/ ${stats.totalCount}`}
            prefix={<TrophyOutlined style={{ color: '#f59e0b' }} />}
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="完成度"
            value={stats.completionRate}
            suffix="%"
            prefix={<AimOutlined style={{ color: '#6366f1' }} />}
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="当前等级"
            value={stats.levelUnavailable ? '待启用' : stats.currentLevel}
            prefix={<CrownOutlined style={{ color: '#8b5cf6' }} />}
          />
        </StatsCard>
      </Col>
      <Col xs={12} sm={6}>
        <StatsCard>
          <Statistic
            title="连续天数"
            value={getConsecutiveDays()}
            suffix="天"
            prefix={<FireOutlined style={{ color: '#ef4444' }} />}
          />
        </StatsCard>
      </Col>
    </Row>
  )

  const renderRecentBadges = () => {
    const recentBadges = [...userBadges]
      .sort((a, b) => new Date(b.earnedDate) - new Date(a.earnedDate))
      .slice(0, 5)

    if (recentBadges.length === 0) {
      return <Empty description="暂无获得的勋章" />
    }

    return (
      <Timeline
        items={recentBadges.map(badge => {
          const badgeInfo = allBadges.find(b => b.id === (badge.id || badge.badgeId || badge.badgeType))
          return {
            key: badge.id,
            dot: <TrophyOutlined style={{ color: '#f59e0b' }} />,
            children: (
              <div>
                <Text strong>{badgeInfo?.name || badge.badgeType}</Text>
                <br />
                <Text type="secondary">
                  {new Date(badge.earnedDate).toLocaleDateString()}
                </Text>
              </div>
            )
          }
        })}
      />
    )
  }

  return (
    <PageContainer>
      <Title level={2}>
        <TrophyOutlined style={{ color: '#6366f1', marginRight: 8 }} />
        成就勋章
      </Title>
      <Paragraph type="secondary" style={{ fontSize: 16 }}>
        完成健康任务，获得专属勋章，提升健康等级
      </Paragraph>

      {renderLevelCard()}
      {renderStats()}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        size="large"
        items={[
          { key: 'badges', label: '全部勋章', children: renderBadgeGrid('all') },
          { key: 'milestone', label: '里程碑', children: renderBadgeGrid('milestone') },
          { key: 'streak', label: '坚持记录', children: renderBadgeGrid('streak') },
          { key: 'exercise', label: '运动成就', children: renderBadgeGrid('exercise') },
          { key: 'health', label: '健康指标', children: renderBadgeGrid('health') },
          {
            key: 'recent',
            label: '最近获得',
            children: (
              <Card title="最近获得的勋章" style={{ borderRadius: 12 }}>
                {renderRecentBadges()}
              </Card>
            ),
          },
        ]}
      />
    </PageContainer>
  )
}

export default BadgePage