/**
 * 迈康 MyCare · 语音交互 Hook
 *
 * 语音输入：Web Speech API（SpeechRecognition），Chrome / Edge 支持最佳
 * 语音输出：SpeechSynthesis，全平台支持
 * 两者共同构成适老化「多模态交互」中的语音通道。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : undefined

export const speechInputSupported = Boolean(SpeechRecognitionImpl)
export const speechOutputSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

export function useSpeech({ lang = 'zh-CN', onResult, onEnd } = {}) {
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState(null)

  const recognitionRef = useRef(null)
  const finalTextRef = useRef('')

  // 每次渲染都拿到最新的回调，避免闭包过期
  const resultRef = useRef(onResult)
  const endRef = useRef(onEnd)
  useEffect(() => {
    resultRef.current = onResult
    endRef.current = onEnd
  })

  useEffect(() => {
    if (!SpeechRecognitionImpl) return undefined

    const recognition = new SpeechRecognitionImpl()
    recognition.lang = lang
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setListening(true)
      setError(null)
      finalTextRef.current = ''
      setInterim('')
    }

    recognition.onresult = (event) => {
      let interimText = ''
      let finalText = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        if (result.isFinal) finalText += result[0].transcript
        else interimText += result[0].transcript
      }
      if (finalText) finalTextRef.current += finalText
      setInterim(finalTextRef.current + interimText)
      if (finalText) resultRef.current?.(finalTextRef.current.trim(), false)
    }

    recognition.onerror = (event) => {
      const map = {
        'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏左侧允许麦克风访问',
        'no-speech': '没有检测到语音，请再说一次',
        'audio-capture': '未找到可用的麦克风设备',
        network: '语音识别服务网络异常',
      }
      setError(map[event.error] || `语音识别出错：${event.error}`)
      setListening(false)
    }

    recognition.onend = () => {
      setListening(false)
      const text = finalTextRef.current.trim()
      if (text) resultRef.current?.(text, true)
      setInterim('')
      endRef.current?.(text)
    }

    recognitionRef.current = recognition
    return () => {
      try {
        recognition.abort()
      } catch {
        /* ignore */
      }
      recognitionRef.current = null
    }
  }, [lang])

  const start = useCallback(() => {
    if (!recognitionRef.current) {
      setError('当前浏览器不支持语音输入，建议使用 Chrome 或 Edge')
      return
    }
    if (speechOutputSupported) window.speechSynthesis.cancel()
    try {
      recognitionRef.current.start()
    } catch {
      // 已经在监听中，忽略
    }
  }, [])

  const stop = useCallback(() => {
    try {
      recognitionRef.current?.stop()
    } catch {
      /* ignore */
    }
  }, [])

  const toggle = useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  return {
    supported: speechInputSupported,
    listening,
    interim,
    error,
    start,
    stop,
    toggle,
    speaking,
    setSpeaking,
  }
}

/** 语音播报（独立函数式，便于在任意组件调用） */
export function speakText(text, { rate = 0.85, onEnd } = {}) {
  if (!speechOutputSupported || !text) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(String(text))
  utterance.lang = 'zh-CN'
  utterance.rate = rate
  utterance.onend = () => onEnd?.()
  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking() {
  if (speechOutputSupported) window.speechSynthesis.cancel()
}
