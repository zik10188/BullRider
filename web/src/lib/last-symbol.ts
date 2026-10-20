// 全局"当前股票"：四个页面共用一个，查询过就记住。
// localStorage 即时缓存（服务重启也在）+ 服务端 prefs 持久化（换浏览器也在）。
import { fetchPrefs, savePrefs } from '../api'

const KEY = 'bullrider.lastSymbol'
const DEFAULT_SYMBOL = '600519'

let listeners: Array<(s: string) => void> = []
let current = ''

function isSymbol(s: string): boolean {
  return /^\d{6}$/.test(s)
}

/** 读取全局当前股票（无记录时回退默认 600519） */
export function loadLastSymbol(): string {
  if (current) return current
  try {
    const raw = localStorage.getItem(KEY)
    if (raw && isSymbol(raw)) current = raw
  } catch { /* 忽略 */ }
  return current || DEFAULT_SYMBOL
}

/** 更新全局当前股票并广播（非法代码、与当前相同则忽略） */
export function setLastSymbol(code: string): void {
  const c = code.trim()
  if (!isSymbol(c) || c === current) return
  current = c
  try { localStorage.setItem(KEY, c) } catch { /* 忽略 */ }
  for (const l of listeners) l(c)
  void savePrefs({ lastSymbol: c }).catch(() => { /* 服务器不可达时先用本地缓存 */ })
}

/** 订阅全局变化（其他页面改动/服务端水合时收到），返回取消订阅函数 */
export function subscribeLastSymbol(cb: (s: string) => void): () => void {
  listeners.push(cb)
  return () => { listeners = listeners.filter((l) => l !== cb) }
}

let hydrated = false

/** 应用启动时调用一次：服务器记的股票覆盖本地（跨浏览器场景） */
export async function hydrateLastSymbol(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const p = await fetchPrefs()
    const s = p.lastSymbol ?? ''
    if (isSymbol(s) && s !== current) {
      current = s
      try { localStorage.setItem(KEY, s) } catch { /* 忽略 */ }
      for (const l of listeners) l(s)
    }
  } catch { /* 服务器不可达：用本地缓存 */ }
}
