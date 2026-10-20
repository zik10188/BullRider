// 信号质量追踪（回合制）：给策略每一次喊话记账，事后核对真实涨跌——评价"信号准不准"的正经尺子。
// 两层口径（存最细粒度、统计按需聚合）：
//   信号层：每条 BUY 独立结算（连续喊买各记一条）→ 观察追高惩罚（越晚上车吃得越少）
//   回合层：一段连续 BUY + 最终 SELL 合并为一个回合（入场价取最早一条）→ 与回测 trade 同口径，可直接对账
// 结算规则：等到 SELL 按当日收盘结算；超 TIMEOUT_BARS 根K线还没等到 → 按最新收盘强制结算并标记超时
// 存储 .data/signal-track.json；外部依赖（行情/策略）全部由调用方注入，纯逻辑可离线测试
import type { SignalKind } from '../signal/types'
import { MIN_BARS } from '../signal/composite'
import type { KLine } from '../market-data/types'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

/** 在途超时线：超过这么多根K线还没等到 SELL，按最新收盘强制结算（约一个季度） */
export const TIMEOUT_BARS = 60

const DEFAULT_DIR = resolve(process.cwd(), '.data')

export type TrackSource = 'scan' | 'replay'

/** 一条 BUY 信号账（信号层样本）；exit 写入后即视为已结算 */
export interface SignalEntry {
  code: string
  name?: string
  /** 信号日 YYYY-MM-DD */
  date: string
  /** 信号日收盘价（入场基准） */
  price: number
  source: TrackSource
  /** 被哪一次 SELL 事件结算：同一回合的所有 BUY 共享同一个 id */
  settleId?: string
  exit?: {
    date: string
    price: number
    reason: 'SELL' | 'TIMEOUT'
    returnPercent: number
    /** 持仓交易日数（K线根数差，与回测 days 同口径；日期定位不到时留空） */
    days?: number
  }
}

export interface TrackStore {
  signals: SignalEntry[]
  /** 每只股票 replay 补历史回放到的最后日期（幂等，防止每次扫描重算 190 次 evaluate） */
  replayed?: Record<string, string>
}

/** 一段信号流事件（回放/检查产出） */
export interface TrackEvent {
  date: string
  price: number
  kind: 'BUY' | 'SELL'
}

export function newId(): string {
  return Date.now().toString(36) + randomBytes(3).toString('hex')
}

/**
 * 把一段按时间序的信号流入账：BUY 按日期去重后入账；SELL 结算该股全部在途信号（同一 SELL 事件）。
 * 空仓时来的 SELL 没得结算，直接丢弃。返回新增的 BUY 条数。
 */
export function ingestSignals(store: TrackStore, code: string, name: string | undefined, events: TrackEvent[], source: TrackSource): number {
  const mine = () => store.signals.filter((s) => s.code === code)
  let added = 0
  for (const ev of events) {
    if (ev.kind === 'BUY') {
      if (mine().some((s) => s.date === ev.date)) continue // 同日重复喊买只记一条
      store.signals.push({ code, name, date: ev.date, price: ev.price, source })
      added++
    } else {
      const pending = mine().filter((s) => !s.exit)
      if (pending.length === 0) continue // 空仓 SELL：丢弃
      const sid = newId()
      for (const p of pending) {
        p.settleId = sid
        p.exit = { date: ev.date, price: ev.price, reason: 'SELL', returnPercent: (ev.price / p.price - 1) * 100 }
      }
    }
  }
  return added
}

/** 已结算回合（回合层样本，与回测 trade 同口径） */
export interface TrackedRound {
  code: string
  name?: string
  entryDate: string
  entryPrice: number
  exitDate: string
  exitPrice: number
  returnPercent: number
  days?: number
  reason: 'SELL' | 'TIMEOUT'
  /** 回合内 BUY 条数：>1 说明趋势中重复喊买，可对照信号层观察追高惩罚 */
  buyCount: number
}

