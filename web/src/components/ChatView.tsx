// AI 教练对话面板
// 模型设置 / 对话历史：服务端 .data/prefs.json 持久化（localStorage 作即时缓存），
// API Key 由服务端 AES-256-GCM 加密存储，前端只见掩码。
// 历史快超出上下文窗口时，自动把旧对话压缩成摘要（调一次同一个端点）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { chatSend, fetchPrefs, LEGACY_LLM_KEY, savePrefs, STRATEGIES, type ChatMsg, type LlmSettings } from '../api'
import { loadQueryHistory, removeQueryHistory, subscribeQueryHistory, type QueryItem } from '../lib/query-history'
import FavChips from './FavChips'

const HISTORY_KEY = 'bullrider.chat'
const DEFAULT_SETTINGS: LlmSettings = { baseUrl: '', model: '', contextWindow: 32000, hasKey: false }

/** 服务商预设（参考 Codex 的 provider presets：选一家自动填端点和默认模型） */
const PRESETS: Array<{ id: string; label: string; baseUrl: string; model: string }> = [
  { id: 'dashscope', label: '通义千问（DashScope）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'custom', label: '自定义', baseUrl: '', model: '' },
]

function presetIdOf(s: LlmSettings): string {
  return PRESETS.find((p) => p.baseUrl && p.baseUrl === s.baseUrl)?.id ?? 'custom'
}

/** 粗略估算 token 数：中文约 1 字 ≈ 0.6~1 token，按 0.7 取偏保守值，宁早勿晚触发压缩 */
function estTokens(messages: ChatMsg[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) * 0.7)
}

function loadHistory(): ChatMsg[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as ChatMsg[]
      if (Array.isArray(arr)) return arr.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    }
  } catch { /* 忽略坏数据 */ }
  return []
}

