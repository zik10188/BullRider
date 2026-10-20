// 模拟盘类型定义

export interface Position {
  symbol: string
  name: string
  /** 持仓股数 */
  shares: number
  /** 平均成本（含买入费用） */
  avgCost: number
}

export interface PaperTrade {
  date: string
  symbol: string
  name: string
  action: 'BUY' | 'SELL' | 'DEPOSIT'
  price: number
  shares: number
  /** 成交额（不含费） */
  amount: number
  /** 手续费 */
  fee: number
  /** 该笔已实现盈亏（仅 SELL 有，含费用） */
  profit?: number
}

export interface PaperAccount {
  /** 初始资金 */
  capital: number
  /** 当前可用现金 */
  cash: number
  createdAt: string
  updatedAt: string
  positions: Position[]
  trades: PaperTrade[]
  /** 资产曲线：每次操作后的总资产快照（老账户无此字段，自动补建） */
  equityHistory?: Array<{ date: string; equity: number }>
}

export interface PaperConfig {
  buyFeeRate?: number
  sellFeeRate?: number
  lotSize?: number
}
