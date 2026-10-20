// 回测模块类型定义

/** 一笔完整交易（买入 -> 卖出） */
export interface Trade {
  entryDate: string
  exitDate: string
  entryPrice: number
  exitPrice: number
  /** 该笔收益率（含费用，百分比） */
  returnPercent: number
  /** 持仓交易日数 */
  days: number
}

export interface BacktestOptions {
  /** 初始资金（默认 100000） */
  capital?: number
  /** 每手股数（A股一手=100） */
  lotSize?: number
  /** 买入费率（佣金，默认 万2.5=0.00025） */
  buyFeeRate?: number
  /** 卖出费率（佣金+印花税，默认 万7.5=0.00075） */
  sellFeeRate?: number
  /** 前面跳过多少根K线作为策略暖机；暖机后还要等下一根开盘才成交 */
  warmup?: number
}

export interface BacktestResult {
  symbol: string
  strategy: string
  periodStart: string
  periodEnd: string
  /** 回测了多少根K线 */
  barCount: number
  initialCapital: number
  finalEquity: number
  /** 策略总收益率（%） */
  totalReturnPercent: number
  /** 买入持有收益率（%） */
  buyHoldReturnPercent: number
  /** 相对买入持有的超额收益（%） */
  excessReturnPercent: number
  /** 交易次数 */
  tradeCount: number
  /** 胜率（%） */
  winRate: number
  /** 最大回撤（%） */
  maxDrawdownPercent: number
  trades: Trade[]
}
