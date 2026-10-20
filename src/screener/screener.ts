// 选股推荐（漏斗式全市场扫描）：
//   第一层 东财全市场快照（沪深主板，2~3 次请求拿全部）→ 条件粗筛
//   第二层 逐只拉日K（复用 market-data 缓存）→ 完整策略赛马精算
//   第三层 输出 BUY 名单（按买方权重排序），排除实盘已持仓股
// 只扫沪深主板：创业板/科创板/北交所有开户门槛，新手用户默认不可交易
import type { KLine } from '../market-data/types'
import { CompositeProvider } from '../signal/composite'
import { loadJournal, derivePositions } from '../real/journal'
import { loadEtfList } from './etf-list'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const DEFAULT_DIR = resolve(process.cwd(), '.data')

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const SNAPSHOT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BullRider/0.1',
  Referer: 'https://finance.sina.com.cn/',
}

/**
 * 单页快照拉取：失败退避重试。新浪网关偶发 502/网络抖动，重试可吸收临时故障；
 * 重试耗尽仍失败抛最后一次错误，由上层终止扫描并提示用户稍后再试。
 */
export async function fetchSnapshotPage(
  url: string,
  retries = 2,
  backoffMs = 500,
): Promise<Array<Record<string, number | string>> | null> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: SNAPSHOT_HEADERS })
      if (res.ok) return (await res.json()) as Array<Record<string, number | string>> | null
      lastErr = new Error(`快照请求失败 HTTP ${res.status}`)
    } catch (err) {
      lastErr = err // 网络断连 / 返回非 JSON（风控页），同样走重试
    }
    if (attempt < retries) await sleep(backoffMs * (attempt + 1)) // 500ms → 1s 线性退避
  }
  throw lastErr
}

export interface ScanOptions {
  minPrice: number
  maxPrice: number
  maxCandidates: number
  minAmount: number
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  // 总资产 1 万档：最高 25 元保证一手 ≤ 2500 元（占总资产 25%，强制留分散空间），
  // 最低 5 元剔除低价股区（面值退市高危 + 僵尸股密集）；
  // 精算上限 100：200 只的请求量曾连续两天触发东财 IP 风控（第 1 天 65/200 失败、第 2 天彻底拒连），降回 100 保数据源安全（2026-10-14 用户定）
  minPrice: 5,
  maxPrice: 25,
  maxCandidates: 100,
  minAmount: 20_000_000, // 日成交额 ≥ 2000 万，过滤僵尸股
}

export interface SnapshotRow {
  code: string
  name: string
  price: number
  changePercent: number
  amount: number
  listDate: string // YYYYMMDD，空为未知
}

export interface ScanHit {
  code: string
  name: string
  price: number
  changePercent: number
  buyWeight: number
  /** 品种类型：etf = 来自白名单池，stock = 快照漏斗筛出 */
  kind: 'stock' | 'etf'
  reason: string
}

export interface ScanReport {
  id: string
  at: string
  options: ScanOptions
  totalMarket: number
  passedFilter: number
  excludedHeld: string[]
  scanned: number
  /** ETF 白名单池本次精算的只数 */
  etfScanned: number
  buys: ScanHit[]
}

/**
 * 全市场快照（沪深 A 股，按成交额降序分页）。
 * 数据源用新浪：东财 clist 接口对全量翻页有 IP 风控（实测连续翻 35 页即断连）。
 * 无上市日期字段：次新股由第三层兜底（日K不足 60 根时赛马自动跳过）。
 */
export async function fetchMainBoardSnapshot(): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= 80; page++) {
    const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
      + `?page=${page}&num=100&sort=amount&asc=0&node=hs_a&symbol=&_s_r_a=page`
    const arr = await fetchSnapshotPage(url)
    if (!Array.isArray(arr) || arr.length === 0) break // 翻过尾页
    for (const d of arr) {
      const code = String(d.code ?? '')
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue
      // 只留沪深主板：60xxxx（沪）、000/001/002/003（深）。创业板 30/科创板 68 有开户门槛，新手默认不可交易
      if (!/^(60|000|001|002|003)/.test(code)) continue
      seen.add(code)
      rows.push({
        code,
        name: String(d.name ?? ''),
        price: Number(d.trade),
        changePercent: Number(d.changepercent),
        amount: Number(d.amount),
        listDate: '',
      })
    }
    await sleep(200) // 遵守接口频率
  }
  return rows
}

/** 列表上市是否满 minAgeDays 自然日（防次新股：走势无参考、波动失真） */
export function isListedLongEnough(listDate: string, minAgeDays = 90, today = new Date()): boolean {
  if (!/^\d{8}$/.test(listDate)) return true // 无日期信息不误杀
  const d = new Date(Number(listDate.slice(0, 4)), Number(listDate.slice(4, 6)) - 1, Number(listDate.slice(6, 8)))
  if (Number.isNaN(d.getTime())) return true
  return (today.getTime() - d.getTime()) / 86_400_000 >= minAgeDays
}

