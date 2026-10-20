// 模拟账户的落盘存取（JSON 文件，仅本地个人使用）
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PaperAccount } from './types'

const ACCOUNT_FILE = resolve(process.cwd(), '.data', 'paper', 'account.json')

export function accountFilePath(): string {
  return ACCOUNT_FILE
}

/** 读取账户；不存在返回 null */
export async function loadAccount(): Promise<PaperAccount | null> {
  try {
    return JSON.parse(await readFile(ACCOUNT_FILE, 'utf-8')) as PaperAccount
  } catch {
    return null
  }
}

/** 保存账户（自动打 updatedAt） */
export async function saveAccount(account: PaperAccount): Promise<void> {
  account.updatedAt = new Date().toISOString()
  await mkdir(resolve(ACCOUNT_FILE, '..'), { recursive: true })
  await writeFile(ACCOUNT_FILE, JSON.stringify(account, null, 2), 'utf-8')
}
