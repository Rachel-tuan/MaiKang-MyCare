/**
 * 迈康 MyCare · 完善健康档案（「从 0 到 1」建档闭环）
 * ===========================================================================
 * 解决的问题：自助注册只写入最小身份信息（姓名 / 性别 / 出生日期 / 身高 / 手机 / 疾病），
 *   `patient_contacts` / `patient_lifestyle` / `patient_targets` / `medications`
 *   四类档案全空 —— 医生端「患者详情」没有紧急联系人、诊断分级、危险分层、生活画像、
 *   控制目标可展示，患者端「生活画像」也是空白，今日任务的个性化依据同样缺失。
 *
 * 本弹窗把注册后的空档案一次性补齐到**与示范病例同构**的程度，字段与医生端
 * 「患者详情」逐项对齐：
 *   ① 基本信息      → patients
 *   ② 紧急联系人    → patient_contacts（含「紧急时可通知」授权开关）
 *   ③ 疾病与用药    → patient_conditions + medications
 *   ④ 生活画像      → patient_lifestyle（AI 个性化建议的直接依据）
 *   ⑤ 控制目标      → patient_targets（患者自述初值，医生仍可调整）
 *
 * 红线：
 *   · 只提交档案字段，**不回传任何体征记录 / 评分 / 规则结论**；
 *   · 疾病分级与心血管危险分层标注为「初诊信息，以医生诊断为准」，
 *     属于医生侧表述，**不参与产品预警等级**；
 *   · 不在前端做任何阈值判断，全部落库后由后端规则引擎读取。
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  Modal,
  Steps,
  Form,
  Input,
  InputNumber,
  Select,
  Radio,
  Checkbox,
  Button,
  Space,
  Typography,
  Divider,
  Alert,
  message,
  Switch,
} from 'antd'
import {
  UserOutlined,
  PhoneOutlined,
  MedicineBoxOutlined,
  CoffeeOutlined,
  AimOutlined,
  PlusOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { updateProfile, addRecord } from '../../services/patientApi'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input

/** 疾病选项（值为库内中文规范病名，与示范病例一致） */
const DISEASE_OPTIONS = ['高血压', '糖尿病', '肥胖症', '高血脂', '冠心病']
/**
 * 心血管危险分层取值（医生侧字段，库内列 riskStratification）。
 * 这里是**医学侧**的分层表述，与产品预警等级（提示 / 关注 / 预警 / 紧急）严格分开，
 * 不得用于描述产品预警级别。
 */
const riskStratificationOptions = ['低危', '中危', '高危', '极高危']
/** 高血压分级（仅当主诊断含高血压时展示） */
const GRADE_OPTIONS = ['1 级', '2 级', '3 级', '未分级']
/** 常见合并症 */
const COMORBIDITY_OPTIONS = ['糖尿病', '高血脂', '冠心病', '肥胖症', '慢性肾病', '脑卒中后遗症']
/** 紧急联系人关系 */
const RELATION_OPTIONS = ['配偶', '儿子', '女儿', '父母', '兄弟姐妹', '其他亲属', '邻居 / 朋友']
/** 沟通风格（写出即成为智能体的人格偏好） */
const AI_STYLE_OPTIONS = [
  { value: '安抚 + 警示', label: '安抚 + 警示（先安慰，再提醒风险）' },
  { value: '共情 + 指导', label: '共情 + 指导（先理解，再给方法）' },
  { value: '鼓励 + 激励', label: '鼓励 + 激励（多表扬进步）' },
  { value: '简洁直接', label: '简洁直接（少说多做到）' },
]

const STEPS = [
  { title: '基本信息', icon: <UserOutlined /> },
  { title: '紧急联系人', icon: <PhoneOutlined /> },
  { title: '疾病与用药', icon: <MedicineBoxOutlined /> },
  { title: '生活画像', icon: <CoffeeOutlined /> },
  { title: '控制目标', icon: <AimOutlined /> },
]

/** 各步骤需要校验的字段（分步校验，避免「看不到的字段」挡住下一步） */
const STEP_FIELDS = [
  ['name', 'gender', 'age', 'height', 'weight', 'phone', 'occupation'],
  ['ecName', 'ecRelation', 'ecPhone'],
  ['diseases'],
  [],
  [],
]

