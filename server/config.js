/**
 * 迈康 MyCare · 服务端配置
 * 从项目根目录的 .env.local / .env 读取配置（零依赖的极简 dotenv 实现）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const rootDir = path.resolve(__dirname, '..')

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  const text = fs.readFileSync(file, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

// 优先级：真实环境变量 > .env.local > .env
const fileEnv = {
  ...parseEnvFile(path.join(rootDir, '.env')),
  ...parseEnvFile(path.join(rootDir, '.env.local')),
}

const env = (key, fallback) => process.env[key] ?? fileEnv[key] ?? fallback

export const config = {
  port: Number(env('PORT', 3001)),
  apiKey: env('DEEPSEEK_API_KEY', ''),
  baseUrl: String(env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')).replace(/\/+$/, ''),
  // DeepSeek 官方 2026-09-10 上线的 V4.1 Flash，原生多模态、性能/费用/速度全面优于 V4-Pro；
  // 旧名 deepseek-chat / deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍可调用，但请求已被路由到本模型。
  // 旧值 'deepseek-chat' 已下线，等价于 V4.1 Flash。
  model: env('DEEPSEEK_MODEL', 'deepseek-flash'),
  temperature: Number(env('DEEPSEEK_TEMPERATURE', 0.6)),
  timeoutMs: Number(env('DEEPSEEK_TIMEOUT_MS', 120000)),
  allowMockFallback: String(env('ALLOW_MOCK_FALLBACK', 'true')) !== 'false',

  // 可选：视觉模型（OpenAI 兼容接口）。未配置时图像解读走前端 OCR 通道。
  visionApiKey: env('VISION_API_KEY', ''),
  visionBaseUrl: String(env('VISION_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1')).replace(/\/+$/, ''),
  visionModel: env('VISION_MODEL', 'qwen3.8-max'),

  rootDir,
}

export const isModelConfigured = () => Boolean(config.apiKey)
