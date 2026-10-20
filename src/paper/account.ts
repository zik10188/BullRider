// 模拟账户业务逻辑（操作会直接修改传入的账户对象）
import type { PaperAccount, PaperConfig } from './types'

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 新建模拟账户 */
export function createAccount(capital = 100_000): PaperAccount {
  return {
    capital,
    cash: capital,
    createdAt: new Date().toISOString(),
    updatedAt: '',
    positions: [],
    trades: [],
  }
}

/** 一次成交的结果 */
export interface PaperFill {
  account: PaperAccount
  shares: number
  amount: number
  fee: number
  profit?: number
}

/** 记录资产曲线快照：现金 + 持仓估值（本次成交价估本次标的，其余按成本价近似） */
function pushEquity(account: PaperAccount, tradedSymbol: string, tradedPrice: number): void {
  let equity = account.cash
  for (const p of account.positions) {
    equity += p.shares * (p.symbol === tradedSymbol ? tradedPrice : p.avgCost)
  }
  ;(account.equityHistory ??= []).push({ date: today(), equity })
}

/** 充值/追加资金：不是收益，只记一条 DEPOSIT 流水并同步抬高初始资金基准 */
export function deposit(account: PaperAccount, amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`充值金额无效: ${amount}`)
  account.cash += amount
  account.capital += amount
  account.trades.push({ date: today(), symbol: '-', name: '追加资金', action: 'DEPOSIT', price: 0, shares: 0, amount, fee: 0 })
  pushEquity(account, '-', 0)
}

/** 买入（缺省全仓；传入 budget 则按预算金额内能买多少买多少。按一手对齐，A股一手=100股） */
export function buy(
  account: PaperAccount,
  symbol: string,
  name: string,
  price: number,
  config: PaperConfig = {},
  budget?: number,
): PaperFill {
  const { buyFeeRate = 0.00025, lotSize = 100 } = config
  const perLotCost = price * lotSize * (1 + buyFeeRate)
  const usable = Math.min(account.cash, budget != null && budget > 0 ? budget : account.cash)
  const buyable = Math.floor(usable / perLotCost) * lotSize
  if (buyable < lotSize) {
    const limit = budget != null && budget > 0 ? `预算 ${Math.round(budget)} 元内` : ''
    throw new Error(`现金不足买一手 ${symbol}（${limit}一手约需 ${Math.round(perLotCost)} 元，现金 ${Math.round(account.cash)} 元）`)
  }
  const amount = buyable * price
  const fee = amount * buyFeeRate

  const pos = account.positions.find((p) => p.symbol === symbol)
  if (pos) {
    const totalCost = pos.avgCost * pos.shares + amount + fee
    pos.shares += buyable
    pos.avgCost = totalCost / pos.shares
  } else {
    account.positions.push({ symbol, name, shares: buyable, avgCost: (amount + fee) / buyable })
  }
  account.cash -= amount + fee
  account.trades.push({ date: today(), symbol, name, action: 'BUY', price, shares: buyable, amount, fee })
  pushEquity(account, symbol, price)
  return { account, shares: buyable, amount, fee }
}

/** 卖出（shares 缺省 = 全部持仓） */
export function sell(
  account: PaperAccount,
  symbol: string,
  name: string,
  price: number,
  config: PaperConfig = {},
  shares?: number,
): PaperFill {
  const { sellFeeRate = 0.00075 } = config
  const pos = account.positions.find((p) => p.symbol === symbol)
  if (!pos || pos.shares === 0) throw new Error(`没有持有 ${symbol}`)
  const sellShares = Math.min(shares ?? pos.shares, pos.shares)
  const amount = sellShares * price
  const fee = amount * sellFeeRate
  const profit = amount - fee - pos.avgCost * sellShares

  pos.shares -= sellShares
  if (pos.shares === 0) account.positions = account.positions.filter((p) => p.symbol !== symbol)
  account.cash += amount - fee
  account.trades.push({ date: today(), symbol, name, action: 'SELL', price, shares: sellShares, amount, fee, profit })
  pushEquity(account, symbol, price)
  return { account, shares: sellShares, amount, fee, profit }
}
