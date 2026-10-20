// 模拟盘操作（供 Web 服务复用；CLI 保持原样不动）
// 逻辑与 CLI 的 paper 命令一致：买入先过风控、apply 按信号+止损。
import type { Context } from '@deepseek-ai/cordis'
import { loadAccount, saveAccount } from './store'
import { createAccount, deposit as depositTo } from './account'
import type { RiskVerdict } from '../risk/types'

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
}

export interface ApplyResult extends OpResult {
  signal?: { kind: string; reason: string }
  action?: 'BUY' | 'SELL' | 'HOLD' | 'STOP_LOSS'
}

/** 初始化/重置账户 */
export async function initAccount(capital: number, force: boolean): Promise<OpResult> {
  const existing = await loadAccount()
  if (existing && !force) {
    return { ok: false, message: `账户已存在（现金 ${Math.round(existing.cash)} 元）。要重置请把 force 设为 true。` }
  }
  await saveAccount(createAccount(capital))
  return { ok: true, message: `模拟账户已创建: 初始资金 ${capital} 元` }
}

/** 账户快照（含实时估值） */
export async function snapshot(ctx: Context): Promise<PaperSnapshot> {
  const acc = await loadAccount()
  if (!acc) {
    return { exists: false, capital: 0, cash: 0, equity: 0, totalProfit: 0, totalProfitPercent: 0, positions: [], trades: [], equityHistory: [] }
  }
  const positions: SnapshotPosition[] = []
  let equity = acc.cash
  for (const p of acc.positions) {
    const q = await ctx.marketData.quote(p.symbol)
    const value = p.shares * q.price
    const profit = value - p.avgCost * p.shares
    const profitPercent = (q.price / p.avgCost - 1) * 100
    equity += value
    positions.push({ symbol: p.symbol, name: p.name, shares: p.shares, avgCost: p.avgCost, price: q.price, value, profit, profitPercent })
  }
  return {
    exists: true,
    capital: acc.capital,
    cash: acc.cash,
    equity,
    totalProfit: equity - acc.capital,
    totalProfitPercent: acc.capital > 0 ? ((equity - acc.capital) / acc.capital) * 100 : 0,
    positions,
    trades: acc.trades.map((t) => ({
      date: t.date,
      symbol: t.symbol,
      name: t.name,
      side: t.action,
      price: t.price,
      shares: t.shares,
      amount: t.amount,
      fee: t.fee,
      profit: t.profit,
    })),
    equityHistory: acc.equityHistory ?? [],
  }
}

/** 买入前风控检查（cost = 本次实际预计花费） */
export async function checkBuyRisk(ctx: Context, symbol: string, price: number, cost: number): Promise<RiskVerdict> {
  const acc = await loadAccount()
  if (!acc) return { allowed: false, reason: '没有模拟账户，先执行 init' }
  let equity = acc.cash
  let currentPosValue = 0
  for (const p of acc.positions) {
    const pq = await ctx.marketData.quote(p.symbol)
    const v = p.shares * pq.price
    equity += v
    if (p.symbol === symbol) currentPosValue = v
  }
  return ctx.risk.checkBuy({ cost, cash: acc.cash, equity, currentPosValue, totalPosValue: equity - acc.cash, todayLoss: 0 })
}

/** 买入（可指定预算金额，缺省全仓；先按预计花费过风控） */
export async function buy(ctx: Context, symbol: string, amount?: number): Promise<OpResult> {
  const acc = await loadAccount()
  if (!acc) return { ok: false, message: '没有模拟账户，先执行 init' }
  const q = await ctx.marketData.quote(symbol)
  // 按预算估算能买几手，得到预计花费
  const perLotCost = q.price * 100 * 1.00025
  const usable = Math.min(acc.cash, amount != null && amount > 0 ? amount : acc.cash)
  const plannedShares = Math.floor(usable / perLotCost) * 100
  if (plannedShares < 100) {
    const limit = amount != null && amount > 0 ? `预算 ${Math.round(amount)} 元内` : ''
    return { ok: false, message: `买不起一手：${limit}一手约需 ${Math.round(perLotCost)} 元，现金 ${Math.round(acc.cash)} 元` }
  }
  const plannedCost = plannedShares * q.price * 1.00025
  const verdict = await checkBuyRisk(ctx, symbol, q.price, plannedCost)
  if (!verdict.allowed) return { ok: false, message: `风控拦截: ${verdict.reason}` }
  const fill = await ctx.broker.buy({ symbol, name: q.name, price: q.price, amount })
  return { ok: true, message: `已买入 ${q.name}(${symbol}) ${fill.shares} 股 @ ${q.price.toFixed(2)}，成交额 ${Math.round(fill.amount).toLocaleString()} 元`, fill }
}

