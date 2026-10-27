import { useCallback, useEffect, useState } from 'react'
import { fetchBacktest, STRATEGIES, type BacktestResult } from '../api'
import { loadFavorites, removeFavorite, subscribeFavorites, type FavStock } from '../lib/favorites'
import { recordQuery } from '../lib/query-history'
import { loadLastSymbol, setLastSymbol, subscribeLastSymbol } from '../lib/last-symbol'
import FavChips from './FavChips'

function retClass(v: number): string {
  return v > 0 ? 'up-text' : v < 0 ? 'down-text' : 'muted'
}

export default function BacktestView() {
  const [symbol, setSymbol] = useState(loadLastSymbol)
  const [input, setInput] = useState(() => loadLastSymbol())
  const [days, setDays] = useState(250)
  const [capital, setCapital] = useState(200000)
  const [strategy, setStrategy] = useState<string>('ma-cross')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [favs, setFavs] = useState<FavStock[]>(loadFavorites)

  const run = useCallback(async (sym: string) => {
    setLoading(true)
    setError('')
    try {
      const r = await fetchBacktest(sym, days, capital, strategy)
      setResult(r)
      recordQuery(sym, r.name) // 进入查询历史（AI 教练的视野来源）
    } catch (e) {
      setError((e as Error).message || '回测失败')
    } finally {
      setLoading(false)
    }
  }, [days, capital, strategy])

  useEffect(() => {
    void run(symbol)
  }, [symbol, run])

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

  const metrics = result
    ? [
        { label: '策略总收益', value: `${result.totalReturnPercent >= 0 ? '+' : ''}${result.totalReturnPercent.toFixed(2)}%`, cls: retClass(result.totalReturnPercent) },
        { label: '买入持有', value: `${result.buyHoldReturnPercent >= 0 ? '+' : ''}${result.buyHoldReturnPercent.toFixed(2)}%`, cls: retClass(result.buyHoldReturnPercent) },
        { label: '超额收益', value: `${result.excessReturnPercent >= 0 ? '+' : ''}${result.excessReturnPercent.toFixed(2)}%`, cls: retClass(result.excessReturnPercent) },
        { label: '交易次数', value: `${result.tradeCount}`, cls: 'muted' },
        { label: '胜率', value: `${result.winRate.toFixed(1)}%`, cls: 'muted' },
        { label: '最大回撤', value: `-${result.maxDrawdownPercent.toFixed(2)}%`, cls: 'down-text' },
        { label: '期末资产', value: `¥${Math.round(result.finalEquity).toLocaleString()}`, cls: '' },
      ]
    : []

  return (
    <>
      <form className="search-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="bt-symbol">股票代码</label>
        <input id="bt-symbol" name="symbol" inputMode="numeric" autoComplete="off" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder="如 600519…" />
        <select name="days" aria-label="回测天数" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={120}>120 天</option>
          <option value={250}>250 天</option>
          <option value={500}>500 天</option>
        </select>
        <select name="strategy" aria-label="回测策略" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
          {STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="bt-capital">初始资金</label>
        <input id="bt-capital" className="field-short" name="capital" inputMode="numeric" autoComplete="off" spellCheck={false} value={capital} onChange={(e) => setCapital(Number(e.target.value) || 0)} placeholder="如 200000…" />
        <button className="btn btn-primary" type="submit" disabled={loading}>回测</button>
      </form>

      <FavChips
        favs={favs}
        current={symbol}
        onSelect={changeSymbol}
        onRemove={(code) => setFavs(removeFavorite(code))}
      />

      {loading && <div className="loading" role="status" aria-live="polite"><span className="spinner" />回测中…</div>}
      {!loading && error && <div className="toast err" role="status">{error}</div>}

      {result && (
        <>
          <section className="card">
            <h2>{result.name} ({result.symbol}) · {result.strategy}</h2>
            <p className="sub">{result.periodStart} ~ {result.periodEnd}（共 {result.barCount} 根日K）· 初始资金 ¥{result.initialCapital.toLocaleString()} · 信号次日开盘成交</p>
            <div className="metric-grid">
              <div className={`metric verdict ${result.excessReturnPercent >= 0 ? 'positive' : 'negative'}`}>
                <div className="label">相对买入持有</div>
                <div className={`value num ${retClass(result.excessReturnPercent)}`}>
                  {result.excessReturnPercent >= 0 ? '+' : ''}{result.excessReturnPercent.toFixed(2)}%
                </div>
                <p>{result.excessReturnPercent >= 0 ? '策略跑赢买入持有' : '策略跑输买入持有'}</p>
              </div>
              {metrics.map((m) => (
                <div className="metric" key={m.label}>
                  <div className="label">{m.label}</div>
                  <div className={`value num ${m.cls}`}>{m.value}</div>
                </div>
              ))}
            </div>
          </section>

          {result.trades.length > 0 && (
            <section className="card">
              <h2>交易明细（{result.trades.length} 笔）</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>开仓</th><th>平仓</th><th>买入价</th><th>卖出价</th><th>收益率</th><th>持仓(天)</th></tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => (
                      <tr key={i}>
                        <td>{t.entryDate}</td>
                        <td>{t.exitDate}</td>
                        <td className="num">{t.entryPrice.toFixed(2)}</td>
                        <td className="num">{t.exitPrice.toFixed(2)}</td>
                        <td className={`num ${retClass(t.returnPercent)}`}>{t.returnPercent >= 0 ? '+' : ''}{t.returnPercent.toFixed(2)}%</td>
                        <td className="num">{t.days}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <p className="backtest-note">
            仅供参考，历史不代表未来，不构成投资建议。
          </p>
        </>
      )}
    </>
  )
}
