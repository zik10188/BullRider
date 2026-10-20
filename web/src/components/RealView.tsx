// 实盘记录页：手工同步真实券商的买卖成交，服务端自动移动加权算持仓，
// AI 教练的系统提示词会注入这些数据，保证它的认知跟你的真实操作对齐。
import { useCallback, useEffect, useState } from 'react'
import { addRealTrade, deleteRealTrade, fetchQuote, fetchReal, type RealJournal, type RealTrade } from '../api'

interface Toast { kind: 'ok' | 'err'; text: string }

function pnlClass(v: number): string {
  return v > 0 ? 'up-text' : v < 0 ? 'down-text' : 'muted'
}

const KIND_TEXT: Record<string, { text: string; cls: string }> = {
  BUY: { text: '建议买入', cls: 'up-text' },
  SELL: { text: '建议卖出', cls: 'down-text' },
  HOLD: { text: '继续持有', cls: 'muted' },
}

function today(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export default function RealView() {
  const [journal, setJournal] = useState<RealJournal | null>(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<Toast | null>(null)
  // 记一笔表单
  const [date, setDate] = useState(today())
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [price, setPrice] = useState('')
  const [shares, setShares] = useState('')
  const [fee, setFee] = useState('')
  // 删除用两击确认（内置预览浏览器不支持 window.confirm）
  const [armedId, setArmedId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setJournal(await fetchReal())
  }, [])

  useEffect(() => {
    void refresh().catch((e) => setMsg({ kind: 'err', text: (e as Error).message }))
  }, [refresh])

  // 代码输满6位后自动带出股票名（拿不到就留空，不阻塞手工录入）
  const fillName = async (raw: string) => {
    const c = raw.trim()
    if (!/^\d{6}$/.test(c)) return
    try {
      const q = await fetchQuote(c)
      setName(q.name)
    } catch { /* 行情失败不影响记录 */ }
  }

  const submit = async () => {
    setLoading(true)
    setMsg(null)
    try {
      const t: Omit<RealTrade, 'id'> = {
        date,
        code: code.trim(),
        name: name.trim() || undefined,
        side,
        price: Number(price),
        shares: Number(shares),
        fee: Number(fee) > 0 ? Number(fee) : undefined,
      }
      await addRealTrade(t)
      setMsg({ kind: 'ok', text: `已记录：${t.side === 'BUY' ? '买入' : '卖出'} ${t.code} ${t.shares} 股 @ ${t.price.toFixed(2)}` })
      // 清空成交字段，保留日期方便连记同一天多笔
      setCode(''); setName(''); setPrice(''); setShares(''); setFee('')
      await refresh()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }

  // 第一击进入待确认态，第二击才真删（误触只需再点一次同一按钮取消不了，点别处刷新即复位）
  const remove = async (id: string) => {
    if (armedId !== id) { setArmedId(id); return }
    setArmedId(null)
    setLoading(true)
    setMsg(null)
    try {
      await deleteRealTrade(id)
      setMsg({ kind: 'ok', text: '已删除，持仓已重算' })
      await refresh()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }

  const positions = journal?.positions ?? []
  const trades = journal?.trades ?? []
  const valid = /^\d{6}$/.test(code.trim()) && Number(price) > 0 && Number.isInteger(Number(shares)) && Number(shares) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)

  return (
    <>
      <section className="card">
        <h2>实盘记录</h2>
        <p className="sub">
          真金白银的成交在这里手工同步（券商 APP 成交记录照抄一笔笔录入）。持仓自动按移动加权计算，
          AI 教练会读取这些数据，点评时能对齐你的真实操作。
        </p>
        <div className="controls-row">
          <div className="field">
            <label htmlFor="real-date">成交日期</label>
            <input id="real-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="real-code">股票代码</label>
            <input id="real-code" name="code" inputMode="numeric" autoComplete="off" spellCheck={false} value={code}
              onChange={(e) => setCode(e.target.value)} onBlur={(e) => void fillName(e.target.value)} style={{ width: 110 }} />
          </div>
          <div className="field">
            <label htmlFor="real-side">方向</label>
            <select id="real-side" value={side} onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')}>
              <option value="BUY">买入</option>
              <option value="SELL">卖出</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="real-price">成交价（元）</label>
            <input id="real-price" inputMode="decimal" autoComplete="off" spellCheck={false} value={price}
              onChange={(e) => setPrice(e.target.value)} style={{ width: 110 }} />
          </div>
          <div className="field">
            <label htmlFor="real-shares">股数</label>
            <input id="real-shares" inputMode="numeric" autoComplete="off" spellCheck={false} value={shares}
              onChange={(e) => setShares(e.target.value)} style={{ width: 100 }} />
          </div>
          <div className="field">
            <label htmlFor="real-fee">费用（元，可空）</label>
            <input id="real-fee" inputMode="decimal" autoComplete="off" spellCheck={false} value={fee}
              onChange={(e) => setFee(e.target.value)} style={{ width: 100 }} />
          </div>
          <button className="btn btn-primary" disabled={loading || !valid} onClick={() => void submit()}>记一笔</button>
        </div>
        {name && <p className="fav-empty" style={{ margin: '8px 0 0' }}>识别为：{name}</p>}
        {msg && <div className={`toast ${msg.kind}`} role="status">{msg.text}</div>}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>实盘持仓（自动汇总）</h2>
        {positions.length === 0 ? (
          <div className="empty">暂无持仓。在上面记一笔买入后自动汇总。</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>代码</th><th>名称</th><th>持仓(股)</th><th>成本价</th><th>现价</th><th>市值</th><th>浮动盈亏</th><th>赛马建议</th></tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.code}>
                    <td>{p.code}</td>
                    <td>{p.name || '—'}</td>
                    <td className="num">{p.shares}</td>
                    <td className="num">{p.avgCost.toFixed(2)}</td>
                    <td className="num">{Number.isNaN(p.currentPrice) ? '—' : p.currentPrice.toFixed(2)}</td>
                    <td className="num">{Number.isNaN(p.marketValue) ? '—' : Math.round(p.marketValue).toLocaleString()}</td>
                    <td className={`num ${Number.isNaN(p.profit) ? 'muted' : pnlClass(p.profit)}`}>
                      {Number.isNaN(p.profit) ? '行情获取失败' : `${p.profit >= 0 ? '+' : ''}${p.profit.toFixed(2)} (${p.profitPercent.toFixed(2)}%)`}
                    </td>
                    <td style={{ maxWidth: 380 }}>
                      {p.signal ? (
                        <>
                          <span className={KIND_TEXT[p.signal.kind]?.cls}>{KIND_TEXT[p.signal.kind]?.text ?? p.signal.kind}</span>
                          <span style={{ display: 'block', fontSize: 12, whiteSpace: 'pre-line' }} className="muted">{p.signal.reason}</span>
                        </>
                      ) : (
                        <span className="muted">数据不足，无法评估</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>成交明细（共 {trades.length} 笔）</h2>
        {trades.length === 0 ? (
          <div className="empty">还没有记录。把券商 APP 里的成交一笔笔记进来即可。</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>日期</th><th>方向</th><th>代码</th><th>名称</th><th>价格</th><th>股数</th><th>费用</th><th>操作</th></tr>
              </thead>
              <tbody>
                {[...trades].reverse().map((t) => (
                  <tr key={t.id}>
                    <td>{t.date}</td>
                    <td className={t.side === 'BUY' ? 'up-text' : 'down-text'}>{t.side === 'BUY' ? '买入' : '卖出'}</td>
                    <td>{t.code}</td>
                    <td>{t.name || '—'}</td>
                    <td className="num">{t.price.toFixed(2)}</td>
                    <td className="num">{t.shares}</td>
                    <td className="num">{t.fee != null ? t.fee.toFixed(2) : '—'}</td>
                    <td>
                      <button
                        className={`btn btn-sm ${armedId === t.id ? 'btn-danger' : ''}`}
                        disabled={loading}
                        title={armedId === t.id ? '再点一次确认删除' : '删除这笔记录'}
                        onClick={() => void remove(t.id)}
                      >
                        {armedId === t.id ? '确认删除？' : '删除'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
