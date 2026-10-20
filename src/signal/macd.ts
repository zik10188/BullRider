// MACD 策略 —— 看趋势的"加速器"：红柱放大趋势强，绿柱放大趋势弱
// 规则：DIF 上穿 DEA（金叉）→ 买入；下穿（死叉）→ 卖出；否则按多空位置观望
// 参数：EMA12 / EMA26 / DEA9（业界标准）
import type { KLine } from '../market-data/types'
import type { Signal, SignalKind } from './types'
import type { SignalProvider } from './provider'

const MIN_BARS = 35

/** 指数移动平均序列（首个值取原值） */
function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = [values[0]]
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k))
  }
  return out
}

export class MacdProvider implements SignalProvider {
  readonly name = 'macd'
  readonly minBars = MIN_BARS

  evaluate(klines: KLine[]): Signal {
    if (klines.length < MIN_BARS) {
      throw new Error(`数据不足：MACD 策略至少需要 ${MIN_BARS} 根K线`)
    }
    const closes = klines.map((k) => k.close)
    const last = klines[klines.length - 1]

    const ema12 = emaSeries(closes, 12)
    const ema26 = emaSeries(closes, 26)
    const dif = ema12.map((v, i) => v - ema26[i])
    const dea = emaSeries(dif, 9)

    const d0 = dif[dif.length - 1]
    const e0 = dea[dea.length - 1]
    const d1 = dif[dif.length - 2]
    const e1 = dea[dea.length - 2]

    let kind: SignalKind = 'HOLD'
    let reason: string
    if (d1 <= e1 && d0 > e0) {
      kind = 'BUY'
      reason = `MACD 金叉：DIF(${d0.toFixed(3)}) 上穿 DEA(${e0.toFixed(3)})，多头动能转强`
    } else if (d1 >= e1 && d0 < e0) {
      kind = 'SELL'
      reason = `MACD 死叉：DIF(${d0.toFixed(3)}) 下穿 DEA(${e0.toFixed(3)})，空头动能转强`
    } else if (d0 > e0) {
      reason = `DIF(${d0.toFixed(3)}) 在 DEA(${e0.toFixed(3)}) 上方，多头趋势延续`
    } else {
      reason = `DIF(${d0.toFixed(3)}) 在 DEA(${e0.toFixed(3)}) 下方，空头趋势延续`
    }

    return {
      kind,
      date: last.date,
      price: last.close,
      strategy: this.name,
      reason,
      indicators: { dif: d0, dea: e0, macd: (d0 - e0) * 2 },
    }
  }
}
