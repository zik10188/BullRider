// 信号策略的"供应商"接口：输入一段日K，输出一个信号
// 换策略 = 换 Provider
import type { KLine } from '../market-data/types'
import type { Signal } from './types'

export interface SignalProvider {
  /** 策略唯一名字（如 'ma-cross'、'rsi'） */
  readonly name: string

  /** 最低K线数：不足时 evaluate 会抛错。回测方据此设置预热期（warmup = minBars - 1） */
  readonly minBars: number

  /** 根据日K线计算一个信号 */
  evaluate(klines: KLine[]): Signal
}

/** 可选的品种上下文：仅赛马策略用于选择回测费用规则 */
export interface SignalContext {
  code?: string
  isEtf?: boolean
}

export interface ContextAwareSignalProvider extends SignalProvider {
  evaluateWithContext(klines: KLine[], context?: SignalContext): Signal
}