/** 表单值 → 后端档案入参（唯一转换处，字段名在此一处对齐） */
function toPayload(values) {
  const payload = {
    identity: {
      name: values.name,
      gender: values.gender,
      age: values.age,
      height: values.height,
      phone: values.phone,
      occupation: values.occupation || null,
    },
    emergencyContact: {
      name: values.ecName,
      relation: values.ecRelation,
      phone: values.ecPhone,
      authorized: Boolean(values.ecAuthorized),
    },
    conditions: (values.diseases || []).map((d, i) => ({
      diseaseName: d,
      diseaseGrade: i === 0 ? values.diseaseGrade || null : null,
      durationText: i === 0 ? values.durationText || null : null,
      riskStratification: i === 0 ? values.riskStratification || null : null,
      comorbidities: (values.comorbidities || []).filter((c) => c !== d),
    })),
    lifestyle: {
      diet: values.diet || null,
      exercise: values.exercise || null,
      sleep: values.sleep || null,
      biggestDifficulty: values.biggestDifficulty || null,
      motivation: values.motivation || null,
      aiStyle: values.aiStyle || null,
    },
    targets: {
      systolic: values.systolic ?? null,
      diastolic: values.diastolic ?? null,
      fastingGlucose: values.fastingGlucose ?? null,
      bmi: values.bmi ?? null,
      waist: values.waist ?? null,
      steps: values.steps ?? null,
    },
    medications: (values.medications || [])
      .filter((m) => m && String(m.name || '').trim())
      .map((m) => ({
        name: String(m.name).trim(),
        dosage: m.dosage || null,
        frequency: m.frequency || null,
        time: m.time || null,
      })),
  }
  return payload
}

/** 已有档案 → 表单初值（再次打开时预填，不覆盖用户当前输入） */
function toFormValues(profile) {
  if (!profile) return {}
  const id = profile.identity || {}
  const ec = (profile.contacts || [])[0] || null
  const conds = profile.conditions || []
  const lf = profile.lifestyle || {}
  const tg = profile.targets || {}
  const primary = conds[0] || {}
  return {
    name: id.name,
    gender: id.gender === '女' ? 'female' : 'male',
    age: id.age ?? undefined,
    height: id.height ?? undefined,
    phone: id.phone || undefined,
    occupation: id.occupation || undefined,
    ecName: ec?.name || undefined,
    ecRelation: ec?.relation || undefined,
    ecPhone: ec?.phone || undefined,
    ecAuthorized: Boolean(ec?.authorized),
    diseases: conds.map((c) => c.diseaseName).filter(Boolean),
    diseaseGrade: primary.diseaseGrade || undefined,
    durationText: primary.durationText || undefined,
    riskStratification: primary.riskStratification || undefined,
    comorbidities: (primary.comorbidities || []).filter(Boolean),
    diet: lf.diet || undefined,
    exercise: lf.exercise || undefined,
    sleep: lf.sleep || undefined,
    biggestDifficulty: lf.biggestDifficulty || undefined,
    motivation: lf.motivation || undefined,
    aiStyle: lf.aiStyle || undefined,
    systolic: tg.systolicTarget ?? undefined,
    diastolic: tg.diastolicTarget ?? undefined,
    fastingGlucose: tg.fastingGlucoseTarget ?? undefined,
    bmi: tg.bmiTarget ?? undefined,
    waist: tg.waistTarget ?? undefined,
    steps: tg.stepsTarget ?? undefined,
    medications: (profile.medications || []).map((m) => ({
      name: m.name,
      dosage: m.dosage,
      frequency: m.frequency,
      time: m.time,
    })),
  }
}

