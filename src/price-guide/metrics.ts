// 挂价计算共享工具：最小变动单位、按 tick 对齐和 ATR。
import type { KLine } from '../market-data/types'

export const ATR_PERIOD = 14

/** 股票 0.01 元；沪 5 / 深 15 开头的场内 ETF 0.001 元。 */
export function tickOf(code: string): number {
  return /^(5|15)/.test(code) ? 0.001 : 0.01
}

export function roundToTick(price: number, tick: number): number {
  return Math.round(price / tick) * tick
}

export function floorToTick(price: number, tick: number): number {
  return Math.floor(price / tick) * tick
}

export function ceilToTick(price: number, tick: number): number {
  return Math.ceil(price / tick) * tick
}

/** ATR(14)：每根真实波幅都要与前一日收盘比较，因此至少需要 15 根日K。 */
export function atr14(klines: KLine[]): number | null {
  if (klines.length < ATR_PERIOD + 1) return null
  const trs: number[] = []
  for (let i = klines.length - ATR_PERIOD; i < klines.length; i++) {
    const k = klines[i]
    const prev = klines[i - 1].close
    trs.push(Math.max(k.high - k.low, Math.abs(k.high - prev), Math.abs(k.low - prev)))
  }
  const value = trs.reduce((a, b) => a + b, 0) / trs.length
  return Number.isFinite(value) ? value : null
}
