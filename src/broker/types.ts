// 交易缝（broker）类型定义
// 一个 BrokerProvider 就是一个"交易渠道"（模拟盘 / 未来的实盘券商）

export interface BrokerOrder {
  symbol: string
  name: string
  price: number
  /** SELL 时可指定股数，缺省 = 全部持仓 */
  shares?: number
  /** BUY 时可指定预算金额（元），缺省 = 全仓买入 */
  amount?: number
}

export interface BrokerFill {
  shares: number
  amount: number
  fee: number
  /** 已实现盈亏（仅 SELL） */
  profit?: number
}

export interface BrokerPosition {
  symbol: string
  name: string
  shares: number
  avgCost: number
}

export interface BrokerTrade {
  date: string
  symbol: string
  name: string
  side: 'BUY' | 'SELL' | 'DEPOSIT'
  price: number
  shares: number
  amount: number
  fee: number
  profit?: number
}

export interface BrokerProvider {
  readonly name: string

  buy(order: BrokerOrder): Promise<BrokerFill>
  sell(order: BrokerOrder): Promise<BrokerFill>
  /** 是否持有某股 */
  has(symbol: string): Promise<boolean>
  positions(): Promise<BrokerPosition[]>
  cash(): Promise<number>
  capital(): Promise<number>
  trades(): Promise<BrokerTrade[]>
}
