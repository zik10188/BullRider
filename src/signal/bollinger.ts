// 布林带均值回归 —— 用波动率给"贵/便宜"画边界：价格贴上轨=涨过头，贴下轨=跌过头
// 规则：收盘 < 下轨（MA20 − 2σ）→ 买入（超跌反弹）；收盘 > 上轨（MA20 + 2σ）→ 卖出（超涨回落）；否则带内观望
// 特点：震荡市灵、单边趋势市会"接飞刀"（一路跌一路贴下轨），和 RSI 同族但多考虑了波动幅度
import type { KLine } from '../market-data/types'
import type { Signal, SignalKind } from './types'
import type { SignalProvider } from './provider'

const PERIOD = 20
const K = 2 // 上下轨宽度 = 2 倍标准差（业界标准）
const MIN_BARS = PERIOD

export class BollingerProvider implements SignalProvider {
  readonly name = 'bollinger'
  readonly minBars = MIN_BARS

  evaluate(klines: KLine[]): Signal {
    if (klines.length < MIN_BARS) {
      throw new Error(`数据不足：布林带策略至少需要 ${MIN_BARS} 根K线`)
    }
    const last = klines[klines.length - 1]
    const window = klines.slice(-PERIOD)
    const closes = window.map((k) => k.close)
    const mid = closes.reduce((a, b) => a + b, 0) / PERIOD
    const variance = closes.reduce((a, c) => a + (c - mid) ** 2, 0) / PERIOD
    const sd = Math.sqrt(variance)
    const upper = mid + K * sd
    const lower = mid - K * sd

    let kind: SignalKind = 'HOLD'
    let reason: string
    if (last.close < lower) {
      kind = 'BUY'
      reason = `收盘 ${last.close.toFixed(2)} 跌出布林下轨 ${lower.toFixed(2)}，短期跌过头，易超跌反弹`
    } else if (last.close > upper) {
      kind = 'SELL'
      reason = `收盘 ${last.close.toFixed(2)} 涨出布林上轨 ${upper.toFixed(2)}，短期涨过头，易冲高回落`
    } else {
      reason = `收盘 ${last.close.toFixed(2)} 在布林带 [${lower.toFixed(2)}, ${upper.toFixed(2)}] 内，估值中性`
    }

    return { kind, date: last.date, price: last.close, strategy: this.name, reason, indicators: { upper, mid, lower, sd } }
  }
}
