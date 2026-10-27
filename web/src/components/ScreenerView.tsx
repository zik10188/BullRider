// 选股推荐页：漏斗式全市场扫描（快照粗筛 → 日K精算策略赛马），输出 BUY 名单
// 实盘已持仓股自动排除；结果存服务端，AI 教练也会读取
// 底部"信号质量追踪"卡：回合制两层口径，评价策略信号到底准不准（而不是拿单次推荐当尺子）
import { useCallback, useEffect, useState } from 'react'
import { fetchScan, scanNow, ongoingScan, fetchTrackStats, deleteTrackStock, fetchPriceGuide, type PriceGuide, type ScanReport, type TrackStats } from '../api'
import { loadFavorites, toggleFavorite, subscribeFavorites, type FavStock } from '../lib/favorites'
import GuidePanel from './common/GuidePanel'
import { Metric } from './common/Metric'
import ScanFunnel from './common/ScanFunnel'

function changeClass(v: number): string {
  return v > 0 ? 'up-text' : v < 0 ? 'down-text' : 'muted'
}

/** 价格按最小变动单位显示：股票 2 位小数、ETF 3 位 */
function fmtPrice(v: number, tick: number): string {
  return v.toFixed(tick === 0.001 ? 3 : 2)
}

/** 收益率展示：正数带 + 号并标红（A股惯例红涨） */
function pct(v: number, digits = 1): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`
}

type BuyHit = ScanReport['buys'][number]
type StockPerf = TrackStats['perStock'][number]

function BuyItem({
  b, perf, expanded, guide, guideLoading, favorite, onToggleGuide, onToggleFavorite,
}: {
  b: BuyHit
  perf?: StockPerf
  expanded: boolean
  guide: PriceGuide | null
  guideLoading: boolean
  favorite: boolean
  onToggleGuide: (code: string) => void
  onToggleFavorite: (code: string, name: string) => void
}) {
  return (
    <article className={`scan-item${expanded ? ' expanded' : ''}`}>
      <div className="scan-main">
        <div className="scan-title">
          <div>
            <span className="scan-name">{b.name}</span>
            <span className="scan-code num">{b.code} · {b.kind === 'etf' ? 'ETF' : '股票'}</span>
          </div>
          <span className="scan-weight num">
            {b.buyWeight.toFixed(1)}%
            <small>买方权重</small>
          </span>
        </div>

        <div className="scan-facts">
          <div><span>现价</span><b className="num">{b.price.toFixed(2)}</b></div>
          <div><span>今日涨跌</span><b className={`num ${changeClass(b.changePercent)}`}>{b.changePercent.toFixed(2)}%</b></div>
          <div><span>历史回合</span><b className="num">{perf ? `${perf.rounds} 回合` : '—'}</b></div>
          <div><span>回合胜率</span><b className="num">{perf ? `${perf.winRate.toFixed(0)}%` : '—'}</b></div>
          <div><span>平均收益</span><b className={`num ${perf ? changeClass(perf.avgReturn) : ''}`}>{perf ? pct(perf.avgReturn) : '—'}</b></div>
        </div>

        <div className="scan-actions">
          <button
            className="btn btn-sm"
            aria-pressed={favorite}
            onClick={() => onToggleFavorite(b.code, b.name)}
          >
            {favorite ? '★ 已收藏' : '☆ 收藏'}
          </button>
          <button
            className="btn btn-sm"
            aria-pressed={expanded}
            title="ATR 三档挂价参考（激进/稳健/保守）"
            onClick={() => onToggleGuide(b.code)}
          >
            {expanded ? '收起详情' : '查看详情'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="scan-detail">
          <GuidePanel title="赛马理由">
            <p>{b.reason}</p>
            {perf && (
              <p className="guide-note">
                历史表现：{perf.rounds} 回合 · 胜率 {perf.winRate.toFixed(0)}% · 平均 {pct(perf.avgReturn)}
              </p>
            )}
          </GuidePanel>

          <GuidePanel title="挂价参考">
            {guideLoading && <p className="muted">计算挂价参考中…</p>}
            {!guideLoading && !guide && <p className="muted">暂无数据</p>}
            {!guideLoading && guide && !guide.available && <p className="muted">{guide.reason}</p>}
            {!guideLoading && guide && guide.available && (
              <>
                <p className="guide-note">
                  基准现价 {fmtPrice(guide.price, guide.tick)}（{guide.at} 时点） · ATR(14) {fmtPrice(guide.atr, guide.tick)}（日均 ±{guide.atrPercent.toFixed(1)}%） · 近20日低点 {fmtPrice(guide.support, guide.tick)}
                </p>
                <div className="guide-limits">
                  <span className="down-text">今日跌停 {guide.limitDown != null ? fmtPrice(guide.limitDown, guide.tick) : '—'}</span>
                  <span className="up-text">今日涨停 {guide.limitUp != null ? fmtPrice(guide.limitUp, guide.tick) : '—'}</span>
                  {guide.limitClamped && <span className="muted">已按涨跌停范围裁剪</span>}
                </div>
                <div className="guide-tiers">
                  {guide.tiers.map((t) => (
                    <div key={t.key}>
                      <b>{t.label}</b>
                      <span className="num">{fmtPrice(t.price, guide.tick)}</span>
                      <small>{t.fillOdds}</small>
                      <p>{t.note}</p>
                    </div>
                  ))}
                </div>
                <p className="guide-note">{guide.advice}</p>
                <p className="guide-note">
                  参考基于 {guide.at} 时点：盘中股价变动后请重新点开刷新；越临近尾盘，参考越可信。
                </p>
              </>
            )}
          </GuidePanel>
        </div>
      )}
    </article>
  )
}

export default function ScreenerView() {
  const [report, setReport] = useState<ScanReport | null>(null)
  const [track, setTrack] = useState<TrackStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null)
  const [minPrice, setMinPrice] = useState('5')
  const [maxPrice, setMaxPrice] = useState('25')
  const [maxCandidates, setMaxCandidates] = useState('100')
  const [favs, setFavs] = useState<FavStock[]>(loadFavorites)
  /** 两击确认删除：处于确认态的股票代码（3 秒不点自动复位） */
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  /** 挂价参考：当前展开的 BUY 行（懒加载，点哪只算哪只） */
  const [guideCode, setGuideCode] = useState<string | null>(null)
  const [guide, setGuide] = useState<PriceGuide | null>(null)
  const [guideLoading, setGuideLoading] = useState(false)

  useEffect(() => {
    void fetchScan().then((r) => setReport(r.report)).catch(() => { /* 无历史结果 */ })
    void fetchTrackStats().then(setTrack).catch(() => { /* 无追踪样本 */ })
    // 接管进行中的扫描：切页回来时按钮保持禁用，扫描完成直接在本页显示新结果
    const ongoing = ongoingScan()
    if (!ongoing) return
    setLoading(true)
    ongoing.then((r) => {
      setReport(r.report)
      clearGuide()
      setMsg({ kind: 'ok', text: `扫描完成：精算 ${r.report.scanned} 只，买入信号 ${r.report.buys.length} 只` })
      void fetchTrackStats().then(setTrack).catch(() => { /* 忽略 */ })
    }).catch((e: unknown) => {
      setMsg({ kind: 'err', text: `扫描失败：${(e as Error).message}` })
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => subscribeFavorites(setFavs), [])

  const run = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const r = await scanNow({ minPrice: Number(minPrice) || undefined, maxPrice: Number(maxPrice) || undefined, maxCandidates: Number(maxCandidates) || undefined })
      setReport(r.report)
      clearGuide()
      setMsg({ kind: 'ok', text: `扫描完成：精算 ${r.report.scanned} 只，买入信号 ${r.report.buys.length} 只` })
      // 扫描后追踪账本可能新增样本/有在途回合结算，刷新统计
      void fetchTrackStats().then(setTrack).catch(() => { /* 忽略 */ })
    } catch (e) {
      setMsg({ kind: 'err', text: `扫描失败：${(e as Error).message}` })
    } finally {
      setLoading(false)
    }
  }, [minPrice, maxPrice, maxCandidates])

  const isFav = (code: string) => favs.some((f) => f.code === code)
  const perf = new Map((track?.perStock ?? []).map((p) => [p.code, p]))

  /** 展开/收起某只 BUY 股的挂价参考卡 */
  const toggleGuide = useCallback(async (code: string) => {
    if (guideCode === code) {
      setGuideCode(null)
      setGuide(null)
      return
    }
    setGuideCode(code)
    setGuide(null)
    setGuideLoading(true)
    try {
      setGuide(await fetchPriceGuide(code))
    } catch (e) {
      setMsg({ kind: 'err', text: `挂价参考失败：${(e as Error).message}` })
    } finally {
      setGuideLoading(false)
    }
  }, [guideCode])

  /** 新扫描结果覆盖旧名单时，旧选中可能已不在表里，挂价卡一并收起 */
  const clearGuide = useCallback(() => { setGuideCode(null); setGuide(null) }, [])

  const removeStock = useCallback(async (code: string) => {
    try {
      await deleteTrackStock(code)
      setMsg({ kind: 'ok', text: `已删除 ${code} 的全部追踪记录` })
      void fetchTrackStats().then(setTrack).catch(() => { /* 忽略 */ })
    } catch (e) {
      setMsg({ kind: 'err', text: `删除失败：${(e as Error).message}` })
    } finally {
      setConfirmDel(null)
    }
  }, [])

  return (
    <>
      <section className="card">
        <h2>选股推荐</h2>
        <p className="sub">
          漏斗式扫描沪深主板：快照粗筛（价格区间/非ST/非次新/非涨跌停/成交额）→ 逐只精算策略赛马 → 输出买入信号名单。
          实盘已持仓股自动排除。默认精算 100 只约需 30~60 秒，建议收盘后使用。
        </p>
        <div className="controls-row">
          <div className="field">
            <label htmlFor="scan-min">最低价（元）</label>
            <input id="scan-min" className="field-short" inputMode="decimal" autoComplete="off" spellCheck={false} value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="scan-max">最高价（元）</label>
            <input id="scan-max" className="field-short" inputMode="decimal" autoComplete="off" spellCheck={false} value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="scan-cap">精算上限（只）</label>
            <input id="scan-cap" className="field-short" inputMode="numeric" min={10} max={100} autoComplete="off" spellCheck={false} value={maxCandidates}
              onChange={(e) => setMaxCandidates(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={loading} onClick={() => void run()}>
            {loading ? '扫描中…（默认 100 只约 30~60 秒）' : '开始扫描'}
          </button>
        </div>
        {msg && <div className={`toast ${msg.kind}`} role="status">{msg.text}</div>}
      </section>

      {report && (
        <>
          <section className="card">
            <h2>扫描结果（{new Date(report.at).toLocaleString()}）</h2>
            <ScanFunnel
              market={report.totalMarket}
              filtered={report.passedFilter}
              scanned={report.scanned}
              etfScanned={report.etfScanned}
              buys={report.buys.length}
            />
            {report.excludedHeld.length > 0 && (
              <p className="sub">已排除实盘持仓 {report.excludedHeld.length} 只：{report.excludedHeld.join('、')}</p>
            )}
          </section>

          {report.buys.length > 0 ? (
            <section className="card">
              <h2>买入信号（按买方权重排序）</h2>
              <div className="scan-list">
                {report.buys.map((b) => (
                  <BuyItem
                    key={b.code}
                    b={b}
                    perf={perf.get(b.code)}
                    expanded={guideCode === b.code}
                    guide={guideCode === b.code ? guide : null}
                    guideLoading={guideCode === b.code && guideLoading}
                    favorite={isFav(b.code)}
                    onToggleGuide={(code) => void toggleGuide(code)}
                    onToggleFavorite={(code, name) => setFavs(toggleFavorite(code, name))}
                  />
                ))}
              </div>
            </section>
          ) : (
            <section className="card">
              <div className="empty">本次扫描无买入信号。信号稀疏是策略的保守特性——没把握就不动手，别硬凑。</div>
            </section>
          )}
        </>
      )}

      {track && (
        <section className="card">
          <h2>信号质量追踪</h2>
          <p className="sub">
            给策略每次喊买记账，等它喊卖（或超 60 个交易日）按收盘价验收。「回合」= 一段连续买入 + 最终卖出，与回测同口径；
            连续喊买逐条另计为「信号」，用于观察追高惩罚。胜率低不代表差——配合盈亏比一起看。
            分红送转导致历史前复权价格变化时，会自动重算在途信号的入场基准，避免收益被除权跳变扭曲。
            注意：下方平均收益/胜率只统计<b>已结算</b>回合，在途回合的实时浮盈亏不计入，等结算后才进统计。
          </p>
          {track.roundLayer.settled === 0 && track.roundLayer.pending === 0 ? (
            <div className="empty">还没有追踪样本：扫描出买入信号后会自动补历史并开始记账。</div>
          ) : (
            <>
              <div className="metric-grid track-grid">
                <Metric label="回合样本" value={String(track.roundLayer.settled)} />
                <Metric label="回合胜率" value={`${track.roundLayer.winRate.toFixed(0)}%`} />
                <Metric label="平均收益" value={pct(track.roundLayer.avgReturn)} cls={changeClass(track.roundLayer.avgReturn)} />
                <Metric label="平均赚 / 亏" value={`${pct(track.roundLayer.avgWin)} / ${pct(track.roundLayer.avgLoss)}`} />
                <Metric label="盈亏比" value={track.roundLayer.profitFactor > 0 ? track.roundLayer.profitFactor.toFixed(2) : '—'} />
                <Metric label="平均持仓" value={track.roundLayer.avgDays > 0 ? `${track.roundLayer.avgDays.toFixed(0)} 天` : '—'} />
                <Metric label="最大连亏" value={`${track.roundLayer.maxConsecutiveLosses} 次`} />
                <Metric label="在途回合" value={String(track.roundLayer.pending)} />
                <Metric label="除权修正" value={`${track.adjustedEntries} 条`} />
              </div>
              <p className="sub track-layer">
                信号层：{track.signalLayer.settled} 条已结算 · 胜率 {track.signalLayer.winRate.toFixed(0)}% · 平均 {pct(track.signalLayer.avgReturn)}
                （同一回合的重复喊买逐条计入）
              </p>
              {track.perStock.length > 0 && (
                <div className="table-wrap track-table">
                  <table className="data">
                    <thead>
                      <tr><th>按股样本</th><th>回合</th><th>回合胜率</th><th>平均收益</th><th>在途</th><th>操作</th></tr>
                    </thead>
                    <tbody>
                      {track.perStock.map((p) => (
                        <tr key={p.code}>
                          <td>{p.code} {p.name ?? ''}</td>
                          <td className="num">{p.rounds}</td>
                          <td className="num">{p.winRate.toFixed(0)}%</td>
                          <td className={`num ${changeClass(p.avgReturn)}`}>{pct(p.avgReturn)}</td>
                          <td className="num">{p.pending || <span className="muted">—</span>}</td>
                          <td>
                            <button
                              className="btn btn-sm"
                              title="删除该股全部追踪记录（含已结算样本）；下次它再触发买入信号会重新补历史"
                              onClick={() => {
                                if (confirmDel === p.code) { void removeStock(p.code); return }
                                setConfirmDel(p.code)
                                setTimeout(() => setConfirmDel((c) => (c === p.code ? null : c)), 3000)
                              }}
                            >
                              {confirmDel === p.code ? '确认删除？' : '删除'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {track.pending.length > 0 && (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>在途回合</th><th>入场日</th><th>入场价</th><th>现价</th><th>浮动</th></tr>
                    </thead>
                    <tbody>
                      {track.pending.map((p) => (
                        <tr key={p.code}>
                          <td>{p.code} {p.name ?? ''}</td>
                          <td>{p.entryDate}</td>
                          <td className="num">{p.entryPrice.toFixed(2)}</td>
                          <td className="num">{p.currentPrice != null ? p.currentPrice.toFixed(2) : '—'}</td>
                          <td className={`num ${p.floatPercent != null ? changeClass(p.floatPercent) : 'muted'}`}>
                            {p.floatPercent != null ? pct(p.floatPercent, 2) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </>
  )
}
