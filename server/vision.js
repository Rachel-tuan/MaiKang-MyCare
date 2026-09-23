/**
 * 迈康 MyCare · 多模态图像解读通道
 *
 * 三级降级策略：
 *   1. 配置了视觉模型（VISION_API_KEY）→ 直接把图像交给视觉大模型解读
 *   2. 未配置视觉模型但有文本模型   → 使用前端 OCR 结果，交给大模型做结构化解读
 *   3. 都没有                       → 本地规则解析 OCR 文本（纯离线可演示）
 */
import { config } from './config.js'
import { getAgent } from './agents/registry.js'
import { isModelConfigured, chat } from './deepseek.js'
import { searchHealthKnowledge } from './agents/tools.js'

const VISION_AGENT = getAgent('vision')

const OUTPUT_CONTRACT = `请严格按以下 JSON 结构输出，不要包含任何解释文字：
{
  "docType": "化验单/药品包装/体检报告/其他",
  "recognized": ["识别到的关键信息原文条目"],
  "items": [{"name":"指标或药品名","value":"数值或规格","reference":"参考范围","status":"正常/偏高/偏低/未知","explain":"通俗解释"}],
  "summary": "整体解读，150字以内，面向老年用户的口语化表达",
  "suggestions": ["建议1","建议2"],
  "uncertain": ["无法确认的信息"]
}`

