// 行情数据类型定义

/** 一根日K线 */
export interface KLine {
  /** 交易日期 YYYY-MM-DD */
  date: string
  /** 开盘价 */
  open: number
  /** 收盘价 */
  close: number
  /** 最高价 */
  high: number
  /** 最低价 */
  low: number
  /** 成交量（手） */
  volume: number
  /** 成交额（元） */
  amount: number
}

/** 拉取日K的参数 */
export interface DailyOptions {
  /** 取最近多少根（默认 120） */
  days?: number
}

/** 实时行情快照 */
export interface Quote {
  symbol: string
  name: string
  /** 最新价 */
  price: number
  /** 今开 */
  open: number
  /** 最高 */
  high: number
  /** 最低 */
  low: number
  /** 昨收 */
  prevClose: number
  /** 涨跌幅（百分比，如 2.5 表示 +2.5%） */
  changePercent: number
}
