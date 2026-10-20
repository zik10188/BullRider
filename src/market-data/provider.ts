// 数据源缝的"供应商"接口
// 谁实现这个接口，谁就是一家行情供应商（Provider）。换数据源 = 换 Provider。
import type { DailyOptions, KLine, Quote } from './types'

export interface MarketDataProvider {
  /** 供应商唯一名字（如 'eastmoney'、'akshare'） */
  readonly name: string

  /** 拉取某只股票的日K线 */
  daily(symbol: string, options?: DailyOptions): Promise<KLine[]>

  /** 查询某只股票的实时行情 */
  quote(symbol: string): Promise<Quote>
}
