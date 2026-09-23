/**
 * 多模态识别面板
 * 上传药盒 / 化验单照片 → OCR 提取文字 → 多模态识别智能体解读 → 结构化展示
 * 无网络或 OCR 不可用时，自动降级为「手动输入关键信息」
 */
import React, { useState } from 'react'
import { Upload, Button, Alert, Tag, Space, Input, Progress, Empty, Typography, Divider } from 'antd'
import styled from 'styled-components'
import {
  UploadOutlined,
  ScanOutlined,
  BulbOutlined,
  WarningOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons'
import { useAgent } from '../../contexts/AgentContext'
import { readImage } from '../../services/agentApi'
import { useUser } from '../../contexts/UserContext'

const { Text, Paragraph } = Typography

const Wrap = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 340px) minmax(0, 1fr);
  gap: 20px;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }
`

const Box = styled.div`
  background: #fff;
  border: 1px solid #f0f0f0;
  border-radius: 14px;
  padding: 16px;
`

const Preview = styled.div`
  margin-top: 12px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #f0f0f0;
  background: #fafafa;

  img {
    width: 100%;
    display: block;
    max-height: 240px;
    object-fit: contain;
  }
`

const ItemRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: ${(p) => (p.$abnormal ? '#fff7f7' : '#f8fafc')};
  border-left: 3px solid ${(p) => (p.$abnormal ? '#ef4444' : '#10b981')};
  margin-bottom: 8px;
`

const LABEL = {
  正常: { color: 'success', icon: <CheckCircleOutlined /> },
  偏高: { color: 'error', icon: <WarningOutlined /> },
  偏低: { color: 'warning', icon: <WarningOutlined /> },
  未知: { color: 'default', icon: <BulbOutlined /> },
}

const MODE_TEXT = {
  vision: '视觉大模型直读',
  'ocr+llm': 'OCR + 大模型解读',
  'vision-text': '视觉大模型（自由文本）',
  local: '本地规则引擎',
}

/** 动态加载 tesseract.js（CDN），失败则返回 null */
async function loadOcr() {
  if (window.Tesseract) return window.Tesseract
  await new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js'
    script.onload = resolve
    script.onerror = () => reject(new Error('OCR 引擎加载失败'))
    document.head.appendChild(script)
  })
  return window.Tesseract
}