/** 充值/追加资金（模拟资金，记 DEPOSIT 流水，不污染盈亏统计） */
export async function addDeposit(amount: number): Promise<OpResult> {
  const acc = await loadAccount()
  if (!acc) return { ok: false, message: '没有模拟账户，先执行 init' }
  try {
    depositTo(acc, amount)
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
  await saveAccount(acc)
  return { ok: true, message: `已追加资金 ${Math.round(amount).toLocaleString()} 元，当前现金 ${Math.round(acc.cash).toLocaleString()} 元` }
}

/** 卖出（shares 缺省 = 全部） */
export async function sell(ctx: Context, symbol: string, shares?: number): Promise<OpResult> {
  const acc = await loadAccount()
  if (!acc) return { ok: false, message: '没有模拟账户，先执行 init' }
  const q = await ctx.marketData.quote(symbol)
  const fill = await ctx.broker.sell({ symbol, name: q.name, price: q.price, shares })
  return { ok: true, message: `已卖出 ${q.name}(${symbol}) ${fill.shares} 股 @ ${q.price.toFixed(2)}`, fill }
}

/** 按当前信号自动操作（含止损） */
export async function apply(ctx: Context, symbol: string, strategy?: string): Promise<ApplyResult> {
  const acc = await loadAccount()
  if (!acc) return { ok: false, message: '没有模拟账户，先执行 init' }
  const klines = await ctx.marketData.daily(symbol, { days: 60 })
  const signal = ctx.signal.evaluate(klines, strategy)
  const q = await ctx.marketData.quote(symbol)
  const sig = { kind: signal.kind, reason: signal.reason }

  if (signal.kind === 'BUY') {
    // 按信号买入不搞全仓：预算 = 现金、单股仓位上限、总仓位上限三者取最小（真实仓位管理）
    let equity = acc.cash
    let currentPosValue = 0
    for (const p of acc.positions) {
      const pq = await ctx.marketData.quote(p.symbol)
      equity += p.shares * pq.price
      if (p.symbol === symbol) currentPosValue = p.shares * pq.price
    }
    const cfg = ctx.risk.config
    const budget = Math.max(0, Math.min(
      acc.cash,
      cfg.maxPositionRatio * equity - currentPosValue,
      cfg.totalPositionRatio * equity - (equity - acc.cash),
    )) / 1.00025 // 预留买入手续费
    const perLotCost = q.price * 100 * 1.00025
    const plannedShares = Math.floor(budget / perLotCost) * 100
    if (plannedShares < 100) {
      return { ok: false, message: `风控预算不足一手：允许买入约 ${Math.round(budget)} 元，该股一手约需 ${Math.round(perLotCost)} 元（单股/总仓位上限或现金不够）`, signal: sig, action: 'BUY' }
    }
    const verdict = await checkBuyRisk(ctx, symbol, q.price, plannedShares * q.price * 1.00025)
    if (!verdict.allowed) return { ok: false, message: `风控拦截: ${verdict.reason}`, signal: sig, action: 'BUY' }
    const fill = await ctx.broker.buy({ symbol, name: q.name, price: q.price, amount: budget * 1.00025 })
    return { ok: true, message: `已按信号买入 ${fill.shares} 股，成交额 ${Math.round(fill.amount).toLocaleString()} 元`, signal: sig, action: 'BUY', fill }
  }
  if (signal.kind === 'SELL') {
    const has = acc.positions.some((p) => p.symbol === symbol)
    if (!has) return { ok: true, message: '未持有该股，无需卖出。', signal: sig, action: 'HOLD' }
    const fill = await ctx.broker.sell({ symbol, name: q.name, price: q.price })
    return { ok: true, message: `已按信号卖出 ${fill.shares} 股`, signal: sig, action: 'SELL', fill }
  }
  const pos = acc.positions.find((p) => p.symbol === symbol)
  if (pos) {
    const stop = ctx.risk.checkStopLoss({ symbol, avgCost: pos.avgCost, price: q.price })
    if (stop.triggered) {
      const fill = await ctx.broker.sell({ symbol, name: q.name, price: q.price })
      return { ok: true, message: `止损触发: ${stop.reason} → 强制卖出`, signal: sig, action: 'STOP_LOSS', fill }
    }
  }
  return { ok: true, message: 'HOLD: 观望，不操作。', signal: sig, action: 'HOLD' }
}
