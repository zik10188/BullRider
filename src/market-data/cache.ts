// 日K缓存：磁盘缓存（.data/klines/），CLI 与 Web 共用
// 规则：
//   ① 10 分钟内的重复请求 → 直接命中（防连刷）
//   ② 当天 16 点后（收盘）或周末拉过 → 当天不再重复请求（收盘数据不再变）
//   ③ 缓存绝不跨天使用：前复权价格在除权后会变，跨天必须重新拉取
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { KLine } from './types'

const DIR = resolve(process.cwd(), '.data', 'klines')
const BURST_TTL_MS = 10 * 60 * 1000

interface CacheEntry {
  symbol: string
  fetchedAt: string
  klines: KLine[]
}

function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export async function loadCache(symbol: string): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(resolve(DIR, `${symbol}.json`), 'utf-8')
    const entry = JSON.parse(raw) as CacheEntry
    if (!Array.isArray(entry.klines) || entry.klines.length === 0) return null
    return entry
  } catch {
    return null
  }
}

/** 是否可以直接用缓存（满足任一：10 分钟内拉过 / 今天收盘后或周末拉过） */
export function isFresh(entry: CacheEntry): boolean {
  const now = Date.now()
  const fetched = new Date(entry.fetchedAt).getTime()
  if (Number.isFinite(fetched) && now - fetched < BURST_TTL_MS) return true

  if (entry.fetchedAt.slice(0, 10) !== localToday()) return false
  const d = new Date()
  const weekend = d.getDay() === 0 || d.getDay() === 6
  const afterClose = d.getHours() >= 16
  return afterClose || weekend
}

/** 合并进缓存并落盘（按日期去重，新数据覆盖旧数据） */
export async function saveCache(symbol: string, klines: KLine[]): Promise<void> {
  const old = await loadCache(symbol)
  const merged = new Map<string, KLine>()
  for (const k of old?.klines ?? []) merged.set(k.date, k)
  for (const k of klines) merged.set(k.date, k)
  const all = [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  await mkdir(DIR, { recursive: true })
  await writeFile(
    resolve(DIR, `${symbol}.json`),
    JSON.stringify({ symbol, fetchedAt: new Date().toISOString(), klines: all } satisfies CacheEntry, null, 2),
    'utf-8',
  )
}