export default function ChatView() {
  const [settings, setSettings] = useState<LlmSettings>(DEFAULT_SETTINGS)
  const [newKey, setNewKey] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>(loadHistory)
  const [input, setInput] = useState('')
  const [strategy, setStrategy] = useState('ma-cross')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<QueryItem[]>(loadQueryHistory)
  const listRef = useRef<HTMLDivElement | null>(null)
  const putTimer = useRef<number | null>(null)

  const configured = Boolean(settings.baseUrl.trim() && settings.model.trim() && settings.hasKey)

  // 查询历史变化（其他页面改动/服务端水合）同步到本页
  useEffect(() => subscribeQueryHistory(setHistory), [])

  // 启动：从服务端水合 模型设置 + 对话历史；旧版 localStorage 明文 Key 迁移到服务端
  useEffect(() => {
    void (async () => {
      let serverHadLlm = false
      try {
        const p = await fetchPrefs()
        serverHadLlm = Boolean(p.llm?.hasKey || p.llm?.baseUrl)
        if (p.llm) setSettings(p.llm)
        if (p.chat && p.chat.length > 0) {
          setMessages(p.chat)
          try { localStorage.setItem(HISTORY_KEY, JSON.stringify(p.chat.slice(-60))) } catch { /* 忽略 */ }
        }
      } catch { /* 服务器不可达：用本地缓存 */ }
      try {
        const raw = localStorage.getItem(LEGACY_LLM_KEY)
        if (raw) {
          const legacy = JSON.parse(raw) as Partial<{ baseUrl: string; apiKey: string; model: string; contextWindow: number }>
          if (!serverHadLlm && legacy.apiKey) {
            const r = await savePrefs({ llm: { baseUrl: legacy.baseUrl, model: legacy.model, contextWindow: legacy.contextWindow, apiKey: legacy.apiKey } })
            if (r.llm) setSettings(r.llm)
          }
          localStorage.removeItem(LEGACY_LLM_KEY)
        }
      } catch { /* 迁移失败不影响使用 */ }
    })()
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, busy])

  /** 本地缓存（刷新秒显）+ 服务端持久化（换浏览器不丢），防抖避免连点 */
  const persist = (msgs: ChatMsg[]) => {
    setMessages(msgs)
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(msgs.slice(-60))) } catch { /* 存储满忽略 */ }
    if (putTimer.current) window.clearTimeout(putTimer.current)
    putTimer.current = window.setTimeout(() => {
      void savePrefs({ chat: msgs.slice(-200) }).catch(() => { /* 服务器不可达时先用本地缓存 */ })
    }, 800)
  }

  /** 保存模型设置到服务端（Key 只在用户输入了新值时才更新） */
  const saveSettings = async () => {
    setError('')
    try {
      const r = await savePrefs({
        llm: {
          baseUrl: settings.baseUrl,
          model: settings.model,
          contextWindow: settings.contextWindow,
          apiKey: newKey || undefined,
        },
      })
      if (r.llm) setSettings(r.llm)
      setNewKey('')
      setShowSettings(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** 历史快超窗口 → 让模型把旧对话压缩成摘要（Codex 式动态切分：按 token 预算尽量多留最近消息，不固定条数） */
  const compressIfNeeded = useCallback(async (msgs: ChatMsg[]): Promise<ChatMsg[]> => {
    const totalBudget = Math.max(2000, settings.contextWindow * 0.6)
    if (estTokens(msgs) <= totalBudget || msgs.length <= 4) return msgs
    // 从最新往回收集消息，直到保留区 token 预算（总预算的一半）用完；至少保留最后 1 条
    const keepBudget = totalBudget * 0.5
    let keepTokens = 0
    let cut = msgs.length
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = estTokens([msgs[i]])
      if (i < msgs.length - 1 && keepTokens + t > keepBudget) break
      keepTokens += t
      cut = i
    }
    if (cut <= 0) return msgs
    const keep = msgs.slice(cut)
    const old = msgs.slice(0, cut)
    setError('对话太长，正在压缩历史…')
    const r = await chatSend(
      [{ role: 'user', content: '请把下面这段 AI 教练对话压缩成要点摘要（保留股票代码、数字和结论），直接输出摘要，不要客套：\n\n' + old.map((m) => `${m.role === 'user' ? '用户' : '教练'}：${m.content}`).join('\n') }],
      settings,
    )
    setError('')
    if (!r.ok || !r.reply) return msgs // 压缩失败就原样发，让后端报错兜底
    return [{ role: 'system', content: `[历史摘要，更早的对话已压缩] ${r.reply}` }, ...keep]
  }, [settings])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    if (!configured) { setShowSettings(true); setError('请先在模型设置里填好服务端点地址、模型名，并保存 API Key'); return }

    const next = [...messages, { role: 'user' as const, content: text }]
    persist(next)
    setInput('')
    setBusy(true)
    setError('')
    try {
      const toSend = await compressIfNeeded(next)
      const r = await chatSend(toSend, settings, history.slice(0, 5).map((h) => h.code), strategy)
      if (r.ok && r.reply) {
        persist([...next, { role: 'assistant', content: r.reply }])
      } else {
        setError(r.message || '大模型没有返回内容')
        persist(next) // 失败时至少保留用户消息
      }
    } catch (e) {
      setError((e as Error).message)
      persist(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="card">
        <div className="chat-head">
          <div>
            <h2>AI 教练</h2>
            <p className="sub">接入你自己的大模型（任何 OpenAI 兼容端点）。它负责解读信号、点评操作、提醒风险——不预测涨跌，不构成投资建议。</p>
          </div>
          <button className="btn" onClick={() => setShowSettings((v) => !v)}>{showSettings ? '收起设置' : '模型设置'}</button>
        </div>

        {showSettings && (
          <div className="chat-settings">
            <div className="field">
              <label htmlFor="llm-preset">服务商预设</label>
              <select
                id="llm-preset"
                value={presetIdOf(settings)}
                onChange={(e) => {
                  const p = PRESETS.find((x) => x.id === e.target.value)
                  if (p) setSettings({ ...settings, baseUrl: p.baseUrl, model: p.model })
                }}
              >
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="llm-baseurl">服务端点地址（OpenAI 兼容，填到 /v1 这级）</label>
              <input id="llm-baseurl" autoComplete="off" spellCheck={false} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" value={settings.baseUrl} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="llm-key">API Key{settings.hasKey && settings.keyMask ? `（已保存 ${settings.keyMask}，留空保持不变）` : ''}</label>
              <input id="llm-key" type="password" autoComplete="off" spellCheck={false} placeholder={settings.hasKey ? '留空 = 不修改已保存的 Key' : 'sk-…'} value={newKey} onChange={(e) => setNewKey(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="llm-model">模型名</label>
              <input id="llm-model" autoComplete="off" spellCheck={false} placeholder="qwen-flash / deepseek-chat / gpt-4o-mini…" value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="llm-window">上下文窗口（token，满了自动压缩历史）</label>
              <input id="llm-window" className="field-medium" inputMode="numeric" autoComplete="off" value={settings.contextWindow} onChange={(e) => setSettings({ ...settings, contextWindow: Number(e.target.value) || 32000 })} />
            </div>
            <div className="controls-row">
              <button className="btn btn-primary" onClick={() => { void saveSettings() }}>保存设置</button>
              <button className="btn btn-danger" onClick={() => { persist([]); setError('') }}>清空对话</button>
            </div>
            <p className="sub">设置与对话保存在服务端 .data/prefs.json，换浏览器不丢；Key 以 AES-256-GCM 加密存储（密钥在 .data/prefs.key），界面上只显示掩码。</p>
          </div>
        )}
      </section>

      <section className="card">
        <div className="chat-context controls-row">
          <div className="field">
            <label htmlFor="chat-strategy">信号策略（对所有标的生效）</label>
            <select id="chat-strategy" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <span className="chat-tokens muted">历史约 {estTokens(messages)} / {settings.contextWindow} token</span>
        </div>

        {history.length > 0 ? (
          <>
            <p className="fav-empty chat-scope">
              AI 的视野：你最近查询过的 {Math.min(history.length, 5)} 只股票（每次对话自动带上它们的实时行情与信号，✕ 可移除）：
            </p>
            <FavChips
              favs={history.slice(0, 5)}
              onSelect={() => { /* 仅展示，点击无动作 */ }}
              onRemove={(code) => setHistory(removeQueryHistory(code))}
            />
          </>
        ) : (
          <p className="fav-empty chat-scope">还没有查询记录。去"行情"或"回测"页查几只股票，AI 就能看到它们了。</p>
        )}

        <div className="chat-list" ref={listRef} aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-bubble assistant">
              你好，我是 BullRider AI 教练。可以问我：
              <br />· "现在茅台的信号是什么意思？"
              <br />· "帮我看看我的仓位有没有问题"
              <br />· "MA5 上穿 MA10 为什么算买入信号？"
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`chat-bubble ${m.role}`}>{m.content}</div>
          ))}
          {busy && <div className="chat-bubble assistant muted">教练思考中…</div>}
        </div>

        <div className="chat-input controls-row">
          <textarea
            aria-label="对话输入"
            rows={2}
            value={input}
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
            }}
          />
          <button className="btn btn-primary" disabled={busy || !input.trim()} onClick={() => void send()}>发送</button>
        </div>
        {error && <div className="toast toast-fixed err" role="alert">{error}</div>}
      </section>
    </>
  )
}
