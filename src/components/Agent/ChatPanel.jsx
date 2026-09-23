/**
 * 智能体对话面板
 * 支持：多智能体切换、语音输入（ASR）、语音播报（TTS）、工具调用轨迹展示
 */
import React, { useEffect, useRef, useState } from 'react'
import { Avatar, Button, Input, Space, Tag, Tooltip, Empty, Alert, Switch } from 'antd'
import styled from 'styled-components'
import {
  SendOutlined,
  AudioOutlined,
  SoundOutlined,
  ApiOutlined,
  RobotOutlined,
  UserOutlined,
  DeleteOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import { useAgent } from '../../contexts/AgentContext'
import { useUser } from '../../contexts/UserContext'
import { useSpeech } from '../../hooks/useSpeech'
import TaskProposalCard from './TaskProposalCard'

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  height: 620px;
  border-radius: 16px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  overflow: hidden;

  @media (max-width: 768px) {
    height: 520px;
  }
`

const AgentBar = styled.div`
  display: flex;
  gap: 8px;
  padding: 12px;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
  overflow-x: auto;
`

const AgentChip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1.5px solid ${(p) => (p.$active ? p.$color : '#e5e7eb')};
  background: ${(p) => (p.$active ? `${p.$color}14` : '#fff')};
  color: ${(p) => (p.$active ? p.$color : '#6b7280')};
  font-size: 13px;
  font-weight: ${(p) => (p.$active ? 700 : 500)};
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.25s ease;

  &:hover {
    border-color: ${(p) => p.$color};
    color: ${(p) => p.$color};
  }
`

const Messages = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;

  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb { background: #e5e7eb; border-radius: 3px; }
`

const Row = styled.div`
  display: flex;
  gap: 10px;
  align-items: flex-start;
  flex-direction: ${(p) => (p.$mine ? 'row-reverse' : 'row')};
`

const Bubble = styled.div`
  max-width: 78%;
  padding: 12px 16px;
  border-radius: ${(p) => (p.$mine ? '16px 16px 4px 16px' : '16px 16px 16px 4px')};
  background: ${(p) => (p.$mine ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : '#fff')};
  color: ${(p) => (p.$mine ? '#fff' : '#1f2937')};
  font-size: 15px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  box-shadow: ${(p) => (p.$mine ? 'none' : '0 2px 8px rgba(0,0,0,0.06)')};
  border: 1px solid ${(p) => (p.$error ? '#fecaca' : 'transparent')};
`

const ToolTrace = styled.div`
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #e5e7eb;
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const InputBar = styled.div`
  padding: 12px;
  background: #fff;
  border-top: 1px solid #f0f0f0;
`

const Hint = styled.div`
  font-size: 12px;
  color: #9ca3af;
  margin-top: 6px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`

const QUICK = {
  steward: ['我今天的健康状况怎么样？', '帮我安排今天的健康任务', '最近哪些指标需要重点关注？'],
  vitals: ['分析我最近一周的血压趋势', '我的血糖控制得怎么样？', '步数达标率如何？'],
  sentinel: ['我现在有风险吗？', '哪些指标达到了危险值？', '需要通知家属吗？'],
  planner: ['我膝盖疼，8000 步走不下来', '给我一份本周运动计划', '高血压饮食该怎么调整？'],
  vision: ['帮我解读这张化验单', '看看这个药怎么吃'],
  companion: ['我最近心里有点烦', '感觉坚持不下去了', '夸夸我'],
}

const ChatPanel = ({ defaultAgentId = 'steward' }) => {
  const { agents, chats, sendMessage, clearChat, speak } = useAgent()
  const { voiceEnabled } = useUser()
  const [agentId, setAgentId] = useState(defaultAgentId)
  const [input, setInput] = useState('')
  const [autoSpeak, setAutoSpeak] = useState(false)
  const [sending, setSending] = useState(false)
  const listRef = useRef(null)
  const abortRef = useRef(null)

  const messages = chats[agentId] || []
  const agent = agents.find((a) => a.id === agentId)

  const { supported, listening, interim, error: speechError, toggle } = useSpeech({
    onResult: (text, isFinal) => {
      setInput(text)
      if (isFinal) setInput(`${text} `)
    },
  })

  // 自动滚到底部
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages.length, messages[messages.length - 1]?.content, agentId])

  // 语音播报最新一条助手回复
  useEffect(() => {
    if (!autoSpeak || !voiceEnabled) return
    const last = messages[messages.length - 1]
    if (last && last.role === 'assistant' && last.content && !last.streaming) {
      speak(last.content)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, messages[messages.length - 1]?.streaming, autoSpeak])

  const handleSend = (text) => {
    const content = (text ?? input).trim()
    if (!content || sending) return
    setInput('')
    setSending(true)
    abortRef.current = sendMessage(agentId, content)
    setTimeout(() => setSending(false), 400)
  }

  const streaming = messages.some((m) => m.streaming)

  return (
    <Panel>
      <AgentBar>
        {agents.map((a) => (
          <AgentChip
            key={a.id}
            $active={a.id === agentId}
            $color={a.color}
            onClick={() => setAgentId(a.id)}
          >
            <span>{a.icon}</span>
            {a.name.replace('智能体', '')}
          </AgentChip>
        ))}
      </AgentBar>

      <Messages ref={listRef}>
        {messages.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 460 }}>
            <Avatar
              size={64}
              style={{ background: `${agent?.color || '#6366f1'}1a`, fontSize: 30, marginBottom: 12 }}
            >
              {agent?.icon || '🤖'}
            </Avatar>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#1f2937' }}>
              {agent?.name || '智能体'}
            </div>
            <div style={{ fontSize: 13.5, color: '#6b7280', marginTop: 6, lineHeight: 1.6 }}>
              {agent?.summary}
            </div>
            {agent?.capability?.length > 0 && (
              <Space size={[6, 6]} wrap style={{ marginTop: 12, justifyContent: 'center' }}>
                {agent.capability.map((c) => (
                  <Tag key={c} color="purple" style={{ margin: 0 }}>
                    {c}
                  </Tag>
                ))}
              </Space>
            )}
            <div style={{ marginTop: 20 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {(QUICK[agentId] || []).map((q) => (
                  <Button key={q} block onClick={() => handleSend(q)} style={{ textAlign: 'left' }}>
                    {q}
                  </Button>
                ))}
              </Space>
            </div>
          </div>
        )}

        {messages.map((m) => {
          const mine = m.role === 'user'
          return (
            <Row key={m.id} $mine={mine}>
              <Avatar
                size={34}
                icon={mine ? <UserOutlined /> : <RobotOutlined />}
                style={{
                  background: mine ? '#6366f1' : `${agent?.color || '#6366f1'}1a`,
                  color: mine ? '#fff' : agent?.color,
                  flexShrink: 0,
                }}
              />
              <Bubble $mine={mine} $error={m.error}>
                {m.content || (m.streaming ? <LoadingOutlined /> : '')}
                {/* Step 11 · Phase 2：任务调整提案回执（只表示「已提交」，不代表已生效） */}
                {m.proposal && !mine && <TaskProposalCard proposal={m.proposal} />}
                {m.tools?.length > 0 && !mine && (
                  <ToolTrace>
                    {m.tools.map((t, i) => (
                      <div key={i} style={{ fontSize: 12, color: '#8b5cf6' }}>
                        <ApiOutlined /> 调用工具「{t.name}」
                      </div>
                    ))}
                  </ToolTrace>
                )}
              </Bubble>
              {!mine && m.content && !m.streaming && (
                <Tooltip title="朗读这条回复">
                  <Button
                    type="text"
                    size="small"
                    icon={<SoundOutlined />}
                    onClick={() => speak(m.content)}
                    style={{ color: '#9ca3af', flexShrink: 0 }}
                  />
                </Tooltip>
              )}
            </Row>
          )
        })}

        {speechError && (
          <Alert type="warning" showIcon message={speechError} style={{ borderRadius: 10 }} />
        )}
      </Messages>

      <InputBar>
        <Space.Compact style={{ width: '100%' }}>
          <Input.TextArea
            value={listening && interim ? interim : input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={listening ? '正在聆听，请说话…' : `向「${agent?.name || '智能体'}」提问，或点麦克风说话`}
            autoSize={{ minRows: 1, maxRows: 4 }}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            disabled={listening}
          />
          <Tooltip title={supported ? (listening ? '停止录音' : '语音输入') : '当前浏览器不支持语音输入'}>
            <Button
              icon={listening ? <LoadingOutlined /> : <AudioOutlined />}
              onClick={toggle}
              danger={listening}
              disabled={!supported}
              type={listening ? 'primary' : 'default'}
            />
          </Tooltip>
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={() => handleSend()}
            loading={streaming}
          >
            发送
          </Button>
        </Space.Compact>

        <Hint>
          <span>
            {agent?.role}
            {agent?.tools?.length ? ` · 可调用 ${agent.tools.length} 个工具` : ''}
          </span>
          <Space size={12}>
            <span>
              <SoundOutlined style={{ marginRight: 4 }} />
              自动朗读
              <Switch size="small" checked={autoSpeak} onChange={setAutoSpeak} style={{ marginLeft: 6 }} />
            </span>
            {messages.length > 0 && (
              <Button
                type="link"
                size="small"
                icon={<DeleteOutlined />}
                onClick={() => clearChat(agentId)}
              >
                清空
              </Button>
            )}
          </Space>
        </Hint>
      </InputBar>
    </Panel>
  )
}

export default ChatPanel
