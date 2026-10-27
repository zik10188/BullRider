// 挂价参考：基于 ATR 波动率给出激进/稳健/保守三档限价建议，并裁剪到当日涨跌停范围。
// 纯函数不碰网络，quote 与日K由调用方（Web API）注入，daily 复用磁盘缓存。
// 诚实定位：当天最低价事前不可知，这里算的是"三档成交性价比"，不是预测。
import type { KLine } from '../market-data/types'
import { ATR_PERIOD, atr14, floorToTick, roundToTick, tickOf } from './metrics'

export { tickOf } from './metrics'

/** 单档挂价建议 */
export interface PriceTier {
  key: 'aggressive' | 'steady' | 'conservative'
  label: string
  price: number
  fillOdds: string
  note: string
}

export type PriceGuide =
  | {
      available: true
      /** 计算基准现价 */
      price: number
      /** 计算时刻（本地 HH:mm）：参考绑定决策时点，盘中变动后应重新计算 */
      at: string
      /** ATR(14)：日均真实波幅（元） */
      atr: number
      /** ATR 占现价的百分比 */
      atrPercent: number
      /** 最小变动单位：股票 0.01 / 场内 ETF 0.001 */
      tick: number
      /** 近 20 日最低价（保守档依据） */
      support: number
      /** 当日涨停价（行情源提供时） */
      limitUp?: number
      /** 当日跌停价（行情源提供时） */
      limitDown?: number
      /** 是否至少有一档被涨跌停范围裁剪 */
      limitClamped: boolean
      tiers: PriceTier[]
      advice: string
    }
  | { available: false; reason: string }

const STEADY_ATR = 0.4      // 稳健档：回撤 0.4×ATR（日内正常回调下沿）
const CONSERVATIVE_ATR = 1.2 // 保守档：最深 1.2×ATR
const CONSERVATIVE_WINDOW = 20

export function computePriceGuide(
  code: string,
  price: number,
  klines: KLine[],
  limitUp?: number,
  limitDown?: number,
): PriceGuide {
  if (!Number.isFinite(price) || price <= 0) return { available: false, reason: '现价无效' }
  // ATR(14)：每根 TR 都要跟前一日收盘比，故最少 15 根
  if (klines.length < ATR_PERIOD + 1) {
    return { available: false, reason: `日K不足 ${ATR_PERIOD + 1} 根（次新股），算不出日均波幅` }
  }
  const atr = atr14(klines)
  if (atr == null || !(atr > 0)) return { available: false, reason: '日均波幅为 0（长期停牌或数据异常）' }

  const tick = tickOf(code)
  const support = Math.min(...klines.slice(-CONSERVATIVE_WINDOW).map((k) => k.low))
  const hasLimits = Number.isFinite(limitUp) && Number.isFinite(limitDown)
    && (limitUp as number) > 0 && (limitDown as number) > 0
    && (limitUp as number) >= (limitDown as number)
  const lowerLimit = hasLimits ? limitDown as number : undefined
  const upperLimit = hasLimits ? limitUp as number : undefined
  const clamp = (value: number): number => Math.min(
    upperLimit ?? Number.POSITIVE_INFINITY,
    Math.max(lowerLimit ?? Number.NEGATIVE_INFINITY, value),
  )
  const aggressiveRaw = roundToTick(price + tick, tick)
  const steadyRaw = floorToTick(price - STEADY_ATR * atr, tick)
  const aggressive = clamp(aggressiveRaw)
  const steady = clamp(steadyRaw)
  // 保守档：不深于近 20 日低点（跌破低点是接飞刀），正常情况下比稳健档便宜；跌停位允许两档重合。
  const conservativeRaw = Math.min(
    Math.max(support, floorToTick(price - CONSERVATIVE_ATR * atr, tick)),
    steady - tick,
  )
  const conservative = clamp(conservativeRaw)
  const atUpper = (v: number) => hasLimits && upperLimit != null && Math.abs(v - upperLimit) < tick / 2
  const atLower = (v: number) => hasLimits && lowerLimit != null && Math.abs(v - lowerLimit) < tick / 2
  const limitClamped = aggressive !== aggressiveRaw || steady !== steadyRaw || conservative !== conservativeRaw
    || atUpper(aggressive) || atLower(steady) || atLower(conservative)
  const fmt = (v: number) => v.toFixed(tick === 0.001 ? 3 : 2)

  return {
    available: true,
    price,
    at: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`,
    atr,
    atrPercent: (atr / price) * 100,
    tick,
    support,
    limitUp: hasLimits ? limitUp : undefined,
    limitDown: hasLimits ? limitDown : undefined,
    limitClamped,
    tiers: [
      {
        key: 'aggressive',
        label: '激进',
        price: aggressive,
        fillOdds: '基本必成交',
        note: atUpper(aggressive) ? '今日涨停价，委托不能更高' : `现价 + ${fmt(tick)} 插队`,
      },
      {
        key: 'steady',
        label: '稳健',
        price: steady,
        fillOdds: '约五成',
        note: atLower(steady)
          ? '今日跌停价，委托不能更低'
          : `等回调 ${fmt(STEADY_ATR * atr)} 元（0.4×ATR）`,
      },
      {
        key: 'conservative',
        label: '保守',
        price: conservative,
        fillOdds: '可能挂空',
        note: atLower(conservative)
          ? '今日跌停价，委托不能更低'
          : '不破近20日低点的深度回调',
      },
    ],
    advice: `${limitClamped ? '参考价已按今日涨跌停范围裁剪。' : ''}建议尾盘 14:45 前未成交则撤单：怕踏空改按激进档追，可等则放弃等下次信号`,
  }
}
