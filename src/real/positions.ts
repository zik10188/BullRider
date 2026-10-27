// 实盘持仓估值：现价/市值/浮动盈亏 + 每只持仓的 composite 赛马建议。
// CLI（real 命令）与 Web（GET /api/real）共用同一份实现，避免两处逻辑漂移。
import { derivePositions, type RealPosition, type RealTrade } from './journal'
import type { KLine } from '../market-data/types'
import type { Signal } from '../signal/types'
import { computeSellGuide, type SellGuide } from '../price-guide/sell-guide'

/** 带实时估值与赛马建议的持仓行 */
export interface ValuedPosition extends RealPosition {
  name?: string
  currentPrice: number
  marketValue: number
  profit: number
  profitPercent: number
  /** 赛马建议（日K不足 60 根或行情异常时不给） */
  signal?: { kind: string; reason: string }
  /** 卖出参考：风控止损、技术保护、分批止盈和趋势状态 */
  sellGuide?: SellGuide
}

/** 最小依赖口（与 TrackDeps 同风格：调用方注入，测试塞假实现） */
export interface ValueDeps {
  quote: (code: string) => Promise<{ name: string; price: number }>
  daily: (code: string, days: number) => Promise<KLine[]>
  evaluate: (klines: KLine[], strategy?: string) => Signal
  stopLossRatio: number
}

/** 逐只持仓拉现价估值 + 跑赛马；单只行情异常不阻塞整表（NaN 兜底） */
export async function valuePositions(deps: ValueDeps, trades: RealTrade[]): Promise<ValuedPosition[]> {
  return Promise.all(derivePositions(trades).map(async (p): Promise<ValuedPosition> => {
    try {
      const q = await deps.quote(p.code)
      const profit = (q.price - p.avgCost) * p.shares
      let signal: ValuedPosition['signal']
      let sellGuide: SellGuide | undefined
      try {
        const klines = await deps.daily(p.code, 120)
        let trend: Signal['kind'] | null = null
        try {
          const s = deps.evaluate(klines, 'composite')
          signal = { kind: s.kind, reason: s.reason }
          trend = s.kind
        } catch { /* 日K不足 60 根时仍可计算卖出参考 */ }
        sellGuide = computeSellGuide(p.code, q.price, p.avgCost, klines, trend, deps.stopLossRatio)
      } catch { /* 日K不足或行情异常：不给建议 */ }
      return {
        ...p,
        name: p.name ?? q.name,
        currentPrice: q.price,
        marketValue: q.price * p.shares,
        profit,
        // 百分比分母用持仓占用成本（含费），与 Web 端口径一致
        profitPercent: p.avgCost > 0 ? (profit / p.positionCost) * 100 : 0,
        signal,
        sellGuide,
      }
    } catch {
      return { ...p, currentPrice: NaN, marketValue: NaN, profit: NaN, profitPercent: NaN }
    }
  }))
}
