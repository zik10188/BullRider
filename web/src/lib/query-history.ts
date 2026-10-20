// 查询历史：最近查询过的股票（去重、最新在前）。
// localStorage 即时缓存 + 服务端 prefs 持久化。AI 教练据此知道你最近在看哪些股票。
import { fetchPrefs, savePrefs } from '../api'

export interface QueryItem {
  code: string
  name?: string
}

const KEY = 'bullrider.queryHistory'
const MAX = 10

let listeners: Array<(list: QueryItem[]) => void> = []

/** 订阅查询历史变化，返回取消订阅函数 */
export function subscribeQueryHistory(cb: (list: QueryItem[]) => void): () => void {
  listeners.push(cb)
  return () => { listeners = listeners.filter((l) => l !== cb) }
}

function emit(list: QueryItem[]): void {
  for (const l of listeners) l(list)
}

export function loadQueryHistory(): QueryItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const arr = JSON.parse(raw) as QueryItem[]
      if (Array.isArray(arr)) return arr.filter((f) => f && typeof f.code === 'string' && /^\d{6}$/.test(f.code))
    }
  } catch { /* 坏数据忽略 */ }
  return []
}

function saveLocal(list: QueryItem[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))) } catch { /* 忽略 */ }
}

/** 记录一次查询：去重后放最前，超出上限裁掉尾部 */
export function recordQuery(code: string, name?: string): void {
  const c = code.trim()
  if (!/^\d{6}$/.test(c)) return
  const list = loadQueryHistory().filter((f) => f.code !== c)
  list.unshift({ code: c, name: name || list.find((f) => f.code === c)?.name })
  saveLocal(list)
  emit(list)
  void savePrefs({ queryHistory: list }).catch(() => { /* 服务器不可达时先用本地缓存 */ })
}

/** 从历史中移除某只（控制 AI 的视野） */
export function removeQueryHistory(code: string): QueryItem[] {
  const list = loadQueryHistory().filter((f) => f.code !== code)
  saveLocal(list)
  emit(list)
  void savePrefs({ queryHistory: list }).catch(() => { /* 忽略 */ })
  return list
}

let hydrated = false

/** 应用启动时调用一次：服务器有 → 覆盖本地；本地有旧数据而服务器没有 → 上传迁移 */
export async function hydrateQueryHistory(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const p = await fetchPrefs()
    const server = (p.queryHistory ?? []).filter((f) => f && typeof f.code === 'string')
    if (server.length > 0) {
      saveLocal(server)
      emit(server)
    } else {
      const local = loadQueryHistory()
      if (local.length > 0) void savePrefs({ queryHistory: local }).catch(() => { /* 忽略 */ })
    }
  } catch { /* 服务器不可达：用本地缓存 */ }
}