/** 第一层硬过滤（纯函数，可测）：价格区间、非 ST/退、非次新、非涨跌停、成交额、停牌 */
export function filterSnapshot(rows: SnapshotRow[], opts: ScanOptions, today = new Date()): SnapshotRow[] {
  return rows.filter((r) => {
    if (!r.code || !Number.isFinite(r.price) || r.price <= 0) return false // 停牌/无效价
    if (r.price < opts.minPrice || r.price > opts.maxPrice) return false
    if (/ST|退/i.test(r.name)) return false
    if (!isListedLongEnough(r.listDate, 90, today)) return false
    if (Math.abs(r.changePercent) >= 9.8) return false // 涨停买不进/跌停没意义
    if (r.amount < opts.minAmount) return false
    return true
  })
}

/**
 * 执行一次扫描。
 * daily 由调用方注入（Web 端传 ctx.marketData.daily，自动复用磁盘缓存），内部做限速。
 */
export async function runScan(
  opts: ScanOptions,
  daily: (symbol: string, days: number) => Promise<KLine[]>,
  log: (msg: string) => void = () => {},
): Promise<ScanReport> {
  const snapshot = await fetchMainBoardSnapshot()
  const filtered = filterSnapshot(snapshot, opts)
  log(`快照 ${snapshot.length} 只 → 硬过滤后 ${filtered.length} 只`)

  // 排除实盘已持仓（用户要求：已持仓股不进推荐）
  const held = new Set((await derivePositions(await loadJournal())).map((p) => p.code))
  const excludedHeld = filtered.filter((r) => held.has(r.code)).map((r) => r.code)
  const candidates = filtered.filter((r) => !held.has(r.code)).slice(0, opts.maxCandidates)
  log(`排除实盘持仓 ${excludedHeld.length} 只，精算前 ${candidates.length} 只`)

  const composite = new CompositeProvider()
  const buys: ScanHit[] = []
  let scanned = 0
  for (const c of candidates) {
    try {
      const klines = await daily(c.code, 120)
      const signal = composite.evaluate(klines)
      scanned++
      if (signal.kind === 'BUY') {
        const m = /方权重 ([\d.]+)% 过半/.exec(signal.reason) // reason 形如"买入方权重 85.0% 过半"
        buys.push({
          code: c.code,
          name: c.name,
          price: c.price,
          changePercent: c.changePercent,
          buyWeight: m ? Number(m[1]) : 0,
          kind: 'stock',
          reason: signal.reason,
        })
        log(`BUY ${c.code} ${c.name} 买方权重 ${m?.[1] ?? '?'}%`)
      }
    } catch {
      // 数据不足/行情异常：跳过该股
    }
    await sleep(150) // 限速，保护免费接口
  }
  buys.sort((a, b) => b.buyWeight - a.buyWeight)

  // ETF 白名单池：固定清单全量精算，不占个股的精算名额；白名单已人工筛选，不做价格/成交额过滤，仅排除实盘持仓
  const etfList = (await loadEtfList()).filter((e) => !held.has(e.code))
  let etfScanned = 0
  for (const e of etfList) {
    try {
      const klines = await daily(e.code, 120)
      if (klines.length < 2) continue
      const signal = composite.evaluate(klines)
      etfScanned++
      if (signal.kind === 'BUY') {
        const m = /方权重 ([\d.]+)% 过半/.exec(signal.reason)
        const last = klines[klines.length - 1]
        const prev = klines[klines.length - 2]
        buys.push({
          code: e.code,
          name: e.name,
          price: last.close,
          changePercent: prev.close > 0 ? ((last.close / prev.close) - 1) * 100 : 0,
          buyWeight: m ? Number(m[1]) : 0,
          kind: 'etf',
          reason: signal.reason,
        })
        log(`BUY ${e.code} ${e.name}（ETF）买方权重 ${m?.[1] ?? '?'}%`)
      }
    } catch {
      // 日K不足（新上市 ETF）/行情异常：跳过
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  buys.sort((a, b) => b.buyWeight - a.buyWeight)

  return {
    id: randomBytes(4).toString('hex'),
    at: new Date().toISOString(),
    options: opts,
    totalMarket: snapshot.length,
    passedFilter: filtered.length,
    excludedHeld,
    scanned,
    etfScanned,
    buys,
  }
}

function reportFile(dir: string): string {
  return resolve(dir, 'scan-latest.json')
}

export async function saveScanReport(report: ScanReport, dir: string = DEFAULT_DIR): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(reportFile(dir), JSON.stringify(report, null, 2), 'utf-8')
}

export async function loadScanReport(dir: string = DEFAULT_DIR): Promise<ScanReport | null> {
  try {
    const raw = await readFile(reportFile(dir), 'utf-8')
    return JSON.parse(raw) as ScanReport
  } catch {
    return null
  }
}
