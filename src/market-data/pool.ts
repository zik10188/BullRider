// 数据源故障转移池：按注册顺序逐家尝试（先主源后备用），一家失败自动换下一家。
// 带熔断：某家连续失败达到阈值后进入冷却期，冷却期内直接跳过它不再撞墙（避免风控期反复触探越封越死）；
// 冷却结束自动恢复尝试（半开），成功即清零计数。纯逻辑、无框架依赖，可离线单测。
import type { MarketDataProvider } from './provider'

export interface PoolLogger {
  info(msg: string): void
  warn(msg: string): void
}

const NOOP_LOGGER: PoolLogger = { info: () => {}, warn: () => {} }

export class ProviderPool {
  private failCounts = new Map<string, number>()
  /** 熔断截止时间（epoch ms）：在此之前的请求直接跳过该数据源 */
  private openUntil = new Map<string, number>()

  constructor(
    /** 按优先级排序：第 0 家为主源，其余为备用 */
    private providers: MarketDataProvider[],
    private log: PoolLogger = NOOP_LOGGER,
    /** 连续失败多少次触发熔断（取 3：误熔断只是主源少用 5 分钟、备用无感；晚熔断则是风控期多撞墙，宁紧勿松） */
    private failLimit = 3,
    /** 熔断冷却时长（默认 5 分钟） */
    private cooldownMs = 5 * 60_000,
  ) {}

  /** 冷却期内的数据源完全不参与请求，保留注册顺序作为同级优先级 */
  private available(): MarketDataProvider[] {
    const now = Date.now()
    return this.providers.filter((p) => now >= (this.openUntil.get(p.name) ?? 0))
  }

  private record(name: string, ok: boolean): void {
    if (ok) {
      this.failCounts.set(name, 0)
      if (this.openUntil.delete(name)) this.log.info(`[数据源] ${name} 恢复正常，解除熔断`)
      return
    }
    const n = (this.failCounts.get(name) ?? 0) + 1
    if (n >= this.failLimit) {
      this.openUntil.set(name, Date.now() + this.cooldownMs)
      this.failCounts.set(name, 0) // 冷却结束后重新计数（半开探测）
      this.log.warn(`[熔断] 数据源 ${name} 连续失败 ${n} 次，${Math.round(this.cooldownMs / 60_000)} 分钟内跳过（防止反复触探加重风控）`)
    } else {
      this.failCounts.set(name, n)
    }
  }

  /** 依次尝试各家执行同一操作，全部失败抛最后一次的错误 */
  async run<T>(op: (p: MarketDataProvider) => Promise<T>, what: string): Promise<T> {
    const available = this.available()
    if (this.providers.length === 0) throw new Error('未注册行情供应商')
    if (available.length === 0) throw new Error('所有行情供应商均处于熔断冷却期')
    let lastErr: unknown
    for (const p of available) {
      try {
        const result = await op(p)
        this.record(p.name, true)
        return result
      } catch (err) {
        lastErr = err
        this.record(p.name, false)
        this.log.warn(`[数据源] ${what} 在 ${p.name} 失败（${(err as Error).message}），切换下一家`)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}