function buildUserPrompt({ ocrText, hint, context }) {
  return [
    `用户档案：${JSON.stringify({
      age: context.user?.age,
      diseases: context.user?.disease_types,
      bmi: context.user?.bmi,
    })}`,
    hint ? `用户补充说明：${hint}` : '',
    ocrText
      ? `图像 OCR 识别文本（可能有错字，请结合常识纠正）：\n"""\n${ocrText.slice(0, 4000)}\n"""`
      : '用户上传了一张图片，请解读其内容。',
    OUTPUT_CONTRACT,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 调用 OpenAI 兼容的视觉接口 */
async function callVisionModel({ image, ocrText, hint, context }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await fetch(`${config.visionBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.visionApiKey}`,
      },
      body: JSON.stringify({
        model: config.visionModel,
        temperature: 0.3,
        messages: [
          { role: 'system', content: VISION_AGENT.systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: image } },
              { type: 'text', text: buildUserPrompt({ ocrText, hint, context }) },
            ],
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`视觉模型返回 ${res.status}`)
    const data = await res.json()
    return data?.choices?.[0]?.message?.content ?? ''
  } finally {
    clearTimeout(timer)
  }
}

/** 本地规则解析（离线兜底）：从 OCR 文本中抽取「指标名 + 数值 + 单位」 */
function localParse(ocrText = '', hint = '') {
  const text = `${hint}\n${ocrText}`
  const patterns = [
    { name: '收缩压/舒张压', re: /(\d{2,3})\s*\/\s*(\d{2,3})/, unit: 'mmHg', ref: '90-140 / 60-90', judge: (m) => (Number(m[1]) > 140 || Number(m[2]) > 90 ? '偏高' : '正常') },
    { name: '空腹血糖', re: /(?:血糖|GLU|空腹血糖)\D{0,6}(\d+(?:\.\d+)?)/i, unit: 'mmol/L', ref: '3.9-6.1（老年放宽至 7.0）', judge: (m) => (Number(m[1]) > 7 ? '偏高' : Number(m[1]) < 3.9 ? '偏低' : '正常') },
    { name: '总胆固醇', re: /(?:总胆固醇|TC|CHOL)\D{0,6}(\d+(?:\.\d+)?)/i, unit: 'mmol/L', ref: '<5.2', judge: (m) => (Number(m[1]) > 5.2 ? '偏高' : '正常') },
    { name: '甘油三酯', re: /(?:甘油三酯|TG)\D{0,6}(\d+(?:\.\d+)?)/i, unit: 'mmol/L', ref: '<1.7', judge: (m) => (Number(m[1]) > 1.7 ? '偏高' : '正常') },
    { name: '低密度脂蛋白', re: /(?:低密度脂蛋白|LDL)\D{0,6}(\d+(?:\.\d+)?)/i, unit: 'mmol/L', ref: '<3.4', judge: (m) => (Number(m[1]) > 3.4 ? '偏高' : '正常') },
    { name: '血红蛋白', re: /(?:血红蛋白|HGB|Hb)\D{0,6}(\d+(?:\.\d+)?)/i, unit: 'g/L', ref: '130-175', judge: (m) => (Number(m[1]) < 130 ? '偏低' : '正常') },
    { name: '尿酸', re: /(?:尿酸|UA)\D{0,6}(\d+(?:\.\d+)?)/i, unit: 'μmol/L', ref: '208-428', judge: (m) => (Number(m[1]) > 428 ? '偏高' : '正常') },
    { name: '肌酐', re: /(?:肌酐|Cr|CREA)\D{0,6}(\d+(?:\.\d+)?)/i, unit: 'μmol/L', ref: '57-97', judge: (m) => (Number(m[1]) > 97 ? '偏高' : '正常') },
  ]

  const items = []
  for (const p of patterns) {
    const m = text.match(p.re)
    if (m) {
      items.push({
        name: p.name,
        value: m[1] + (m[2] ? `/${m[2]}` : ''),
        reference: p.ref,
        status: p.judge(m),
        explain: '本地规则识别，建议配置视觉模型以获得更准确的解读。',
      })
    }
  }

  const abnormal = items.filter((i) => i.status !== '正常')
  const knowledge = abnormal.length ? searchHealthKnowledge(abnormal[0].name) : []

  return {
    docType: ocrText ? '化验单/报告（本地解析）' : '未能识别',
    recognized: items.length ? items.map((i) => `${i.name}：${i.value} ${i.unit || ''}`) : ['未从图像中提取到可识别指标'],
    items: items.map((i) => ({ ...i, unit: i.unit || '' })),
    summary: items.length
      ? `本地引擎共识别 ${items.length} 项指标，其中 ${abnormal.length} 项异常${
          abnormal.length ? `（${abnormal.map((a) => a.name).join('、')}）` : ''
        }。${knowledge.length ? `参考建议：${knowledge[0].content.slice(0, 80)}…` : ''}`
      : '未提取到有效的检验指标，建议重新拍摄或手动输入关键信息。',
    suggestions: abnormal.length
      ? ['携带原始报告就诊，由医生结合病史判断', '保持每日体征记录，便于观察变化']
      : ['各项指标在参考范围内，保持当前生活方式'],
    uncertain: items.length ? [] : ['图像清晰度不足或版式不标准，导致无法定位指标'],
    mode: 'local',
  }
}

export async function readImage({ image, ocrText = '', hint = '', context = {} }) {
  // 1) 视觉模型
  if (config.visionApiKey && image) {
    try {
      const content = await callVisionModel({ image, ocrText, hint, context })
      const parsed = safeJson(content)
      if (parsed) return { ...parsed, mode: 'vision' }
      return { ...localParse(ocrText, hint), summary: content, mode: 'vision-text' }
    } catch (err) {
      // 落到下一级
      if (isModelConfigured()) {
        /* continue */
      } else {
        return { ...localParse(ocrText, hint), warning: `视觉模型调用失败：${err.message}` }
      }
    }
  }

  // 2) 文本模型 + OCR
  if (isModelConfigured() && (ocrText || hint)) {
    try {
      const { content } = await chat({
        messages: [
          { role: 'system', content: VISION_AGENT.systemPrompt },
          { role: 'user', content: buildUserPrompt({ ocrText, hint, context }) },
        ],
        temperature: 0.3,
        jsonMode: true,
      })
      const parsed = safeJson(content)
      if (parsed) return { ...parsed, mode: 'ocr+llm' }
    } catch {
      /* 落到本地 */
    }
  }

  // 3) 本地
  return localParse(ocrText, hint)
}

function safeJson(text) {
  if (!text) return null
  let s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    const obj = JSON.parse(s)
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1))
      } catch {
        return null
      }
    }
    return null
  }
}
