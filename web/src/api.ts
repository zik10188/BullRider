// 前端 API 客户端（调用后端同源 /api）

export interface Quote {
  name: string
  price: number
  changePercent: number
  open: number
}

export interface KLine {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface SignalInfo {
  kind: 'BUY' | 'SELL' | 'HOLD'
  date: string
  price: number
  strategy: string
  reason: string
  indicators: { ma5: number; ma10: number }
}

export interface BacktestResult {
  symbol: string
  name: string
  strategy: string
  periodStart: string
  periodEnd: string
  barCount: number
  initialCapital: number
  finalEquity: number
  totalReturnPercent: number
  buyHoldReturnPercent: number
  excessReturnPercent: number
  tradeCount: number
  winRate: number
  maxDrawdownPercent: number
  trades: Array<{ entryDate: string; exitDate: string; entryPrice: number; exitPrice: number; returnPercent: number; days: number }>
}

export interface SnapshotPosition {
  symbol: string
  name: string
  shares: number
  avgCost: number
  price: number
  value: number
  profit: number
  profitPercent: number
}

export interface PaperSnapshot {
  exists: boolean
  capital: number
  cash: number
  equity: number
  totalProfit: number
  totalProfitPercent: number
  positions: SnapshotPosition[]
  trades: Array<{ date: string; symbol: string; name: string; side: 'BUY' | 'SELL' | 'DEPOSIT'; price: number; shares: number; amount: number; fee: number; profit?: number }>
  /** 资产曲线（每次操作后的总资产快照） */
  equityHistory: Array<{ date: string; equity: number }>
}

export interface OpResult {
  ok: boolean
  message: string
  fill?: { shares: number; amount: number; fee: number; profit?: number }
  signal?: { kind: string; reason: string }
  action?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = (await res.json()) as T & { ok?: boolean; message?: string }
  if (!res.ok) throw new Error(body.message || `请求失败 (${res.status})`)
  return body
}

function post<T>(path: string, data: Record<string, unknown>): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export const STRATEGIES = [
  { id: 'ma-cross', label: '均线金叉死叉' },
  { id: 'rsi', label: 'RSI 超买超卖' },
  { id: 'macd', label: 'MACD 动能' },
  { id: 'donchian', label: '唐奇安突破' },
  { id: 'bollinger', label: '布林带通道' },
  { id: 'composite', label: '策略赛马' },
] as const

export const fetchQuote = (symbol: string): Promise<Quote> => request(`/api/quote/${symbol}`)

/** 挂价参考：ATR 三档限价建议 */
export interface PriceTier {
  key: 'aggressive' | 'steady' | 'conservative'
  label: string
  price: number
  fillOdds: string
  note: string
}

export type PriceGuide =
  | {
      available: true
      price: number
      /** 计算时刻（本地 HH:mm） */
      at: string
      atr: number
      atrPercent: number
      tick: number
      support: number
      limitUp?: number
      limitDown?: number
      limitClamped: boolean
      tiers: PriceTier[]
      advice: string
    }
  | { available: false; reason: string }

export const fetchPriceGuide = (code: string): Promise<PriceGuide> => request(`/api/price-guide/${code}`)

export const fetchSignal = (symbol: string, days = 60, strategy = 'ma-cross'): Promise<{ symbol: string; name: string; klines: KLine[]; signal: SignalInfo }> =>
  request(`/api/signal/${symbol}?days=${days}&strategy=${strategy}`)

export const fetchBacktest = (symbol: string, days = 250, capital = 200000, strategy = 'ma-cross'): Promise<BacktestResult> =>
  request(`/api/backtest/${symbol}?days=${days}&capital=${capital}&strategy=${strategy}`)

export const fetchPaper = (): Promise<PaperSnapshot> => request('/api/paper')

export const paperInit = (capital: number, force: boolean): Promise<OpResult> => post('/api/paper/init', { capital, force })
export const paperBuy = (symbol: string, amount?: number): Promise<OpResult> => post('/api/paper/buy', { symbol, amount })
export const paperSell = (symbol: string, shares?: number): Promise<OpResult> => post('/api/paper/sell', { symbol, shares })
export const paperDeposit = (amount: number): Promise<OpResult> => post('/api/paper/deposit', { amount })
export const paperApply = (symbol: string, strategy = 'ma-cross'): Promise<OpResult> => post('/api/paper/apply', { symbol, strategy })

// ---------- 用户偏好（服务端 .data/prefs.json 持久化，换浏览器/换电脑不丢） ----------
// API Key 由服务端 AES-256-GCM 加密存储（.data/prefs.key 是密钥），前端永远只见到掩码。

export interface LlmSettings {
  baseUrl: string
  model: string
  contextWindow: number
  /** 服务端是否已存 Key（Key 本体永不下发浏览器） */
  hasKey: boolean
  keyMask?: string
}

export interface ChatMsg {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export const chatSend = (messages: ChatMsg[], settings: LlmSettings, symbols?: string[], strategy?: string): Promise<{ ok: boolean; reply?: string; message?: string }> =>
  post('/api/chat', { messages, config: { baseUrl: settings.baseUrl, model: settings.model, contextWindow: settings.contextWindow }, symbols, strategy })

export interface ServerPrefs {
  favorites: Array<{ code: string; name?: string }>
  chat: ChatMsg[]
  llm?: LlmSettings
  lastSymbol?: string
  queryHistory?: Array<{ code: string; name?: string }>
}

export const fetchPrefs = (): Promise<ServerPrefs> => request('/api/prefs')

export function savePrefs(p: { favorites?: unknown[]; chat?: unknown[]; lastSymbol?: string; queryHistory?: Array<{ code: string; name?: string }>; llm?: { baseUrl?: string; model?: string; contextWindow?: number; apiKey?: string } }): Promise<{ ok: boolean; llm?: LlmSettings }> {
  return request('/api/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  })
}

/** 旧版 localStorage 明文 Key 的迁移用键名 */
export const LEGACY_LLM_KEY = 'bullrider.llm'

// ---------- 实盘记录（手工同步真实券商成交，AI 教练据此对齐认知） ----------

export interface RealTrade {
  id: string
  date: string
  code: string
  name?: string
  side: 'BUY' | 'SELL'
  price: number
  shares: number
  fee?: number
}

export interface RealPosition {
  code: string
  name?: string
  shares: number
  avgCost: number
  positionCost: number
  totalSellAmount: number
  currentPrice: number
  marketValue: number
  profit: number
  profitPercent: number
  /** 该持仓股的策略赛马建议（拉不到数据时无此字段） */
  signal?: { kind: 'BUY' | 'SELL' | 'HOLD'; reason: string }
  /** 卖出参考（日K不足或行情异常时无此字段/不可用） */
  sellGuide?: RealSellGuide
}

export type RealSellGuide =
  | {
      available: true
      price: number
      at: string
      tick: number
      atr: number
      atrPercent: number
      costPrice: number
      support: number
      resistance: number
      stopLossPrice: number
      protectionPrice: number
      effectiveStopPrice: number
      distanceToStopPercent: number
      targets: Array<{ key: 'target-1' | 'target-2'; label: string; price: number; note: string }>
      trend: 'BUY' | 'SELL' | 'HOLD' | null
      trendLabel: string
      riskTriggered: boolean
      advice: string
    }
  | { available: false; reason: string }

export interface RealJournal {
  trades: RealTrade[]
  positions: RealPosition[]
}

export const fetchReal = (): Promise<RealJournal> => request('/api/real')

export const addRealTrade = (t: Omit<RealTrade, 'id'>): Promise<{ ok: boolean; trade: RealTrade }> =>
  post('/api/real', t)

export const deleteRealTrade = (id: string): Promise<{ ok: boolean }> => request(`/api/real/${id}`, { method: 'DELETE' })

// ---------- 选股推荐（漏斗式全市场扫描） ----------

export interface ScanOptions {
  minPrice: number
  maxPrice: number
  maxCandidates: number
  minAmount: number
}

export interface ScanHit {
  code: string
  name: string
  price: number
  changePercent: number
  buyWeight: number
  /** 品种类型：etf = 白名单池，stock = 快照漏斗 */
  kind: 'stock' | 'etf'
  reason: string
}

export interface ScanReport {
  id: string
  at: string
  options: ScanOptions
  totalMarket: number
  passedFilter: number
  excludedHeld: string[]
  scanned: number
  /** ETF 白名单池本次精算的只数 */
  etfScanned: number
  buys: ScanHit[]
}

export const fetchScan = (): Promise<{ report: ScanReport | null }> => request('/api/scan')

/** 全局扫描 promise：跨页面切换存活（组件卸载不丢），切回页面时可接管继续等待 */
let scanInFlightPromise: Promise<{ report: ScanReport }> | null = null

/** 发起扫描；若已有进行中的扫描则直接复用同一个 promise（不会发出第二个请求） */
export function scanNow(opts: Partial<ScanOptions>): Promise<{ report: ScanReport }> {
  if (scanInFlightPromise) return scanInFlightPromise
  const p = post<{ report: ScanReport }>('/api/scan', opts)
  scanInFlightPromise = p.finally(() => { scanInFlightPromise = null })
  return scanInFlightPromise
}

/** 当前进行中的扫描（无则 null）：页面重新挂载时用它恢复禁用状态并接管结果 */
export const ongoingScan = (): Promise<{ report: ScanReport }> | null => scanInFlightPromise

// ---------- 信号质量追踪（回合制两层口径：信号层看追高惩罚，回合层与回测同口径） ----------

export interface TrackLayerStats {
  settled: number
  pending: number
  winRate: number
  avgReturn: number
  avgWin: number
  avgLoss: number
  profitFactor: number
  avgDays: number
  maxConsecutiveLosses: number
}

export interface TrackStats {
  signalLayer: TrackLayerStats
  roundLayer: TrackLayerStats
  perStock: Array<{ code: string; name?: string; rounds: number; winRate: number; avgReturn: number; pending: number }>
  pending: Array<{ code: string; name?: string; entryDate: string; entryPrice: number; currentPrice?: number; floatPercent?: number }>
  adjustedEntries: number
}

export const fetchTrackStats = (): Promise<TrackStats> => request('/api/track/stats')

/** 删除某只股票的全部追踪记录（含已结算样本与补历史标记） */
export const deleteTrackStock = (code: string): Promise<{ ok: boolean; removed: number }> => request(`/api/track/${code}`, { method: 'DELETE' })
