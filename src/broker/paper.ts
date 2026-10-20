// 交易缝的"模拟盘实现"：把现有模拟账户引擎包装成 BrokerProvider
// 将来接真券商（如 QMT）就是再写一个实现，调用方代码不变。
import { loadAccount, saveAccount } from '../paper/store'
import { createAccount, buy, sell } from '../paper/account'
import type { BrokerFill, BrokerOrder, BrokerPosition, BrokerProvider, BrokerTrade } from './types'

export class PaperBrokerProvider implements BrokerProvider {
  readonly name = 'paper'

  async buy(order: BrokerOrder): Promise<BrokerFill> {
    const acc = (await loadAccount()) ?? createAccount()
    const res = buy(acc, order.symbol, order.name, order.price, {}, order.amount)
    await saveAccount(acc)
    return { shares: res.shares, amount: res.amount, fee: res.fee }
  }

  async sell(order: BrokerOrder): Promise<BrokerFill> {
    const acc = await loadAccount()
    if (!acc) throw new Error('没有模拟账户，先运行: paper init')
    const res = sell(acc, order.symbol, order.name, order.price, {}, order.shares)
    await saveAccount(acc)
    return { shares: res.shares, amount: res.amount, fee: res.fee, profit: res.profit }
  }

  async has(symbol: string): Promise<boolean> {
    const acc = await loadAccount()
    return acc ? acc.positions.some((p) => p.symbol === symbol) : false
  }

  async positions(): Promise<BrokerPosition[]> {
    const acc = await loadAccount()
    return acc ? acc.positions.map((p) => ({ symbol: p.symbol, name: p.name, shares: p.shares, avgCost: p.avgCost })) : []
  }

  async cash(): Promise<number> {
    const acc = await loadAccount()
    return acc ? acc.cash : 0
  }

  async capital(): Promise<number> {
    const acc = await loadAccount()
    return acc ? acc.capital : 0
  }

  async trades(): Promise<BrokerTrade[]> {
    const acc = await loadAccount()
    if (!acc) return []
    return acc.trades.map((t) => ({
      date: t.date,
      symbol: t.symbol,
      name: t.name,
      side: t.action,
      price: t.price,
      shares: t.shares,
      amount: t.amount,
      fee: t.fee,
      profit: t.profit,
    }))
  }
}
