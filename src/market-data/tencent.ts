// 腾讯行情供应商（备用数据源）：主源东财被 IP 风控时自动顶上，接口体系公开稳定、对频率宽容。
// 日K：web.ifzq.gtimg.cn fqkline（前复权，含当日实时）；实时行情：qt.gtimg.cn（GBK 文本，~ 分隔字段）。
// 仅个人学习研究用途，数据版权说明见 docs/risk-compliance.md。
// 解析逻辑导出为纯函数（parseDailyJson / parseQuoteBody），可离线单测。
import type { DailyOptions, KLine, Quote } from './types'
import type { MarketDataProvider } from './provider'

/** 股票/场内ETF代码 -> 腾讯带市场前缀的代码：沪市（6 股票、5 ETF）→ sh，深市（0/3 股票、15 ETF）→ sz */
export function toTencentSymbol(symbol: string): string {
  if (/^6/.test(symbol) || /^5/.test(symbol)) return `sh${symbol}`
  if (/^(0|3)/.test(symbol) || /^15/.test(symbol)) return `sz${symbol}`
  throw new Error(`暂不支持该代码（目前支持沪深A股与场内ETF）: ${symbol}`)
}

async function getBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BullRider/0.1' },
  })
  if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}: ${url}`)
  return res.arrayBuffer()
}

/** 腾讯 fqkline 响应：data.<symbol>.qfqday = [[date, open, close, high, low, volume, ...], ...] */
interface FqklineResponse {
  data?: Record<string, { qfqday?: string[][]; day?: string[][] }>
}

/** 解析腾讯日K响应体（JSON 文本）。腾讯不含成交额，amount 置 0（当前无消费方）；volume 单位与东财一致为手 */
export function parseDailyJson(text: string, symbol: string): KLine[] {
  const json = JSON.parse(text) as FqklineResponse
  const node = json.data?.[symbol]
  const rows = node?.qfqday ?? node?.day
  if (!rows || rows.length === 0) throw new Error(`行情接口无数据: ${symbol}`)
  return rows.map((r) => ({
    date: r[0],
    open: Number(r[1]),
    close: Number(r[2]),
    high: Number(r[3]),
    low: Number(r[4]),
    volume: Number(r[5]),
    amount: 0,
  }))
}

/**
 * 解析腾讯实时行情文本（GBK 已解码后）。格式：v_sz002181="字段0~名称~代码~现价~昨收~今开~...~涨跌幅~最高~最低~..."，
 * 字段用 ~ 分隔：[1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [32]涨跌幅% [33]最高 [34]最低
 * 腾讯同时给出 [47]涨停价 [48]跌停价。
 */
export function parseQuoteBody(text: string, symbol: string): Quote {
  const m = /=\s*"([^"]*)"/.exec(text)
  if (!m) throw new Error(`行情接口无数据: ${symbol}`)
  const f = m[1].split('~')
  const num = (i: number): number => Number(f[i])
  return {
    symbol,
    name: (f[1] ?? symbol).replace(/\s+/g, ''), // 腾讯名称里的空格是填充（如"粤 传 媒"），A股真名不含空格
    price: num(3),
    open: num(5),
    high: num(33),
    low: num(34),
    prevClose: num(4),
    limitUp: num(47),
    limitDown: num(48),
    changePercent: num(32),
  }
}

export class TencentProvider implements MarketDataProvider {
  readonly name = 'tencent'

  async daily(symbol: string, options: DailyOptions = {}): Promise<KLine[]> {
    const { days = 120 } = options
    const ts = toTencentSymbol(symbol)
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${ts},day,,,${days},qfq`
    return parseDailyJson(Buffer.from(await getBuffer(url)).toString('utf-8'), ts)
  }

  async quote(symbol: string): Promise<Quote> {
    const ts = toTencentSymbol(symbol)
    const buf = await getBuffer(`https://qt.gtimg.cn/q=${ts}`)
    // 腾讯实时行情是 GBK 编码，Node 内置 full-icu 可直接解码
    return parseQuoteBody(new TextDecoder('gbk').decode(buf), symbol)
  }
}
