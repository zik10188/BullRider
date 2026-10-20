// 均线交叉策略（金叉/死叉）—— 最经典、最好懂的趋势策略
// 规则：MA5 上穿 MA10 → 买入；MA5 下穿 MA10 → 卖出；否则持有
import type { KLine } from '../market-data/types'
import type { Signal, SignalKind } from './types'
import type { SignalProvider } from './provider'

/** 简单移动平均：最近 n 根收盘价的平均 */
function ma(closes: number[], n: number): number {
  const window = closes.slice(-n)
  return window.reduce((a, b) => a + b, 0) / window.length
}

export class MaCrossProvider implements SignalProvider {
  readonly name = 'ma-cross'
  readonly minBars = 12

  evaluate(klines: KLine[]): Signal {
    if (klines.length < 12) {
      throw new Error('数据不足：至少需要 12 根K线才能算 MA5/MA10')
    }
    const closes = klines.map((k) => k.close)
    const last = klines[klines.length - 1]

    const fast = ma(closes, 5) // 今日 MA5
    const slow = ma(closes, 10) // 今日 MA10
    const prevFast = ma(closes.slice(0, -1), 5) // 昨日 MA5
    const prevSlow = ma(closes.slice(0, -1), 10) // 昨日 MA10

    let kind: SignalKind = 'HOLD'
    let reason: string
    if (prevFast <= prevSlow && fast > slow) {
      kind = 'BUY'
      reason = `MA5(${fast.toFixed(2)}) 上穿 MA10(${slow.toFixed(2)})，形成金叉，短线转强`
    } else if (prevFast >= prevSlow && fast < slow) {
      kind = 'SELL'
      reason = `MA5(${fast.toFixed(2)}) 下穿 MA10(${slow.toFixed(2)})，形成死叉，短线转弱`
    } else if (fast > slow) {
      reason = `MA5(${fast.toFixed(2)}) 在 MA10(${slow.toFixed(2)}) 上方，趋势偏多`
    } else {
      reason = `MA5(${fast.toFixed(2)}) 在 MA10(${slow.toFixed(2)}) 下方，趋势偏空`
    }

    return {
      kind,
      date: last.date,
      price: last.close,
      strategy: this.name,
      reason,
      indicators: { ma5: fast, ma10: slow },
    }
  }
}
