// 测试辅助：构造合成日K数据（不碰网络）
import type { KLine } from '../market-data/types'

/** 单根K线（开高低收都等于 close） */
export function kline(date: string, close: number): KLine {
  return { date, open: close, high: close, low: close, close, volume: 1000, amount: close * 1000 }
}

/** 用收盘价序列造一段日K（日期从 2026-01-01 起递增） */
export function series(closes: number[]): KLine[] {
  return closes.map((c, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i))
    const iso = d.toISOString().slice(0, 10)
    return kline(iso, c)
  })
}

/** 浮点近似比较 */
export function closeTo(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps
}