const ProfileSetupModal = ({ open, onClose, patientId, profile, onSaved }) => {
  const [form] = Form.useForm()
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)

  const initial = useMemo(() => toFormValues(profile), [profile])

  useEffect(() => {
    if (open) {
      setStep(0)
      form.setFieldsValue(initial)
    }
  }, [open, initial, form])

  const diseases = Form.useWatch('diseases', form) || []
  const hasHypertension = diseases.some((d) => String(d).includes('高血压'))
  const hasDiabetes = diseases.some((d) => String(d).includes('糖尿病'))
  const hasObesity = diseases.some((d) => String(d).includes('肥胖'))

  const next = async () => {
    const fields = STEP_FIELDS[step] || []
    try {
      if (fields.length) await form.validateFields(fields)
      setStep((s) => Math.min(s + 1, STEPS.length - 1))
    } catch {
      /* 校验失败：antd 已在字段下方提示 */
    }
  }

  const prev = () => setStep((s) => Math.max(s - 1, 0))

  /** 保存：先补齐档案，再把「本次填写的体重」落成今天的第一条健康记录 */
  const handleSave = async () => {
    let values
    try {
      values = await form.validateFields(['name', 'gender', 'age', 'height', 'phone', 'ecName', 'ecPhone', 'diseases'])
    } catch {
      message.warning('请先补全必填项：姓名 / 性别 / 年龄 / 身高 / 手机号 / 紧急联系人 / 疾病')
      return
    }
    const all = form.getFieldsValue(true)
    setSaving(true)
    try {
      const result = await updateProfile(patientId, toPayload({ ...all, ...values }))
      let weightSaved = false
      if (all.weight) {
        try {
          await addRecord(patientId, { weight: Number(all.weight) })
          weightSaved = true
        } catch {
          /* 体重写入失败不阻断建档 */
        }
      }
      message.success(`健康档案已保存：${(result.applied || []).length} 类档案已写入数据库${weightSaved ? '，体重已记为今天的第一条数据' : ''}`)
      if (typeof onSaved === 'function') onSaved(result)
      onClose?.()
    } catch (error) {
      message.error(`保存失败：${error.message || '请重试'}`)
    } finally {
      setSaving(false)
    }
  }

  const bodyStyle = { minHeight: 330 }
  const inputSize = 'large'

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={760}
      maskClosable={false}
      destroyOnClose
      title={
        <Space>
          <UserOutlined style={{ color: '#6366f1' }} />
          <span style={{ fontSize: 18 }}>完善健康档案</span>
        </Space>
      }
      footer={
        <Space>
          <Button size="large" onClick={onClose} disabled={saving}>
            稍后再填
          </Button>
          {step > 0 && (
            <Button size="large" onClick={prev} disabled={saving}>
              上一步
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button size="large" type="primary" onClick={next}>
              下一步
            </Button>
          ) : (
            <Button
              size="large"
              type="primary"
              loading={saving}
              onClick={handleSave}
              style={{ background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)', border: 'none' }}
            >
              保存档案
            </Button>
          )}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ borderRadius: 10, marginBottom: 14 }}
        message="为什么要填这些？"
        description={
          <span style={{ fontSize: 13 }}>
            这些信息会直接决定：医生端「患者详情」能看到什么、智能体给出的运动 / 饮食 / 用药建议是否贴合您本人、
            以及今日任务里监测频次与目标是否合理。<Text strong>只填一次，之后可随时在「我的 → 我的健康档案」里修改。</Text>
          </span>
        }
      />

      <Steps
        current={step}
        size="small"
        items={STEPS.map((s) => ({ title: s.title, icon: s.icon }))}
        style={{ marginBottom: 18 }}
      />

      <Form form={form} layout="vertical" size={inputSize} initialValues={initial} style={bodyStyle}>
        {/* ------------------------- ① 基本信息 ------------------------- */}
        <div style={{ display: step === 0 ? 'block' : 'none' }}>
          <Form.Item label="姓名" name="name" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input placeholder="请输入真实姓名" size={inputSize} />
          </Form.Item>
          <Form.Item label="性别" name="gender" rules={[{ required: true, message: '请选择性别' }]}>
            <Radio.Group size={inputSize}>
              <Radio value="male">男</Radio>
              <Radio value="female">女</Radio>
            </Radio.Group>
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item
              label="年龄"
              name="age"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请输入年龄' }, { type: 'number', min: 40, max: 120, message: '请输入 40–120 之间的年龄' }]}
            >
              <InputNumber min={40} max={120} style={{ width: '100%' }} placeholder="岁" />
            </Form.Item>
            <Form.Item
              label="身高 (cm)"
              name="height"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请输入身高' }, { type: 'number', min: 100, max: 250, message: '请输入 100–250 之间的身高' }]}
            >
              <InputNumber min={100} max={250} style={{ width: '100%' }} placeholder="cm" />
            </Form.Item>
            <Form.Item label="体重 (kg)" name="weight" style={{ flex: 1 }}>
              <InputNumber min={30} max={200} style={{ width: '100%' }} placeholder="选填，会记为今天的数据" />
            </Form.Item>
          </Space>
          <Form.Item
            label="手机号"
            name="phone"
            rules={[{ required: true, message: '请输入手机号' }, { pattern: /^1\d{10}$/, message: '请输入 11 位手机号' }]}
          >
            <Input placeholder="用于找回密码与医生联系" size={inputSize} />
          </Form.Item>
          <Form.Item label="职业（选填）" name="occupation">
            <Input placeholder="如：退休教师" size={inputSize} />
          </Form.Item>
        </div>

        {/* ------------------------- ② 紧急联系人 ------------------------- */}
        <div style={{ display: step === 1 ? 'block' : 'none' }}>
          <Form.Item label="联系人姓名" name="ecName" rules={[{ required: true, message: '请输入紧急联系人姓名' }]}>
            <Input placeholder="如：张伟" size={inputSize} />
          </Form.Item>
          <Form.Item label="与您的关系" name="ecRelation">
            <Select placeholder="请选择" size={inputSize} allowClear options={RELATION_OPTIONS.map((r) => ({ value: r, label: r }))} />
          </Form.Item>
          <Form.Item
            label="联系电话"
            name="ecPhone"
            rules={[{ required: true, message: '请输入紧急联系人电话' }, { pattern: /^\d{7,15}$/, message: '请输入有效的联系电话' }]}
          >
            <Input placeholder="用于紧急情况联系" size={inputSize} />
          </Form.Item>
          <Form.Item
            label="允许在紧急情况通知该联系人"
            name="ecAuthorized"
            valuePropName="checked"
            extra="关闭时，系统只记录风险，不会自动外发通知；开启后仍需您本人在预警卡片上确认才会真正外发。"
          >
            <Switch checkedChildren="已授权" unCheckedChildren="未授权" />
          </Form.Item>
        </div>

        {/* ------------------------- ③ 疾病与用药 ------------------------- */}
        <div style={{ display: step === 2 ? 'block' : 'none' }}>
          <Form.Item
            label="已确诊的慢性病（第一项视为主诊断）"
            name="diseases"
            rules={[{ required: true, message: '请至少选择一项慢性病' }]}
          >
            <Select
              mode="multiple"
              size={inputSize}
              placeholder="请选择"
              allowClear
              options={DISEASE_OPTIONS.map((d) => ({ value: d, label: d }))}
            />
          </Form.Item>

          {hasHypertension && (
            <Form.Item label="高血压分级（初诊信息，以医生诊断为准）" name="diseaseGrade">
              <Select size={inputSize} placeholder="请选择" allowClear options={GRADE_OPTIONS.map((g) => ({ value: g, label: g }))} />
            </Form.Item>
          )}

          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item label="病程" name="durationText" style={{ flex: 1 }}>
              <Input placeholder="如：8 年" size={inputSize} />
            </Form.Item>
            <Form.Item
              label="心血管危险分层（医生侧表述）"
              name="riskStratification"
              style={{ flex: 1 }}
              extra="与产品预警等级（提示 / 关注 / 预警 / 紧急）不是同一套口径。"
            >
              <Select size={inputSize} placeholder="请选择" allowClear options={riskStratificationOptions.map((r) => ({ value: r, label: r }))} />
            </Form.Item>
          </Space>

          <Form.Item label="合并症（可多选）" name="comorbidities">
            <Select
              mode="multiple"
              size={inputSize}
              placeholder="没有可留空"
              allowClear
              options={COMORBIDITY_OPTIONS.map((c) => ({ value: c, label: c }))}
            />
          </Form.Item>

          <Divider plain style={{ margin: '8px 0 14px' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              正在服用的药物（用于生成服药任务与提醒）
            </Text>
          </Divider>

          <Form.List name="medications">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }) => (
                  <Space key={key} align="baseline" style={{ display: 'flex', marginBottom: 8 }} size={8}>
                    <Form.Item {...rest} name={[name, 'name']} style={{ marginBottom: 0, width: 180 }}>
                      <Input placeholder="药名，如 氨氯地平" />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'dosage']} style={{ marginBottom: 0, width: 110 }}>
                      <Input placeholder="剂量 5mg" />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'time']} style={{ marginBottom: 0, width: 110 }}>
                      <Input placeholder="时间 08:00" />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'frequency']} style={{ marginBottom: 0, width: 130 }}>
                      <Input placeholder="频次 每日一次" />
                    </Form.Item>
                    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(name)} />
                  </Space>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add()}>
                  添加一种药物
                </Button>
              </>
            )}
          </Form.List>
        </div>

        {/* ------------------------- ④ 生活画像 ------------------------- */}
        <div style={{ display: step === 3 ? 'block' : 'none' }}>
          <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
            生活画像是六个智能体给出「个性化」建议的直接依据 —— 例如写「口味偏咸，爱吃腌菜」，
            方案规划智能体会给出「先减少约 1/4 的腌制食品，用葱姜蒜和醋提味」这类能照做的建议，而不是笼统的「控制饮食」。
          </Paragraph>
          <Form.Item label="饮食习惯" name="diet">
            <TextArea rows={2} placeholder="如：口味偏咸，日均食盐约 10 g，爱吃腌菜" />
          </Form.Item>
          <Form.Item label="运动习惯" name="exercise">
            <TextArea rows={2} placeholder="如：偶尔散步，无固定运动习惯" />
          </Form.Item>
          <Form.Item label="睡眠情况" name="sleep">
            <TextArea rows={2} placeholder="如：入睡偏晚，日均约 6 小时" />
          </Form.Item>
          <Form.Item label="目前最大的困难" name="biggestDifficulty">
            <Input placeholder="如：担心血压控制不住 / 难以坚持" size={inputSize} />
          </Form.Item>
          <Form.Item label="您的动力是什么" name="motivation">
            <Input placeholder="如：怕给子女添麻烦 / 想减少用药" size={inputSize} />
          </Form.Item>
          <Form.Item label="希望智能体怎么和您说话" name="aiStyle">
            <Select size={inputSize} placeholder="请选择" allowClear options={AI_STYLE_OPTIONS} />
          </Form.Item>
        </div>

        {/* ------------------------- ⑤ 控制目标 ------------------------- */}
        <div style={{ display: step === 4 ? 'block' : 'none' }}>
          <Alert
            type="warning"
            showIcon
            style={{ borderRadius: 10, marginBottom: 14 }}
            message="这里的数值是您自述的初始控制目标"
            description={
              <span style={{ fontSize: 13 }}>
                系统会用它计算达标率与任务目标。<Text strong>它不改变任何医学判定阈值</Text>
                ——医生给您的控制目标以医院诊断为准，签约医生后续可在「今日任务」中为您的目标做调整。
              </span>
            }
          />
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item label="收缩压目标 (mmHg)" name="systolic" style={{ flex: 1 }} hidden={!hasHypertension && !hasDiabetes}>
              <InputNumber min={90} max={200} style={{ width: '100%' }} placeholder="如 140" />
            </Form.Item>
            <Form.Item label="舒张压目标 (mmHg)" name="diastolic" style={{ flex: 1 }} hidden={!hasHypertension && !hasDiabetes}>
              <InputNumber min={50} max={130} style={{ width: '100%' }} placeholder="如 90" />
            </Form.Item>
          </Space>
          <Form.Item label="空腹血糖目标 (mmol/L)" name="fastingGlucose" hidden={!hasDiabetes}>
            <InputNumber min={4} max={15} step={0.1} style={{ width: '100%' }} placeholder="如 7.8" />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item label="BMI 目标" name="bmi" style={{ flex: 1 }} hidden={!hasObesity}>
              <InputNumber min={15} max={40} step={0.5} style={{ width: '100%' }} placeholder="如 28" />
            </Form.Item>
            <Form.Item label="腰围目标 (cm)" name="waist" style={{ flex: 1 }} hidden={!hasObesity}>
              <InputNumber min={50} max={160} style={{ width: '100%' }} placeholder="如 90" />
            </Form.Item>
          </Space>
          <Form.Item label="每日步数目标（会写入今日任务）" name="steps">
            <InputNumber min={1000} max={20000} step={500} style={{ width: '100%' }} placeholder="如 8000" />
          </Form.Item>
          <Paragraph type="secondary" style={{ fontSize: 12.5 }}>
            血压 / 血糖 / 体重 / 步数的达标率与预警等级，全部由项目内确定性规则计算；
            智能体只负责解释结果，不会替您改写目标数值。
          </Paragraph>
        </div>
      </Form>
    </Modal>
  )
}

export default ProfileSetupModal
