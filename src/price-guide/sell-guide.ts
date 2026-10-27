// 实盘卖出参考：风控止损、技术保护、两档分批止盈和趋势退出状态。
// 纯函数，只使用调用方已取得的现价与日K，不预测涨跌，也不保证挂单成交。
import type { KLine } from '../market-data/types'
import type { SignalKind } from '../signal/types'
import { ATR_PERIOD, atr14, ceilToTick, floorToTick, roundToTick, tickOf } from './metrics'

export interface SellTarget {
  key: 'target-1' | 'target-2'
  label: string
  price: number
  note: string
}

export type SellGuide =
  | {
      available: true
      price: number
      at: string
      tick: number
      atr: number
      atrPercent: number
      costPrice: number
      support: number
      resistance: number
      stopLossPrice: number
      protectionPrice: number
      effectiveStopPrice: number
      distanceToStopPercent: number
      targets: SellTarget[]
      trend: SignalKind | null
      trendLabel: string
      riskTriggered: boolean
      advice: string
    }
  | { available: false; reason: string }

const PROTECTION_ATR = 1.2
const TARGET1_ATR = 0.8
const TARGET2_ATR = 1.6
const SUPPORT_WINDOW = 20

const TREND_LABEL: Record<SignalKind, string> = {
  BUY: '趋势偏多',
  SELL: '趋势转弱',
  HOLD: '趋势中性',
}

export function computeSellGuide(
  code: string,
  price: number,
  avgCost: number,
  klines: KLine[],
  trend: SignalKind | null,
  stopLossRatio = 0.1,
): SellGuide {
  if (!Number.isFinite(price) || price <= 0) return { available: false, reason: '现价无效' }
  if (!Number.isFinite(avgCost) || avgCost <= 0) return { available: false, reason: '持仓成本无效' }
  if (klines.length < ATR_PERIOD + 1) {
    return { available: false, reason: `日K不足 ${ATR_PERIOD + 1} 根，算不出卖出参考` }
  }
  const atr = atr14(klines)
  if (atr == null || !(atr > 0)) return { available: false, reason: '日均波幅为 0（长期停牌或数据异常）' }

  const tick = tickOf(code)
  const stopRatio = Number.isFinite(stopLossRatio) && stopLossRatio > 0 && stopLossRatio < 1
    ? stopLossRatio
    : 0.1
  const window = klines.slice(-SUPPORT_WINDOW)
  const support = Math.min(...window.map((k) => k.low))
  const resistance = Math.max(...window.map((k) => k.high))
  const stopLossPrice = Math.max(tick, roundToTick(avgCost * (1 - stopRatio), tick))

  // 技术保护线不高于现价，同时不深于近20日低点；取“近20日低点”和“现价−1.2 ATR”中更近当前价的位置。
  const protectionRaw = Math.max(support, price - PROTECTION_ATR * atr)
  const protectionPrice = Math.max(
    tick,
    Math.min(floorToTick(price - tick, tick), floorToTick(protectionRaw, tick)),
  )
  const effectiveStopPrice = Math.max(stopLossPrice, protectionPrice)

  // 第一档优先看近期压力位和 0.8 ATR，第二档再向上扩展；两档保持严格递增。
  const target1Raw = Math.max(resistance > price ? resistance : 0, price + TARGET1_ATR * atr)
  const target1 = ceilToTick(target1Raw, tick)
  const target2Raw = Math.max(resistance, target1 + tick, price + TARGET2_ATR * atr)
  const target2 = ceilToTick(target2Raw, tick)
  const riskTriggered = price <= effectiveStopPrice

  const advice = riskTriggered
    ? '现价已不高于有效防守线，卖出参考用于执行纪律，不保证实际成交。'
    : trend === 'SELL'
      ? '赛马信号已转弱，优先考虑退出；上方止盈价仅用于尚未退出时的观察。'
      : '跌破有效防守线先控制风险；到达第一、第二止盈档可考虑分批减仓。'

  return {
    available: true,
    price,
    at: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`,
    tick,
    atr,
    atrPercent: (atr / price) * 100,
    costPrice: avgCost,
    support,
    resistance,
    stopLossPrice,
    protectionPrice,
    effectiveStopPrice,
    distanceToStopPercent: (price / effectiveStopPrice - 1) * 100,
    targets: [
      {
        key: 'target-1',
        label: '第一档',
        price: target1,
        note: `近期压力位与 ${TARGET1_ATR}×ATR 中较高者`,
      },
      {
        key: 'target-2',
        label: '第二档',
        price: target2,
        note: `在第一档之上继续保留 ${TARGET2_ATR}×ATR 空间`,
      },
    ],
    trend,
    trendLabel: trend ? TREND_LABEL[trend] : '趋势未评估',
    riskTriggered,
    advice,
  }
}
