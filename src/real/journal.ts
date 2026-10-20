// 实盘记录（交易日志）：用户手工同步真实券商的成交，真金白银，与模拟盘完全隔离。
// 存储 .data/real-journal.json；按日期做移动加权汇总出真实持仓，供页面展示与 AI 教练注入。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

/** 一条实盘成交记录（以用户券商交割单为准手工录入） */
export interface RealTrade {
  id: string
  /** 交易日 YYYY-MM-DD */
  date: string
  code: string
  name?: string
  side: 'BUY' | 'SELL'
  price: number
  shares: number
  /** 手续费合计（佣金+印花税+过户费），可空 */
  fee?: number
}

/** 由记录汇总出的当前真实持仓 */
export interface RealPosition {
  code: string
  name?: string
  /** 净持仓 = 买入股数 − 卖出股数 */
  shares: number
  /** 移动加权成本（含费） */
  avgCost: number
  /** 剩余持仓占用成本 */
  positionCost: number
  /** 累计卖出净回款（不含持仓意义，仅展示） */
  totalSellAmount: number
}

const DEFAULT_DIR = resolve(process.cwd(), '.data')

function journalFile(dir: string): string {
  return resolve(dir, 'real-journal.json')
}

function validTrade(t: unknown): t is RealTrade {
  const x = t as RealTrade
  return Boolean(
    x && typeof x.id === 'string'
    && typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date)
    && typeof x.code === 'string' && /^\d{6}$/.test(x.code)
    && (x.side === 'BUY' || x.side === 'SELL')
    && typeof x.price === 'number' && x.price > 0
    && Number.isInteger(x.shares) && x.shares > 0,
  )
}

export function newId(): string {
  return Date.now().toString(36) + randomBytes(3).toString('hex')
}

export async function loadJournal(dir: string = DEFAULT_DIR): Promise<RealTrade[]> {
  try {
    const raw = await readFile(journalFile(dir), 'utf-8')
    const arr = JSON.parse(raw) as RealTrade[]
    return Array.isArray(arr) ? arr.filter(validTrade) : []
  } catch {
    return []
  }
}

export async function saveJournal(trades: RealTrade[], dir: string = DEFAULT_DIR): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(journalFile(dir), JSON.stringify(trades, null, 2), 'utf-8')
}

/** 按日期顺序做移动加权，汇总出每个代码的净持仓与成本（已清仓的代码不出现在结果里） */
export function derivePositions(trades: RealTrade[]): RealPosition[] {
  const sorted = [...trades].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)))
  const book = new Map<string, { name?: string; shares: number; cost: number; sellAmount: number }>()
  for (const t of sorted) {
    const e = book.get(t.code) ?? { name: t.name, shares: 0, cost: 0, sellAmount: 0 }
    if (t.name) e.name = t.name
    if (t.side === 'BUY') {
      e.shares += t.shares
      e.cost += t.price * t.shares + (t.fee ?? 0)
    } else {
      // 卖出按当前移动均价出账；清仓后残余浮点归零
      const avg = e.shares > 0 ? e.cost / e.shares : t.price
      e.shares -= t.shares
      e.cost -= t.shares * avg
      e.sellAmount += t.price * t.shares - (t.fee ?? 0)
      if (e.shares <= 0) { e.shares = 0; e.cost = 0 }
    }
    book.set(t.code, e)
  }
  return [...book.entries()]
    .filter(([, e]) => e.shares > 0)
    .map(([code, e]) => ({
      code,
      name: e.name,
      shares: e.shares,
      avgCost: e.cost / e.shares,
      positionCost: e.cost,
      totalSellAmount: e.sellAmount,
    }))
    .sort((a, b) => a.code.localeCompare(b.code))
}
