// 收藏股票：localStorage 即时缓存 + 服务端 .data/prefs.json 持久化（换浏览器/换电脑不丢）
import { fetchPrefs, savePrefs } from '../api'

export interface FavStock {
  code: string
  name?: string
}

const KEY = 'bullrider.favs'
const MAX = 30

let listeners: Array<(f: FavStock[]) => void> = []

/** 订阅收藏变化（服务端水合/任何页面改动都会广播），返回取消订阅函数 */
export function subscribeFavorites(cb: (f: FavStock[]) => void): () => void {
  listeners.push(cb)
  return () => { listeners = listeners.filter((l) => l !== cb) }
}

function emit(list: FavStock[]): void {
  for (const l of listeners) l(list)
}

export function loadFavorites(): FavStock[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const arr = JSON.parse(raw) as FavStock[]
      if (Array.isArray(arr)) return arr.filter((f) => f && typeof f.code === 'string' && f.code.trim())
    }
  } catch { /* 坏数据忽略 */ }
  return []
}

function saveLocal(list: FavStock[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))) } catch { /* 存储满忽略 */ }
}

/** 本地 + 服务端双写，并广播给所有订阅页面 */
function persist(list: FavStock[]): void {
  saveLocal(list)
  emit(list)
  void savePrefs({ favorites: list }).catch(() => { /* 服务器不可达时先用本地缓存 */ })
}

/** 有则删、无则加（新收藏排最前），返回新列表 */
export function toggleFavorite(code: string, name?: string): FavStock[] {
  const list = loadFavorites()
  const i = list.findIndex((f) => f.code === code)
  if (i >= 0) list.splice(i, 1)
  else list.unshift({ code, name })
  persist(list)
  return list
}

export function removeFavorite(code: string): FavStock[] {
  const list = loadFavorites().filter((f) => f.code !== code)
  persist(list)
  return list
}

let hydrated = false

/** 应用启动时调用一次：服务器有数据 → 覆盖本地并广播；本地有旧数据而服务器没有 → 上传迁移 */
export async function hydrateFavorites(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const p = await fetchPrefs()
    const server = (p.favorites ?? []).filter((f) => f && typeof f.code === 'string')
    if (server.length > 0) {
      persist(server)
    } else {
      const local = loadFavorites()
      if (local.length > 0) void savePrefs({ favorites: local }).catch(() => { /* 离线就算了 */ })
    }
  } catch { /* 服务器不可达：继续用本地缓存 */ }
}
