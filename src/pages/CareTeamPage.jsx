import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Modal, Skeleton, Space, Tag, Typography, message } from 'antd'
import styled from 'styled-components'
import {
  SafetyCertificateOutlined,
  StopOutlined,
  CheckCircleFilled,
  MedicineBoxOutlined,
  LockOutlined,
} from '@ant-design/icons'
import { useUser } from '../contexts/UserContext'
import { getCareTeam, setDoctorConsent } from '../services/patientApi'

const { Title, Text, Paragraph } = Typography

/**
 * 我的医疗团队 · 隐私授权页
 * ===========================================================================
 * 存在的原因：注册时患者与默认随访医生之间只建立**关联**，不产生授权。
 * 只有患者本人在本页点「同意」之后，医生端才能看到这位患者
 * （医生端唯一过滤条件 doctor_patient_relations.is_active = 1）。
 *
 * 边界：
 *   · 本页只读写「授权状态」，不展示、也不回传任何健康数据；
 *   · 授权可**随时撤回**，撤回后医生端立即不再返回该患者，
 *     患者已录入的数据不受任何影响（不删除、不改动）；
 *   · 授权给谁、撤回谁，完全由患者单方面决定，医生无法自行授予。
 */

const PageContainer = styled.div`
  padding: 24px;
  max-width: 900px;
  margin: 0 auto;
  font-size: ${(p) => (p.$elderly ? '18px' : '15px')};

  @media (max-width: 768px) {
    padding: 16px;
  }
`

const HeroCard = styled(Card)`
  border-radius: 16px;
  border: none;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  color: #fff;
  margin-bottom: 20px;
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.25);

  .ant-card-body {
    padding: 24px;
  }

  .hero-title {
    color: #fff !important;
    margin-bottom: 8px !important;
    font-size: ${(p) => (p.$elderly ? '26px' : '22px')} !important;
  }

  .hero-desc {
    color: rgba(255, 255, 255, 0.92);
    font-size: ${(p) => (p.$elderly ? '17px' : '15px')};
    line-height: 1.8;
    margin-bottom: 0;
  }
`

const DoctorCard = styled(Card)`
  border-radius: 16px;
  margin-bottom: 16px;
  border: 1px solid ${(p) => (p.$granted ? '#c7d2fe' : '#f0f0f0')};
  background: ${(p) => (p.$granted ? '#f8f9ff' : '#fff')};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);

  .ant-card-body {
    padding: 20px;
  }
`

const DoctorRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;

  .doc-avatar {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    color: #fff;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    flex-shrink: 0;
  }

  .doc-meta {
    flex: 1;
    min-width: 180px;
  }

  .doc-name {
    font-size: ${(p) => (p.$elderly ? '21px' : '18px')};
    font-weight: 600;
    color: #1f2233;
    margin-bottom: 4px;
  }

  .doc-sub {
    color: #6b7280;
    font-size: ${(p) => (p.$elderly ? '16px' : '14px')};
  }
`

const LargeButton = styled(Button)`
  && {
    height: ${(p) => (p.$elderly ? '52px' : '44px')};
    font-size: ${(p) => (p.$elderly ? '18px' : '16px')};
    padding: 0 24px;
    border-radius: 12px;
    font-weight: 600;
  }
`

const FooterNote = styled.div`
  margin-top: 24px;
  padding: 18px 20px;
  border-radius: 14px;
  background: #f5f3ff;
  border: 1px solid #ddd6fe;

  .note-title {
    font-weight: 600;
    color: #5b21b6;
    display: block;
    margin-bottom: 8px;
    font-size: ${(p) => (p.$elderly ? '17px' : '15px')};
  }

  ul {
    margin: 0;
    padding-left: 20px;
    color: #4c1d95;
    line-height: 1.9;
    font-size: ${(p) => (p.$elderly ? '16px' : '14px')};
  }
