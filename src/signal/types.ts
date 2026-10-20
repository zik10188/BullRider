// 信号模块类型定义

/** 建议动作 */
export type SignalKind = 'BUY' | 'SELL' | 'HOLD'

/** 一个交易信号 */
export interface Signal {
  /** 建议动作 */
  kind: SignalKind
  /** 基于哪根K线（最后一根的日期） */
  date: string
  /** 触发时的收盘价 */
  price: number
  /** 策略名 */
  strategy: string
  /** 人话理由 */
  reason: string
  /** 附带指标快照（便于展示/后续分析） */
  indicators: Record<string, number>
}
