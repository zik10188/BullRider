// 唐奇安通道突破（海龟交易法的入场规则）—— 不管均线，直接看价格创没创新高/新低
// 规则：收盘 > 前 20 日最高 → 买入（向上突破）；收盘 < 前 20 日最低 → 卖出（向下跌破）；否则在通道内观望
// 特点：趋势跟踪的"原教旨"版，信号比均线少而钝，但假动作少；震荡市会在通道边缘反复摩擦
import type { KLine } from '../market-data/types'
import type { Signal, SignalKind } from './types'
import type { SignalProvider } from './provider'

const CHANNEL = 20
const MIN_BARS = CHANNEL + 1

export class DonchianProvider implements SignalProvider {
  readonly name = 'donchian'
  readonly minBars = MIN_BARS

  evaluate(klines: KLine[]): Signal {
    if (klines.length < MIN_BARS) {
      throw new Error(`数据不足：唐奇安策略至少需要 ${MIN_BARS} 根K线`)
    }
    const last = klines[klines.length - 1]
    // 通道不含当日：过去的 20 日才是"被突破"的基准
    const prior = klines.slice(-CHANNEL - 1, -1)
    const upper = Math.max(...prior.map((k) => k.high))
    const lower = Math.min(...prior.map((k) => k.low))

    let kind: SignalKind = 'HOLD'
    let reason: string
    if (last.close > upper) {
      kind = 'BUY'
      reason = `收盘 ${last.close.toFixed(2)} 突破前 ${CHANNEL} 日最高 ${upper.toFixed(2)}，向上破位，趋势启动`
    } else if (last.close < lower) {
      kind = 'SELL'
      reason = `收盘 ${last.close.toFixed(2)} 跌破前 ${CHANNEL} 日最低 ${lower.toFixed(2)}，向下破位，趋势转坏`
    } else {
      reason = `收盘 ${last.close.toFixed(2)} 在唐奇安通道 [${lower.toFixed(2)}, ${upper.toFixed(2)}] 内，无突破`
    }

    return { kind, date: last.date, price: last.close, strategy: this.name, reason, indicators: { upper, lower } }
  }
}
