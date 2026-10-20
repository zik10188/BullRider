// 回测引擎：纯函数。给历史日K + 一个"每根K线做决策"的函数，模拟全仓买卖。
// 规则贴近 A股现实：一手100股、买佣金、卖佣金+印花税、T+1（日线天然满足）。
// 决策函数直接复用 signal 缝，所以换策略只需换 Provider。
import type { KLine } from '../market-data/types'
import type { SignalKind } from '../signal/types'
import type { BacktestOptions, BacktestResult, Trade } from './types'

/** 决策函数：根据截至当前的历史，给出建议动作 */
export interface Decide {
  (history: KLine[]): SignalKind
}

export function runBacktest(
  symbol: string,
  strategy: string,
  klines: KLine[],
  decide: Decide,
  options: BacktestOptions = {},
): BacktestResult {
  const {
    capital = 100_000,
    lotSize = 100,
    buyFeeRate = 0.00025,
    sellFeeRate = 0.00075,
    warmup = 11,
  } = options

  let cash = capital
  let shares = 0
  let entryIndex = -1
  let entryPrice = 0
  let entryCost = 0
  const trades: Trade[] = []

  let peak = 0
  let maxDrawdownPercent = 0
  let finalEquity = capital

  /** 更新权益曲线与回撤 */
  const track = (i: number) => {
    const equity = cash + shares * klines[i].close
    peak = Math.max(peak, equity)
    maxDrawdownPercent = Math.max(maxDrawdownPercent, peak > 0 ? ((peak - equity) / peak) * 100 : 0)
    return equity
  }

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i]
    if (i >= warmup) {
      const signal = decide(klines.slice(0, i + 1))
      if (signal === 'BUY' && shares === 0) {
        // 全仓买入（按一手对齐）
        const perLotCost = k.close * lotSize * (1 + buyFeeRate)
        const buyable = Math.floor(cash / perLotCost) * lotSize
        if (buyable >= lotSize) {
          const spend = buyable * k.close
          const fee = spend * buyFeeRate
          cash -= spend + fee
          shares = buyable
          entryIndex = i
          entryPrice = k.close
          entryCost = spend + fee
        }
      } else if (signal === 'SELL' && shares > 0) {
        // 清仓卖出
        const proceeds = shares * k.close
        const fee = proceeds * sellFeeRate
        cash += proceeds - fee
        trades.push({
          entryDate: klines[entryIndex].date,
          exitDate: k.date,
          entryPrice,
          exitPrice: k.close,
          returnPercent: ((proceeds - fee - entryCost) / entryCost) * 100,
          days: i - entryIndex,
        })
        shares = 0
      }
    }
    finalEquity = track(i)
  }

  // 结尾强制平仓（若仍持仓）
  if (shares > 0) {
    const last = klines[klines.length - 1]
    const proceeds = shares * last.close
    const fee = proceeds * sellFeeRate
    cash += proceeds - fee
    trades.push({
      entryDate: klines[entryIndex].date,
      exitDate: last.date,
      entryPrice,
      exitPrice: last.close,
      returnPercent: ((proceeds - fee - entryCost) / entryCost) * 100,
      days: klines.length - 1 - entryIndex,
    })
    shares = 0
    finalEquity = cash
  }

  const totalReturnPercent = (finalEquity / capital - 1) * 100
  // 买入持有基准统一从回测区间第一根起算：warmup 因策略而异，若跟随 warmup 会导致跨策略超额收益不可比
  const first = klines[0]
  const lastK = klines[klines.length - 1]
  const buyHoldReturnPercent = (lastK.close / first.close - 1) * 100
  const wins = trades.filter((t) => t.returnPercent > 0).length

  return {
    symbol,
    strategy,
    periodStart: klines[0].date,
    periodEnd: lastK.date,
    barCount: klines.length,
    initialCapital: capital,
    finalEquity,
    totalReturnPercent,
    buyHoldReturnPercent,
    excessReturnPercent: totalReturnPercent - buyHoldReturnPercent,
    tradeCount: trades.length,
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
    maxDrawdownPercent,
    trades,
  }
}