/** 回合层聚合：同一 settleId 的 BUY 合并为一个回合，入场价取最早一条 */
export function deriveRounds(store: TrackStore): TrackedRound[] {
  const groups = new Map<string, SignalEntry[]>()
  for (const s of store.signals) {
    if (!s.settleId || !s.exit) continue
    const arr = groups.get(s.settleId) ?? []
    arr.push(s)
    groups.set(s.settleId, arr)
  }
  const rounds: TrackedRound[] = []
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date))
    const first = arr[0]
    const ex = first.exit!
    rounds.push({
      code: first.code,
      name: first.name,
      entryDate: first.date,
      entryPrice: first.price,
      exitDate: ex.date,
      exitPrice: ex.price,
      returnPercent: (ex.price / first.price - 1) * 100,
      days: ex.days,
      reason: ex.reason,
      buyCount: arr.length,
    })
  }
  return rounds.sort((a, b) => a.exitDate.localeCompare(b.exitDate))
}

/** 在途信号组（同一只股票的所有未结算 BUY，最早在前） */
export interface PendingGroup {
  code: string
  name?: string
  entries: SignalEntry[]
}

export function derivePending(store: TrackStore): PendingGroup[] {
  const groups = new Map<string, SignalEntry[]>()
  for (const s of store.signals) {
    if (s.exit) continue
    const arr = groups.get(s.code) ?? []
    arr.push(s)
    groups.set(s.code, arr)
  }
  return [...groups.values()].map((arr) => {
    arr.sort((a, b) => a.date.localeCompare(b.date))
    return { code: arr[0].code, name: arr[0].name, entries: arr }
  })
}

export interface LayerStats {
  settled: number
  pending: number
  /** 胜率（returnPercent > 0 记赢，与回测引擎同口径） */
  winRate: number
  /** 已结算样本的平均收益% */
  avgReturn: number
  avgWin: number
  avgLoss: number
  /** 盈亏比 = 平均赚 / |平均亏| */
  profitFactor: number
  /** 平均持仓交易日数（无 days 样本则 0） */
  avgDays: number
  /** 按结算时间排序的最长连续亏损次数（跟单体验：连亏 N 次你还执行第 N+1 次吗） */
  maxConsecutiveLosses: number
}

/** 一层口径的统计（信号层/回合层通用） */
export function layerStats(settled: Array<{ returnPercent: number; days?: number; exitDate: string }>, pendingCount: number): LayerStats {
  const rets = settled.map((s) => s.returnPercent)
  const wins = rets.filter((r) => r > 0)
  const losses = rets.filter((r) => r <= 0)
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
  const dayArr = settled.map((s) => s.days).filter((d): d is number => typeof d === 'number')
  let cur = 0
  let maxStreak = 0
  for (const s of [...settled].sort((a, b) => a.exitDate.localeCompare(b.exitDate))) {
    if (s.returnPercent <= 0) maxStreak = Math.max(maxStreak, ++cur)
    else cur = 0
  }
  return {
    settled: settled.length,
    pending: pendingCount,
    winRate: settled.length ? (wins.length / settled.length) * 100 : 0,
    avgReturn: settled.length ? rets.reduce((a, b) => a + b, 0) / settled.length : 0,
    avgWin,
    avgLoss,
    profitFactor: avgWin > 0 && avgLoss < 0 ? avgWin / Math.abs(avgLoss) : 0,
    avgDays: dayArr.length ? dayArr.reduce((a, b) => a + b, 0) / dayArr.length : 0,
    maxConsecutiveLosses: maxStreak,
  }
}

// ================= 存储与流程（依赖注入，便于测试） =================

function trackFile(dir: string): string {
  return resolve(dir, 'signal-track.json')
}

export async function loadTrack(dir: string = DEFAULT_DIR): Promise<TrackStore> {
  try {
    const obj = JSON.parse(await readFile(trackFile(dir), 'utf-8')) as TrackStore
    return { signals: Array.isArray(obj.signals) ? obj.signals : [], replayed: obj.replayed ?? {} }
  } catch {
    return { signals: [], replayed: {} }
  }
}

export async function saveTrack(store: TrackStore, dir: string = DEFAULT_DIR): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(trackFile(dir), JSON.stringify(store, null, 2), 'utf-8')
}

/** 删除某只股票的全部追踪记录（含已结算样本），并清除其补历史标记——下次它再触发 BUY 会重新补历史。返回删除条数 */
export async function deleteStock(code: string, dir: string = DEFAULT_DIR): Promise<number> {
  const store = await loadTrack(dir)
  const kept = store.signals.filter((s) => s.code !== code)
  const removed = store.signals.length - kept.length
  if (removed === 0 && !store.replayed?.[code]) return 0
  store.signals = kept
  if (store.replayed) delete store.replayed[code]
  await saveTrack(store, dir)
  return removed
}

