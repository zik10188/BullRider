// RSI 相对强弱策略 —— 衡量"涨/跌劲头是否过猛"
// 规则：RSI < 30 超卖 → 买入（跌过头易反弹）；RSI > 70 超买 → 卖出（涨过头易回调）；否则持有
// 计算用 Wilder 平滑（业界标准口径），周期 14
import type { KLine } from '../market-data/types'
import type { Signal, SignalKind } from './types'
import type { SignalProvider } from './provider'

const PERIOD = 14
const MIN_BARS = PERIOD + 6

/** Wilder RSI（0~100） */
export function rsi(closes: number[], period = PERIOD): number {
  if (closes.length < period + 1) throw new Error(`数据不足：RSI 至少需要 ${period + 1} 根K线`)
  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff
    else losses -= diff
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export class RsiProvider implements SignalProvider {
  readonly name = 'rsi'
  readonly minBars = PERIOD + 6

  evaluate(klines: KLine[]): Signal {
    if (klines.length < MIN_BARS) {
      throw new Error(`数据不足：RSI 策略至少需要 ${MIN_BARS} 根K线`)
    }
    const closes = klines.map((k) => k.close)
    const last = klines[klines.length - 1]
    const value = rsi(closes)

    let kind: SignalKind = 'HOLD'
    let reason: string
    if (value <= 30) {
      kind = 'BUY'
      reason = `RSI(${value.toFixed(1)}) 低于 30，进入超卖区，跌过头易反弹`
    } else if (value >= 70) {
      kind = 'SELL'
      reason = `RSI(${value.toFixed(1)}) 高于 70，进入超买区，涨过头易回调`
    } else {
      reason = `RSI(${value.toFixed(1)}) 处于 30~70 中性区`
    }

    return { kind, date: last.date, price: last.close, strategy: this.name, reason, indicators: { rsi: value } }
  }
}
