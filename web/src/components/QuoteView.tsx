import { useCallback, useEffect, useState } from 'react'
import { fetchQuote, fetchSignal, STRATEGIES, type KLine, type Quote, type SignalInfo } from '../api'
import { loadFavorites, removeFavorite, subscribeFavorites, toggleFavorite, type FavStock } from '../lib/favorites'
import { recordQuery } from '../lib/query-history'
import { loadLastSymbol, setLastSymbol, subscribeLastSymbol } from '../lib/last-symbol'
import FavChips from './FavChips'
import KlineChart from './KlineChart'

const SIGNAL_LABEL: Record<string, { text: string; cls: string }> = {
  BUY: { text: '买入', cls: 'buy' },
  SELL: { text: '卖出', cls: 'sell' },
  HOLD: { text: '持有', cls: 'hold' },
}

function changeClass(v: number): string {
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat'
}

export default function QuoteView() {
  const [symbol, setSymbol] = useState(loadLastSymbol)
  const [input, setInput] = useState(() => loadLastSymbol())
  const [strategy, setStrategy] = useState<string>('ma-cross')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [signal, setSignal] = useState<SignalInfo | null>(null)
  const [klines, setKlines] = useState<KLine[]>([])
  const [favs, setFavs] = useState<FavStock[]>(loadFavorites)

  const load = useCallback(async (sym: string, strat: string) => {
    setLoading(true)
    setError('')
    try {
      const [q, s] = await Promise.all([fetchQuote(sym), fetchSignal(sym, 60, strat)])
      setQuote(q)
      setSignal(s.signal)
      setKlines(s.klines)
      recordQuery(sym, q.name) // 进入查询历史（AI 教练的视野来源）
    } catch (e) {
      setError((e as Error).message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(symbol, strategy)
  }, [symbol, strategy, load])

  // 收藏变化（其他页面改动/服务端水合）同步到本页
  useEffect(() => subscribeFavorites(setFavs), [])

  // 全局当前股票变化（其他页面改动/服务端水合）同步到本页
  useEffect(() => subscribeLastSymbol((c) => { setSymbol(c); setInput(c) }), [])

  const changeSymbol = (code: string) => { setSymbol(code); setLastSymbol(code) }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const sym = input.trim()
    if (sym) changeSymbol(sym)
  }

  const sig = signal ? SIGNAL_LABEL[signal.kind] : null
  const isFav = favs.some((f) => f.code === symbol)

  const toggleFav = () => {
    if (!quote) return
    setFavs(toggleFavorite(symbol, quote.name))
  }
  const removeFav = (code: string) => setFavs(removeFavorite(code))
  const pickFav = (code: string) => changeSymbol(code)

  return (
    <>
      <form className="search-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="quote-symbol">股票代码</label>
        <input
          id="quote-symbol"
          name="symbol"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="如 600519…"
        />
        <label className="sr-only" htmlFor="quote-strategy">策略</label>
        <select id="quote-strategy" name="strategy" aria-label="信号策略" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
          {STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <button className="btn btn-primary" type="submit" disabled={loading}>
          查询
        </button>
        <button
          className="btn"
          type="button"
          disabled={!quote}
          title={isFav ? '取消收藏' : '收藏当前股票'}
          onClick={toggleFav}
          aria-pressed={isFav}
        >
          {isFav ? '★ 已收藏' : '☆ 收藏'}
        </button>
      </form>

      <FavChips favs={favs} current={symbol} onSelect={pickFav} onRemove={removeFav} emptyHint="还没有收藏。查到股票后点上面的「☆ 收藏」，下次一键直达。" />

      {loading && <div className="loading" role="status" aria-live="polite"><span className="spinner" />加载中…</div>}
      {!loading && error && <div className="toast err" role="status">{error}</div>}

      {quote && (
        <section className="card hero" aria-label="实时行情">
          <div>
            <span className="code">{quote.name} · {symbol}</span>
            <div className="price num">
              {quote.price.toFixed(2)}
              <span className={`change-badge ${changeClass(quote.changePercent)}`} style={{ marginLeft: 14, verticalAlign: 'middle' }}>
                {quote.changePercent >= 0 ? '▲' : '▼'} {Math.abs(quote.changePercent).toFixed(2)}%
              </span>
            </div>
          </div>
          <div className="hero-side">
            <div>今开 <b className="num">{quote.open.toFixed(2)}</b></div>
            <div>MA5 <b className="num">{signal ? signal.indicators.ma5.toFixed(2) : '—'}</b></div>
            <div>MA10 <b className="num">{signal ? signal.indicators.ma10.toFixed(2) : '—'}</b></div>
          </div>
        </section>
      )}

      {signal && sig && (
        <section className={`signal-ribbon ${sig.cls}`} aria-label="当前信号">
          <span className="signal-tag"><span>{sig.text}</span></span>
          <span className="ribbon-reason">{signal.reason}</span>
          <span className="muted num">策略 {signal.strategy}</span>
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <h2>日 K 线 · 近 {klines.length} 日</h2>
        <KlineChart klines={klines} />
      </section>

      {klines.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>近期明细</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>日期</th><th>开盘</th><th>收盘</th><th>最高</th><th>最低</th><th>涨跌</th><th>成交量(手)</th>
                </tr>
              </thead>
              <tbody>
                {/* 新到旧排列：多取 1 根当涨跌基准，倒序后第 i 行的前一交易日是 arr[i+1] */}
                {klines.slice(-13).reverse().slice(0, 12).map((k, i, arr) => {
                  const prev = i + 1 < arr.length ? arr[i + 1].close : k.open
                  const chg = prev ? ((k.close - prev) / prev) * 100 : 0
                  const cls = chg > 0 ? 'up-text' : chg < 0 ? 'down-text' : 'muted'
                  return (
                    <tr key={k.date}>
                      <td>{k.date}</td>
                      <td className="num">{k.open.toFixed(2)}</td>
                      <td className="num">{k.close.toFixed(2)}</td>
                      <td className="num">{k.high.toFixed(2)}</td>
                      <td className="num">{k.low.toFixed(2)}</td>
                      <td className={`num ${cls}`}>{chg > 0 ? '+' : ''}{chg.toFixed(2)}%</td>
                      <td className="num">{k.volume.toLocaleString()}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}