`

const CareTeamPage = () => {
  const { user, elderlyMode } = useUser()
  const patientId = user?.user_id || user?.patient_id || null

  const [doctors, setDoctors] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null)

  const load = useCallback(async () => {
    if (!patientId) {
      setLoading(false)
      setError('未识别到当前患者身份，请重新登录后再试。')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await getCareTeam(patientId)
      setDoctors(data.doctors || [])
    } catch (err) {
      setDoctors([])
      setError(err?.message || '读取医疗团队失败')
    } finally {
      setLoading(false)
    }
  }, [patientId])

  useEffect(() => {
    load()
  }, [load])

  const applyConsent = async (doctor, granted) => {
    setPending(doctor.doctorId)
    try {
      await setDoctorConsent(patientId, doctor.doctorId, granted)
      message.success(
        granted ? `已同意 ${doctor.name} 查看您的健康档案` : `已停止 ${doctor.name} 的查看权限`
      )
      await load()
    } catch (err) {
      message.error(err?.message || '操作失败，请稍后再试')
    } finally {
      setPending(null)
    }
  }

  const handleGrant = (doctor) => applyConsent(doctor, true)

  const handleRevoke = (doctor) => {
    Modal.confirm({
      title: `停止让 ${doctor.name} 查看您的档案？`,
      content:
        '停止后，医生端的患者列表中将不再显示您，医生无法再查看您的健康记录。您已记录的数据不会被删除，随时可以重新同意。',
      okText: '确定停止',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: () => applyConsent(doctor, false),
    })
  }

  return (
    <PageContainer $elderly={elderlyMode}>
      <HeroCard $elderly={elderlyMode}>
        <Title level={2} className="hero-title">
          <SafetyCertificateOutlined style={{ marginRight: 10 }} />
          我的医疗团队
        </Title>
        <Paragraph className="hero-desc">
          这里决定<strong>哪位医生可以看到您的健康档案</strong>。
          <br />
          只有您点过「同意」的医生才能查看；您随时可以停止授权。
        </Paragraph>
      </HeroCard>

      {loading ? (
        <Card style={{ borderRadius: 16 }}>
          <Skeleton active paragraph={{ rows: 3 }} />
        </Card>
      ) : error ? (
        <Alert type="error" showIcon message="无法读取医疗团队" description={error} />
      ) : doctors.length === 0 ? (
        <Empty description="暂无可用医生" />
      ) : (
        doctors.map((doctor) => (
          <DoctorCard key={doctor.doctorId} $granted={doctor.granted} $elderly={elderlyMode}>
            <DoctorRow $elderly={elderlyMode}>
              <div className="doc-avatar">
                <MedicineBoxOutlined />
              </div>
              <div className="doc-meta">
                <div className="doc-name">
                  {doctor.name}
                  {doctor.granted && (
                    <Tag color="success" style={{ marginLeft: 10, fontSize: elderlyMode ? 15 : 13 }}>
                      <CheckCircleFilled /> 已允许查看
                    </Tag>
                  )}
                  {!doctor.granted && (
                    <Tag style={{ marginLeft: 10, fontSize: elderlyMode ? 15 : 13 }}>未授权</Tag>
                  )}
                </div>
                <div className="doc-sub">
                  {[doctor.title, doctor.department].filter(Boolean).join(' · ') || '医生'}
                </div>
              </div>
              <Space>
                {doctor.granted ? (
                  <LargeButton
                    $elderly={elderlyMode}
                    danger
                    icon={<StopOutlined />}
                    loading={pending === doctor.doctorId}
                    onClick={() => handleRevoke(doctor)}
                  >
                    停止授权
                  </LargeButton>
                ) : (
                  <LargeButton
                    $elderly={elderlyMode}
                    type="primary"
                    icon={<SafetyCertificateOutlined />}
                    loading={pending === doctor.doctorId}
                    onClick={() => handleGrant(doctor)}
                  >
                    同意医生查看
                  </LargeButton>
                )}
              </Space>
            </DoctorRow>
          </DoctorCard>
        ))
      )}

      <FooterNote $elderly={elderlyMode}>
        <span className="note-title">
          <LockOutlined style={{ marginRight: 8 }} />
          关于您的隐私
        </span>
        <ul>
          <li>未点「同意」之前，医生在医生端看不到您，也看不到您的任何记录。</li>
          <li>停止授权后，医生立即无法查看；您已经记录的数据不会被删除。</li>
          <li>是否授权只由您本人决定，医生不能替您打开这个开关。</li>
        </ul>
      </FooterNote>
    </PageContainer>
  )
}

export default CareTeamPage
