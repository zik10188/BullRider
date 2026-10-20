// 均线计算（前端用于 K线叠加，与后端 ma-cross 策略口径一致）
import type { KLine } from '../api'

/** 计算均线序列：每根K线对应一个 {time, value}（不足 n 根时返回 []） */
export function maSeries(klines: KLine[], n: number): Array<{ time: string; value: number }> {
  const out: Array<{ time: string; value: number }> = []
  for (let i = n - 1; i < klines.length; i++) {
    let sum = 0
    for (let j = i - n + 1; j <= i; j++) sum += klines[j].close
    out.push({ time: klines[i].date, value: sum / n })
  }
  return out
}
