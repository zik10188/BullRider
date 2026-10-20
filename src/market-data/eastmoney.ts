// 东方财富行情供应商（免费公开 HTTP 接口，仅个人学习研究，遵守其频率限制）
// 数据版权说明见 docs/risk-compliance.md：不得商业转售/分发。
import type { DailyOptions, KLine, Quote } from './types'
import type { MarketDataProvider } from './provider'

/** 股票/场内ETF代码 -> 东方财富 secid 的市场段：沪市（6 股票、5 ETF）→ 1.x，深市（0/3 股票、15 ETF）→ 0.x */
export function toSecId(symbol: string): string {
  if (/^6/.test(symbol) || /^5/.test(symbol)) return `1.${symbol}`
  if (/^(0|3)/.test(symbol) || /^15/.test(symbol)) return `0.${symbol}`
  throw new Error(`暂不支持该代码（目前支持沪深A股与场内ETF）: ${symbol}`)
}

/** 东财接口常用的 ut 参数 */
const UT = 'fa5fd1943c7b386f172d6893dbfba10b'

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BullRider/0.1',
      Referer: 'https://quote.eastmoney.com/',
    },
  })
  if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}: ${url}`)
  return res.json() as Promise<T>
}

interface KlineApiResponse {
  data?: { code?: string; name?: string; klines?: string[] }
}

interface QuoteApiResponse {
  data?: {
    f43?: number // 最新价（按 f59 精度缩放）
    f44?: number // 最高
    f45?: number // 最低
    f46?: number // 今开
    f57?: string // 代码
    f58?: string // 名称
    f59?: number // 价格精度位数：股票 2（÷100），场内基金 3（÷1000）
    f60?: number // 昨收
    f170?: number // 涨跌幅（×100）
  }
}

/** 价格字段按接口给出的精度位数缩放（f59 缺省按股票的 2 位处理） */
export function scaleBy(v: number | undefined, digits: number | undefined): number {
  return v == null ? 0 : v / 10 ** (digits ?? 2)
}

export class EastmoneyProvider implements MarketDataProvider {
  readonly name = 'eastmoney'

  async daily(symbol: string, options: DailyOptions = {}): Promise<KLine[]> {
    const { days = 120 } = options
    const secid = toSecId(symbol)
    const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
      + `?secid=${secid}&ut=${UT}&fields1=f1,f2,f3,f4,f5,f6`
      + `&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${days}`
    const json = await getJson<KlineApiResponse>(url)
    const data = json.data
    if (!data || !data.klines || data.klines.length === 0) {
      throw new Error(`行情接口无数据: ${symbol}`)
    }
    return data.klines.map((line) => {
      const [date, open, close, high, low, volume, amount] = line.split(',')
      return {
        date,
        open: +open,
        close: +close,
        high: +high,
        low: +low,
        volume: +volume,
        amount: +amount,
      }
    })
  }

  async quote(symbol: string): Promise<Quote> {
    const secid = toSecId(symbol)
    const url = 'https://push2.eastmoney.com/api/qt/stock/get'
      + `?secid=${secid}&ut=${UT}&fields=f43,f44,f45,f46,f57,f58,f59,f60,f170`
    const json = await getJson<QuoteApiResponse>(url)
    const d = json.data
    if (!d) throw new Error(`行情接口无数据: ${symbol}`)
    const digits = d.f59
    return {
      symbol,
      name: d.f58 ?? symbol,
      price: scaleBy(d.f43, digits),
      open: scaleBy(d.f46, digits),
      high: scaleBy(d.f44, digits),
      low: scaleBy(d.f45, digits),
      prevClose: scaleBy(d.f60, digits),
      changePercent: d.f170 == null ? 0 : d.f170 / 100,
    }
  }
}
