import { useCallback, useEffect, useState } from 'react'
import {
  fetchPaper,
  paperApply,
  paperBuy,
  paperDeposit,
  paperInit,
  paperSell,
  STRATEGIES,
  type OpResult,
  type PaperSnapshot,
} from '../api'
import { loadFavorites, removeFavorite, subscribeFavorites, type FavStock } from '../lib/favorites'
import { loadQueryHistory, removeQueryHistory, subscribeQueryHistory, type QueryItem } from '../lib/query-history'
import EquityChart from './EquityChart'
import FavChips from './FavChips'
import { Metric } from './common/Metric'

interface Toast { kind: 'ok' | 'err' | 'info'; text: string }

function pnlClass(v: number): string {
  return v > 0 ? 'up-text' : v < 0 ? 'down-text' : 'muted'
}

export default function PaperView() {
  const [snap, setSnap] = useState<PaperSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<Toast | null>(null)
  const [initCapital, setInitCapital] = useState(100000)
  const [applySymbol, setApplySymbol] = useState('600519')
  const [applyStrategy, setApplyStrategy] = useState<string>('ma-cross')
  const [buySymbol, setBuySymbol] = useState('600519')
  const [buyAmount, setBuyAmount] = useState('20000')
  const [depositAmount, setDepositAmount] = useState('50000')
  // 重置账户改为页内展开确认（内置预览浏览器不支持 window.prompt）
  const [resetOpen, setResetOpen] = useState(false)
  const [resetCapital, setResetCapital] = useState('10000')
  const [favs, setFavs] = useState<FavStock[]>(loadFavorites)
  const [history, setHistory] = useState<QueryItem[]>(loadQueryHistory)

  const refresh = useCallback(async () => {
    setSnap(await fetchPaper())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 收藏/查询历史变化（其他页面改动/服务端水合）同步到本页
  useEffect(() => subscribeFavorites(setFavs), [])
  useEffect(() => subscribeQueryHistory(setHistory), [])

  const changeSymbol = (code: string) => { setBuySymbol(code); setApplySymbol(code) }

  // 页内确认后执行重置（不弹原生对话框）
  const doReset = () => {
    const c = Number(resetCapital)
    if (!Number.isFinite(c) || c <= 0) { setMsg({ kind: 'err', text: '重置取消：资金金额无效' }); return }
    setInitCapital(c)
    setResetOpen(false)
    void act(() => paperInit(c, true))
  }

  const act = async (fn: () => Promise<OpResult>) => {
    setLoading(true)
    setMsg(null)
    try {
      const r = await fn()
      setMsg({ kind: r.ok ? 'ok' : 'err', text: r.message })
      await refresh()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }

  if (!snap) {
    return <div className="loading" role="status" aria-live="polite"><span className="spinner" />加载账户…</div>
  }

  if (!snap.exists) {
    return (
      <section className="card">
        <h2>模拟盘</h2>
        <p className="sub">还没有模拟账户。用虚拟资金创建账户，行情是真实的，钱是假的——随便练手。</p>
        <div className="controls-row">
          <div className="field">
            <label htmlFor="init-capital">初始资金（元）</label>
            <input id="init-capital" className="field-medium" name="capital" inputMode="numeric" autoComplete="off" spellCheck={false} value={initCapital} onChange={(e) => setInitCapital(Number(e.target.value) || 0)} />
          </div>
          <button className="btn btn-primary" disabled={loading} onClick={() => act(() => paperInit(initCapital, false))}>
            创建模拟账户
          </button>
        </div>
        {msg && <div className={`toast ${msg.kind}`} role="status">{msg.text}</div>}
      </section>
    )
  }

  return (
    <>
      <section className="card">
        <h2>模拟账户</h2>
        <p className="sub">真行情 · 假资金 · 下单自动过风控</p>
        <div className="metric-grid account-grid">
          <Metric label="当前现金" value={`¥${Math.round(snap.cash).toLocaleString()}`} />
          <Metric label="总资产（含持仓）" value={`¥${Math.round(snap.equity).toLocaleString()}`} />
          <Metric
            label="总盈亏"
            value={`${snap.totalProfit >= 0 ? '+' : ''}${snap.totalProfit.toFixed(2)} (${snap.totalProfitPercent.toFixed(2)}%)`}
            cls={pnlClass(snap.totalProfit)}
          />
        </div>
        <div className="controls-row controls-tight">
          <div className="field">
            <label htmlFor="deposit-amount">追加资金（元）</label>
            <input id="deposit-amount" className="field-short" name="deposit" inputMode="numeric" autoComplete="off" spellCheck={false} value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
          </div>
          <button className="btn" disabled={loading} onClick={() => act(() => paperDeposit(Number(depositAmount) || 0))}>充值</button>
          <span className="controls-spacer" />
          <button
            className="btn btn-danger"
            disabled={loading}
            onClick={() => setResetOpen((v) => !v)}
            aria-expanded={resetOpen}
          >
            重置账户
          </button>
        </div>
        {resetOpen && (
          <div className="controls-row controls-tight">
            <div className="field">
              <label htmlFor="reset-capital">重置后的初始资金（元）</label>
              <input id="reset-capital" inputMode="numeric" autoComplete="off" spellCheck={false}
                value={resetCapital} onChange={(e) => setResetCapital(e.target.value)} />
            </div>
            <button className="btn btn-danger" disabled={loading} onClick={doReset}>
              确认重置（清空持仓/流水/曲线）
            </button>
            <button className="btn" onClick={() => setResetOpen(false)}>取消</button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>手动买入</h2>
        <p className="sub">指定金额买入（不够一手的零头自动忽略），现金不会被一次性掏空——这就是仓位管理。</p>
        <div className="controls-row">
          <div className="field">
            <label htmlFor="buy-symbol">股票代码</label>
            <input id="buy-symbol" className="field-short" name="symbol" inputMode="numeric" autoComplete="off" spellCheck={false} value={buySymbol} onChange={(e) => setBuySymbol(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="buy-amount">买入金额（元，留空 = 全仓）</label>
            <input id="buy-amount" className="field-medium" name="amount" inputMode="numeric" autoComplete="off" spellCheck={false} value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)} />
          </div>
          <button className="btn btn-success" disabled={loading} onClick={() => act(() => paperBuy(buySymbol.trim(), Number(buyAmount) || undefined))}>
            买入
          </button>
        </div>
        {history.length > 0 && <p className="fav-empty group-label">最近查询：</p>}
        <FavChips
          favs={history}
          current={buySymbol}
          onSelect={changeSymbol}
          onRemove={(code) => setHistory(removeQueryHistory(code))}
        />
        {favs.length > 0 && <p className="fav-empty group-label">收藏：</p>}
        <FavChips
          favs={favs}
          current={buySymbol}
          onSelect={changeSymbol}
          onRemove={(code) => setFavs(removeFavorite(code))}
        />
      </section>

      <section className="card">
        <h2>持仓</h2>
        {snap.positions.length === 0 ? (
          <div className="empty">空仓。用下面的"按信号自动操作"或手动买入。</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>代码</th><th>名称</th><th>持仓(股)</th><th>成本价</th><th>现价</th><th>市值</th><th>浮动盈亏</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {snap.positions.map((p) => (
                  <tr key={p.symbol}>
                    <td>{p.symbol}</td>
                    <td>{p.name}</td>
                    <td className="num">{p.shares}</td>
                    <td className="num">{p.avgCost.toFixed(2)}</td>
                    <td className="num">{p.price.toFixed(2)}</td>
                    <td className="num">{Math.round(p.value).toLocaleString()}</td>
                    <td className={`num ${pnlClass(p.profit)}`}>{p.profit >= 0 ? '+' : ''}{p.profit.toFixed(2)} ({p.profitPercent.toFixed(2)}%)</td>
                    <td>
                      <div className="pos-actions">
                        <button className="btn btn-success btn-sm" disabled={loading} onClick={() => act(() => paperBuy(p.symbol, Number(buyAmount) || undefined))}>加仓</button>
                        <button className="btn btn-danger btn-sm" disabled={loading} onClick={() => act(() => paperSell(p.symbol))}>卖出</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>按信号自动操作</h2>
        <p className="sub">读取当前策略信号：买入则按风控预算买入、卖出则清仓、持有则检查止损。</p>
        <div className="controls-row">
          <div className="field">
            <label htmlFor="apply-symbol">股票代码</label>
            <input id="apply-symbol" className="field-short" name="symbol" inputMode="numeric" autoComplete="off" spellCheck={false} value={applySymbol} onChange={(e) => setApplySymbol(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="apply-strategy">策略</label>
            <select id="apply-strategy" name="strategy" value={applyStrategy} onChange={(e) => setApplyStrategy(e.target.value)}>
              {STRATEGIES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" disabled={loading} onClick={() => act(() => paperApply(applySymbol.trim(), applyStrategy))}>
            执行
          </button>
        </div>
      </section>

      {snap.equityHistory.length >= 2 && (
        <section className="card">
          <h2>资产曲线</h2>
          <p className="sub">每次买卖操作后的总资产快照（{snap.equityHistory.length} 个记录点）</p>
          <EquityChart points={snap.equityHistory} />
        </section>
      )}

      {snap.trades.length > 0 && (
        <section className="card">
          <h2>最近交易（共 {snap.trades.length} 笔）</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>日期</th><th>动作</th><th>代码</th><th>名称</th><th>价格</th><th>股数</th><th>金额(元)</th><th>已实现盈亏</th></tr>
              </thead>
              <tbody>
                {snap.trades.slice(-12).reverse().map((t, i) => (
                  <tr key={`${t.date}-${i}`}>
                    <td>{t.date}</td>
                    <td className={t.side === 'BUY' ? 'up-text' : t.side === 'SELL' ? 'down-text' : 'muted'}>
                      {t.side === 'BUY' ? '买入' : t.side === 'SELL' ? '卖出' : '充值'}
                    </td>
                    <td>{t.symbol}</td>
                    <td>{t.name}</td>
                    <td className="num">{t.price.toFixed(2)}</td>
                    <td className="num">{t.shares}</td>
                    <td className="num">{Math.round(t.amount).toLocaleString()}</td>
                    <td className={`num ${t.profit != null ? pnlClass(t.profit) : 'muted'}`}>
                      {t.profit != null ? `${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {msg && <div className={`toast toast-fixed ${msg.kind}`} role="status">{msg.text}</div>}
    </>
  )
}
