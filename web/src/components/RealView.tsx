// 实盘记录页：手工同步真实券商的买卖成交，服务端自动移动加权算持仓，
// AI 教练的系统提示词会注入这些数据，保证它的认知跟你的真实操作对齐。
import { useCallback, useEffect, useState } from 'react'
import { addRealTrade, deleteRealTrade, fetchQuote, fetchReal, saveRealFeeConfig, type RealJournal, type RealTrade } from '../api'
import GuidePanel from './common/GuidePanel'
import { Metric, MetricGrid } from './common/Metric'
import PageHeader from './common/PageHeader'

interface Toast { kind: 'ok' | 'err'; text: string }

type Position = RealJournal['positions'][number]

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

/** 持仓摘要 + 可展开决策详情，替代原先 9 列横向大表 */
function PositionItem({ p, expanded, onToggle }: { p: Position; expanded: boolean; onToggle: () => void }) {
  const digits = p.sellGuide?.available && p.sellGuide.tick === 0.001 ? 3 : 2
  const price = (v: number) => v.toFixed(digits)
  const signal = p.signal ? KIND_TEXT[p.signal.kind] : null
  const risk = p.sellGuide?.available
    ? (p.sellGuide.riskTriggered ? '已破防守线' : `距防守 ${p.sellGuide.distanceToStopPercent.toFixed(1)}%`)
    : p.sellGuide?.reason ?? '行情异常'

  return (
    <article className={`position-item${expanded ? ' expanded' : ''}`}>
      <div className="position-main">
        <div className="position-title">
          <div>
            <span className="position-name">{p.name || '未命名股票'}</span>
            <span className="position-code num">{p.code}</span>
          </div>
          <span className={`position-pnl num ${Number.isNaN(p.profit) ? 'muted' : pnlClass(p.profit)}`}>
            {Number.isNaN(p.profit) ? '行情获取失败' : `${p.profit >= 0 ? '+' : ''}${p.profit.toFixed(2)}`}
            {!Number.isNaN(p.profit) && <small>{p.profitPercent >= 0 ? '+' : ''}{p.profitPercent.toFixed(2)}%</small>}
          </span>
        </div>

        <div className="position-facts">
          <div><span>现价</span><b className="num">{Number.isNaN(p.currentPrice) ? '—' : p.currentPrice.toFixed(2)}</b></div>
          <div><span>成本</span><b className="num">{p.avgCost.toFixed(2)}</b></div>
          <div><span>持仓</span><b className="num">{p.shares.toLocaleString()} 股</b></div>
          <div><span>市值</span><b className="num">{Number.isNaN(p.marketValue) ? '—' : `¥${Math.round(p.marketValue).toLocaleString()}`}</b></div>
          <div><span>防守</span><b className="num">{p.sellGuide?.available ? price(p.sellGuide.effectiveStopPrice) : '—'}</b></div>
          <div><span>状态</span><b className={p.sellGuide?.available && p.sellGuide.riskTriggered ? 'risk-hit' : 'muted'}>{risk}</b></div>
          <div><span>赛马</span><b className={p.signal && signal ? signal.cls : ''}>{p.signal && signal ? signal.text : '数据不足'}</b></div>
        </div>

        <button className="position-toggle" type="button" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? '收起详情' : '查看详情'}
        </button>
      </div>

      {expanded && (
        <div className="position-detail">
          <GuidePanel title="卖出参考">
            {p.sellGuide?.available ? (
              <>
                <div className="guide-lines">
                  <div><span>防守</span><b className="num">{price(p.sellGuide.effectiveStopPrice)}</b></div>
                  <div><span>风控</span><b className="num">{price(p.sellGuide.stopLossPrice)}</b></div>
                  <div><span>技术</span><b className="num">{price(p.sellGuide.protectionPrice)}</b></div>
                  <div><span>止盈一</span><b className="num">{price(p.sellGuide.targets[0].price)}</b></div>
                  <div><span>止盈二</span><b className="num">{price(p.sellGuide.targets[1].price)}</b></div>
                </div>
                <p>{p.sellGuide.advice}</p>
              </>
            ) : <p className="muted">{p.sellGuide?.reason ?? '行情异常，无法计算'}</p>}
          </GuidePanel>
          <GuidePanel title="赛马建议">
            {p.signal ? (
              <>
                <div className={`signal-chip ${KIND_TEXT[p.signal.kind]?.cls ?? ''}`}>{KIND_TEXT[p.signal.kind]?.text ?? p.signal.kind}</div>
                <p>{p.signal.reason}</p>
              </>
            ) : <p className="muted">数据不足，无法评估</p>}
          </GuidePanel>
        </div>
      )}
    </article>
  )
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
  const [commissionRate, setCommissionRate] = useState('')
  const [minCommission, setMinCommission] = useState('')
  const [feeSaving, setFeeSaving] = useState(false)
  // 删除用两击确认（内置预览浏览器不支持 window.confirm）
  const [armedId, setArmedId] = useState<string | null>(null)
  const [expandedCode, setExpandedCode] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const data = await fetchReal()
    setJournal(data)
    setCommissionRate(String(data.feeConfig.commissionRatePercent))
    setMinCommission(String(data.feeConfig.minCommission))
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
    const rawFee = fee.trim()
    const parsedFee = rawFee === '' ? undefined : Number(rawFee)
    if (parsedFee != null && (!Number.isFinite(parsedFee) || parsedFee < 0)) {
      setMsg({ kind: 'err', text: '手续费需为非负数，或留空自动估算' })
      return
    }
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
        fee: parsedFee,
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
  const pnl = journal?.pnl
  const feeInputValid = fee.trim() === '' || (Number.isFinite(Number(fee)) && Number(fee) >= 0)
  const valid = /^\d{6}$/.test(code.trim()) && Number(price) > 0 && Number.isInteger(Number(shares)) && Number(shares) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && feeInputValid

  const saveFee = async () => {
    const rateText = commissionRate.trim()
    const minimumText = minCommission.trim()
    const rate = Number(rateText)
    const minimum = Number(minimumText)
    if (!rateText || !minimumText || !Number.isFinite(rate) || rate < 0 || rate > 1 || !Number.isFinite(minimum) || minimum < 0 || minimum > 1000) {
      setMsg({ kind: 'err', text: '手续费设置无效：佣金费率需在 0~1% 之间，最低佣金需在 0~1000 元之间' })
      return
    }
    setFeeSaving(true)
    setMsg(null)
    try {
      const saved = await saveRealFeeConfig({
        commissionRatePercent: rate,
        minCommission: minimum,
      })
      setCommissionRate(String(saved.realFee.commissionRatePercent))
      setMinCommission(String(saved.realFee.minCommission))
      setJournal((cur) => cur ? { ...cur, feeConfig: saved.realFee } : cur)
      setMsg({ kind: 'ok', text: '手续费设置已保存，之后未手填费用的成交会按这个费率估算' })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setFeeSaving(false)
    }
  }

  return (
    <>
      <PageHeader
        title="实盘风控台"
        description="把真实持仓变成风险检查表：防守线、浮盈亏和赛马建议放在同一屏。"
      />
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
            <input id="real-code" className="field-short" name="code" inputMode="numeric" autoComplete="off" spellCheck={false} value={code}
              onChange={(e) => setCode(e.target.value)} onBlur={(e) => void fillName(e.target.value)} />
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
            <input id="real-price" className="field-short" inputMode="decimal" autoComplete="off" spellCheck={false} value={price}
              onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="real-shares">股数</label>
            <input id="real-shares" className="field-short" inputMode="numeric" autoComplete="off" spellCheck={false} value={shares}
              onChange={(e) => setShares(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="real-fee">费用（元，可空）</label>
            <input id="real-fee" className="field-short" inputMode="decimal" autoComplete="off" spellCheck={false} value={fee}
              onChange={(e) => setFee(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={loading || !valid} onClick={() => void submit()}>记一笔</button>
        </div>
        {name && <p className="fav-empty group-label">识别为：{name}</p>}
        {msg && <div className={`toast ${msg.kind}`} role="status">{msg.text}</div>}
      </section>

      <section className="card">
        <h2>历史盈亏</h2>
        <MetricGrid>
          <Metric label="已实现盈亏" value={`¥${pnl?.realized.toFixed(2) ?? '0.00'}`} cls={pnl ? pnlClass(pnl.realized) : 'muted'} />
          <Metric label="持仓浮动盈亏" value={`¥${pnl?.unrealized.toFixed(2) ?? '0.00'}`} cls={pnl ? pnlClass(pnl.unrealized) : 'muted'} />
          <Metric label="总盈亏" value={`¥${pnl?.total.toFixed(2) ?? '0.00'}`} cls={pnl ? pnlClass(pnl.total) : 'muted'} />
        </MetricGrid>
        <p className="sub">
          已实现盈亏只统计已卖出的部分；总盈亏包含当前持仓按现价估值的浮动盈亏，行情变动后也会跟着变。
          {pnl?.missingFeeCount ? ` 有 ${pnl.missingFeeCount} 笔旧记录没有费用，历史统计按费用 0 处理。` : ''}
        </p>
      </section>

      <section className="card">
        <h2>手续费设置</h2>
        <p className="sub">未手填费用时自动估算：买入佣金+过户费；卖出佣金+印花税+过户费。手填费用优先。</p>
        <div className="controls-row">
          <div className="field">
            <label htmlFor="fee-rate">佣金费率（%）</label>
            <input id="fee-rate" className="field-short" inputMode="decimal" value={commissionRate} onChange={(e) => setCommissionRate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="fee-min">最低佣金（元）</label>
            <input id="fee-min" className="field-short" inputMode="decimal" value={minCommission} onChange={(e) => setMinCommission(e.target.value)} />
          </div>
          <button className="btn" disabled={feeSaving} onClick={() => void saveFee()}>保存设置</button>
        </div>
      </section>

      <section className="card">
        <h2>实盘持仓（自动汇总）</h2>
        {positions.length === 0 ? (
          <div className="empty">暂无持仓。在上面记一笔买入后自动汇总。</div>
        ) : (
          <div className="position-list">
            {positions.map((p) => (
              <PositionItem
                key={p.code}
                p={p}
                expanded={expandedCode === p.code}
                onToggle={() => setExpandedCode((c) => (c === p.code ? null : p.code))}
              />
            ))}
          </div>
        )}
      </section>

      <section className="card">
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
