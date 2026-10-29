// 用户偏好持久化：.data/prefs.json（收藏 / AI 对话历史 / 模型设置）
// API Key 不明文落盘：用独立密钥文件 .data/prefs.key 做 AES-256-GCM 加密。
// 诚实边界：密钥与密文同机，防的是"文件被拷走/误传、随手翻文件"，防不了本机管理员级访问。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

/** 模型设置（encApiKey 为密文，永不原样返回给前端） */
export interface LlmPrefs {
  baseUrl?: string
  model?: string
  contextWindow?: number
  encApiKey?: string
}

export interface Prefs {
  favorites?: unknown[]
  chat?: unknown[]
  llm?: LlmPrefs
  /** 全局"当前股票"：行情/回测共用，记住上次查询 */
  lastSymbol?: string
  /** 查询历史：AI 教练注入最近看过的股票 */
  queryHistory?: Array<{ code: string; name?: string }>
  /** 实盘手续费估算：佣金费率（百分比）与最低佣金 */
  realFee?: {
    commissionRatePercent?: number
    minCommission?: number
  }
}

const DEFAULT_DIR = resolve(process.cwd(), '.data')

function prefsFile(dir: string): string {
  return resolve(dir, 'prefs.json')
}

function keyFile(dir: string): string {
  return resolve(dir, 'prefs.key')
}

/** 读取（或首次生成）密钥文件：32 字节随机数 */
async function loadOrCreateKey(dir: string): Promise<Buffer> {
  try {
    const raw = await readFile(keyFile(dir), 'utf-8')
    const buf = Buffer.from(raw.trim(), 'hex')
    if (buf.length === 32) return buf
  } catch { /* 不存在则生成 */ }
  const buf = randomBytes(32)
  await mkdir(dir, { recursive: true })
  await writeFile(keyFile(dir), buf.toString('hex') + '\n', 'utf-8')
  return buf
}

/** AES-256-GCM 加密，输出 iv.tag.ciphertext（均 base64） */
export async function encryptSecret(plain: string, dir: string = DEFAULT_DIR): Promise<string> {
  const key = await loadOrCreateKey(dir)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.')
}

/** 解密；密钥文件丢失或密文被换 → 返回 null（当没存过处理） */
export async function decryptSecret(blob: string, dir: string = DEFAULT_DIR): Promise<string | null> {
  try {
    const [ivB64, tagB64, dataB64] = blob.split('.')
    if (!ivB64 || !tagB64 || !dataB64) return null
    const key = await loadOrCreateKey(dir)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf-8')
  } catch {
    return null
  }
}

export async function loadPrefs(dir: string = DEFAULT_DIR): Promise<Prefs> {
  try {
    const raw = await readFile(prefsFile(dir), 'utf-8')
    return JSON.parse(raw) as Prefs
  } catch {
    return {}
  }
}

export async function savePrefs(prefs: Prefs, dir: string = DEFAULT_DIR): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(prefsFile(dir), JSON.stringify(prefs, null, 2), 'utf-8')
}

/** 前端展示用掩码，如 sk-****abcd */
export function maskKey(key: string | undefined | null): string | undefined {
  if (!key) return undefined
  if (key.length <= 8) return '****'
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}