export interface TrackDeps {
  /** 拉日K（Web 端传 ctx.marketData.daily，自动复用磁盘缓存） */
  daily: (symbol: string, days: number) => Promise<KLine[]>
  /** 策略评估：对截至当前的日K给出信号（注入 composite 赛马） */
  evaluate: (klines: KLine[]) => SignalKind
  log?: (msg: string) => void
}

/** 结算后补持仓天数：在K线里定位出入日期差（定位不到留空，统计时自动跳过） */
function backfillDays(store: TrackStore, code: string, klines: KLine[]): void {
  const idxOf = (date: string) => klines.findIndex((k) => k.date >= date)
  for (const s of store.signals) {
    if (s.code !== code || !s.exit || s.exit.days != null) continue
    const ei = idxOf(s.date)
    const xi = idxOf(s.exit.date)
    if (ei >= 0 && xi > ei) s.exit.days = xi - ei
  }
}

/**
 * 对一只股票补历史：过去 250 根日K逐日滑窗过一遍策略，历史信号全部入账（含结算）。
 * 幂等：已回放到最新日K则直接跳过，不重复烧 evaluate。
 */
export async function replayStock(code: string, name: string | undefined, deps: TrackDeps, dir: string = DEFAULT_DIR): Promise<number> {
  const store = await loadTrack(dir)
  let klines: KLine[]
  try {
    klines = await deps.daily(code, 250)
  } catch (err) {
    // 行情接口故障（限频/断连）：跳过该股且不写 replayed 标记，下次扫描自动重试补账
    deps.log?.(`补历史 ${code}${name ? ` ${name}` : ''} 失败（行情接口异常，下次扫描自动重试）: ${(err as Error).message}`)
    return 0
  }
  if (klines.length < MIN_BARS) return 0 // 次新股/数据不足：跳过
  const lastDate = klines[klines.length - 1].date
  if (store.replayed?.[code] === lastDate) return 0
  const events: TrackEvent[] = []
  for (let i = MIN_BARS - 1; i < klines.length; i++) {
    let kind: SignalKind
    try {
      kind = deps.evaluate(klines.slice(0, i + 1))
    } catch {
      continue // 个别窗口算不动：跳过该天
    }
    if (kind !== 'HOLD') events.push({ date: klines[i].date, price: klines[i].close, kind })
  }
  const added = ingestSignals(store, code, name, events, 'replay')
  store.replayed = { ...store.replayed, [code]: lastDate }
  backfillDays(store, code, klines)
  await saveTrack(store, dir)
  deps.log?.(`补历史 ${code}${name ? ` ${name}` : ''}：日K ${klines.length} 根，入账 ${added} 条`)
  return added
}

/**
 * 结算检查：对每只股票的在途回合，从其最早信号次日起逐日回放找错过的 SELL；
 * 回放完仍无 SELL 且在途跨度超过 TIMEOUT_BARS → 按最新收盘强制结算（TIMEOUT）。
 * 返回本次结算的回合数与检查的股票数。
 */