const VisionPanel = () => {
  const { speak } = useAgent()
  const { user, voiceEnabled } = useUser()
  // 只上传 patient_id；档案由后端 dataProvider 自取（不再回传 context）
  const patientId = user?.user_id || user?.patient_id || null
  const [image, setImage] = useState(null)
  const [ocrText, setOcrText] = useState('')
  const [hint, setHint] = useState('')
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const handleFile = (file) => {
    setError(null)
    setResult(null)
    const reader = new FileReader()
    reader.onload = () => setImage(reader.result)
    reader.readAsDataURL(file)
    return false // 阻止 antd 自动上传
  }

  const runOcr = async () => {
    if (!image) return ''
    setStage('正在加载 OCR 引擎…')
    const Tesseract = await loadOcr()
    setStage('正在识别图像文字…')
    const {
      data: { text },
    } = await Tesseract.recognize(image, 'chi_sim+eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') setProgress(Math.round((m.progress || 0) * 100))
      },
    })
    setOcrText(text)
    return text
  }

  const handleAnalyze = async () => {
    if (!image && !ocrText.trim()) {
      setError('请先上传图片，或直接输入化验单上的文字')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    setProgress(0)

    let text = ocrText
    try {
      if (image && !ocrText.trim()) {
        text = await runOcr()
      }
    } catch (ocrErr) {
      // OCR 不可用不是致命错误，继续用已有文本
      setError(`${ocrErr.message}，已切换为「文字解读」模式，请把报告上的关键信息填到下方输入框。`)
    }

    try {
      setStage('多模态识别智能体正在解读…')
      const data = await readImage({
        image,
        ocrText: text,
        hint,
        patientId,
      })
      setResult(data)
      setStage('')
      if (voiceEnabled && data.summary) speak(data.summary)
    } catch (err) {
      setError(`解读失败：${err.message}`)
      setStage('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Wrap>
      <Box>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Upload.Dragger
            accept="image/*"
            maxCount={1}
            beforeUpload={handleFile}
            showUploadList={false}
          >
            <p className="ant-upload-drag-icon">
              <UploadOutlined style={{ color: '#6366f1' }} />
            </p>
            <p className="ant-upload-text">点击或拖拽上传照片</p>
            <p className="ant-upload-hint" style={{ fontSize: 12 }}>
              支持药盒、化验单、体检报告
            </p>
          </Upload.Dragger>

          {image && (
            <Preview>
              <img src={image} alt="待识别" />
            </Preview>
          )}

          <Input.TextArea
            value={ocrText}
            onChange={(e) => setOcrText(e.target.value)}
            placeholder="（可选）手动补充或修正文字，如：空腹血糖 7.8、收缩压 152、阿司匹林肠溶片 100mg"
            autoSize={{ minRows: 3, maxRows: 6 }}
          />

          <Input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="（可选）补充说明，如：这是我今早的化验单"
          />

          <Button
            type="primary"
            block
            size="large"
            icon={<ScanOutlined />}
            onClick={handleAnalyze}
            loading={busy}
          >
            {busy ? '识别中…' : '开始解读'}
          </Button>

          {busy && progress > 0 && (
            <div>
              <Progress percent={progress} size="small" strokeColor="#6366f1" />
              <Text type="secondary" style={{ fontSize: 12 }}>{stage}</Text>
            </div>
          )}
          {busy && progress === 0 && stage && <Text type="secondary" style={{ fontSize: 12 }}>{stage}</Text>}
        </Space>
      </Box>

      <Box>
        {error && (
          <Alert
            type="warning"
            showIcon
            message={error}
            style={{ borderRadius: 10, marginBottom: 16 }}
            closable
            onClose={() => setError(null)}
          />
        )}

        {!result && !error && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="上传一张报告或药盒照片，多模态识别智能体会告诉你每一项的含义"
            style={{ padding: '48px 0' }}
          />
        )}

        {result && (
          <div>
            <Space size={8} wrap style={{ marginBottom: 12 }}>
              <Tag color="purple">{result.docType || '图文识别'}</Tag>
              <Tag color="blue">{MODE_TEXT[result.mode] || result.mode}</Tag>
            </Space>

            {result.summary && (
              <>
                <Paragraph style={{ fontSize: 15, lineHeight: 1.75, color: '#1f2937' }}>
                  {result.summary}
                </Paragraph>
                <Divider style={{ margin: '12px 0' }} />
              </>
            )}

            {result.items?.length > 0 && (
              <>
                <Text strong style={{ fontSize: 15 }}>逐项解读</Text>
                <div style={{ marginTop: 10 }}>
                  {result.items.map((item, i) => {
                    const abnormal = item.status && item.status !== '正常'
                    const label = LABEL[item.status] || LABEL.未知
                    return (
                      <ItemRow key={i} $abnormal={abnormal}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: '#1f2937' }}>
                            {item.name}
                            {item.unit ? <Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>{item.unit}</Text> : null}
                          </div>
                          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
                            {item.value}
                            {item.reference ? ` · 参考范围 ${item.reference}` : ''}
                          </div>
                          {item.explain && (
                            <div style={{ fontSize: 12.5, color: '#9ca3af', marginTop: 4 }}>{item.explain}</div>
                          )}
                        </div>
                        <Tag color={label.color} icon={label.icon} style={{ margin: 0 }}>
                          {item.status}
                        </Tag>
                      </ItemRow>
                    )
                  })}
                </div>
              </>
            )}

            {result.recognized?.length > 0 && !result.items?.length && (
              <div style={{ marginTop: 12 }}>
                <Text strong>识别到的原文</Text>
                <ul style={{ marginTop: 8, paddingLeft: 20, color: '#4b5563' }}>
                  {result.recognized.map((r, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {result.suggestions?.length > 0 && (
              <>
                <Divider style={{ margin: '16px 0 12px' }} />
                <Text strong><BulbOutlined style={{ color: '#f59e0b', marginRight: 6 }} />建议</Text>
                <ul style={{ marginTop: 8, paddingLeft: 20, color: '#4b5563', lineHeight: 1.8 }}>
                  {result.suggestions.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </>
            )}

            {result.uncertain?.length > 0 && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 16, borderRadius: 10 }}
                message="未能确认的信息"
                description={result.uncertain.join('；')}
              />
            )}

            <Alert
              type="warning"
              showIcon
              icon={<WarningOutlined />}
              style={{ marginTop: 16, borderRadius: 10 }}
              message="识别结果仅供参考，请以医院报告单与医生诊断为准。"
            />
          </div>
        )}
      </Box>
    </Wrap>
  )
}

export default VisionPanel