export async function settleCheck(deps: TrackDeps, dir: string = DEFAULT_DIR): Promise<{ settled: number; checked: number }> {
  const store = await loadTrack(dir)
  const groups = derivePending(store)
  let settled = 0
  for (const g of groups) {
    let klines: KLine[]
    try {
      klines = await deps.daily(g.code, 250)
    } catch {
      continue // 行情拉不到（停牌/退市）：保持在途，下次再查
    }
    if (klines.length === 0) continue
    const events: TrackEvent[] = []
    for (let i = 0; i < klines.length; i++) {
      const k = klines[i]
      if (k.date <= g.entries[0].date) continue // 增量：在途最早信号之后才开始回放
      let kind: SignalKind
      try {
        kind = deps.evaluate(klines.slice(0, i + 1))
      } catch {
        continue
      }
      if (kind !== 'HOLD') events.push({ date: k.date, price: k.close, kind })
    }
    // 记录本次检查开始时已在途的条目。回放可能先结算旧信号、再新增 BUY，
    // 因此不能在 ingest 后比较“在途数量”，否则会把新信号误认为旧信号仍未结算。
    const initialEntries = g.entries
    ingestSignals(store, g.code, g.name, events, 'scan')
    let didSettle = initialEntries.some((entry) => Boolean(entry.exit))
    // 没等到 SELL 的条目再单独做超时判断；新产生的 BUY 不在 initialEntries 中，不会被误结算。
    const lastK = klines[klines.length - 1]
    const timeoutId = newId()
    for (const entry of initialEntries) {
      if (entry.exit) continue
      const entryIndex = klines.findIndex((k) => k.date >= entry.date)
      const span = entryIndex < 0 ? Number.MAX_SAFE_INTEGER : klines.length - 1 - entryIndex
      if (span <= TIMEOUT_BARS) continue
      entry.settleId = timeoutId
      entry.exit = {
        date: lastK.date,
        price: lastK.close,
        reason: 'TIMEOUT',
        returnPercent: (lastK.close / entry.price - 1) * 100,
        days: entryIndex >= 0 ? klines.length - 1 - entryIndex : undefined,
      }
      didSettle = true
    }
    if (didSettle) settled++
    backfillDays(store, g.code, klines)
    await new Promise((r) => setTimeout(r, 100)) // 限速，保护免费接口
  }
  await saveTrack(store, dir)
  return { settled, checked: groups.length }
}

// ================= 统计输出 =================

export interface PendingView {
  code: string
  name?: string
  entryDate: string
  entryPrice: number
  currentPrice?: number
  floatPercent?: number
}

export interface PerStockStats {
  code: string
  name?: string
  rounds: number
  winRate: number
  avgReturn: number
  pending: number
}

export interface TrackStats {
  signalLayer: LayerStats
  roundLayer: LayerStats
  perStock: PerStockStats[]
  pending: PendingView[]
}

/** 全账本统计：两层口径 + 每股回合表现 + 在途回合（含实时浮盈，行情拉不到则留空） */
export async function trackStats(quote: (symbol: string) => Promise<{ price: number }>, dir: string = DEFAULT_DIR): Promise<TrackStats> {
  const store = await loadTrack(dir)
  const rounds = deriveRounds(store)
  const pendingGroups = derivePending(store)
  const signalLayer = layerStats(
    store.signals.filter((s) => s.exit).map((s) => ({ returnPercent: s.exit!.returnPercent, days: s.exit!.days, exitDate: s.exit!.date })),
    store.signals.filter((s) => !s.exit).length,
  )
  const roundLayer = layerStats(
    rounds.map((r) => ({ returnPercent: r.returnPercent, days: r.days, exitDate: r.exitDate })),
    pendingGroups.length,
  )
  const book = new Map<string, { name?: string; rounds: number; wins: number; sum: number; pending: number }>()
  for (const r of rounds) {
    const e = book.get(r.code) ?? { name: r.name, rounds: 0, wins: 0, sum: 0, pending: 0 }
    if (!e.name && r.name) e.name = r.name
    e.rounds++
    if (r.returnPercent > 0) e.wins++
    e.sum += r.returnPercent
    book.set(r.code, e)
  }
  for (const g of pendingGroups) {
    const e = book.get(g.code) ?? { name: g.name, rounds: 0, wins: 0, sum: 0, pending: 0 }
    if (!e.name && g.name) e.name = g.name
    e.pending++
    book.set(g.code, e)
  }
  const perStock: PerStockStats[] = [...book.entries()]
    .map(([code, e]) => ({ code, name: e.name, rounds: e.rounds, winRate: e.rounds ? (e.wins / e.rounds) * 100 : 0, avgReturn: e.rounds ? e.sum / e.rounds : 0, pending: e.pending }))
    .sort((a, b) => b.rounds - a.rounds)
  const pending: PendingView[] = []
  for (const g of pendingGroups) {
    let currentPrice: number | undefined
    try {
      currentPrice = (await quote(g.code)).price
    } catch { /* 拉不到就显示 '-' */ }
    pending.push({
      code: g.code,
      name: g.name,
      entryDate: g.entries[0].date,
      entryPrice: g.entries[0].price,
      currentPrice,
      floatPercent: currentPrice != null ? (currentPrice / g.entries[0].price - 1) * 100 : undefined,
    })
  }
  return { signalLayer, roundLayer, perStock, pending }
}
