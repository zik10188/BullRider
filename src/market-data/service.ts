// 数据源缝：MarketData 服务
// 消费者只认 ctx.marketData 这一个口，不关心背后是哪家供应商。
// 这就是"换数据源不换代码"的保证。
// 主备容错：注册顺序即优先级（东财为主、腾讯为备），主源失败自动切备用；
// 主源连续失败触发熔断（冷却期内不再触探，防止风控期反复撞墙），冷却结束自动恢复。
import { Context, Service } from '@deepseek-ai/cordis'
import type { DailyOptions, KLine, Quote } from './types'
import type { MarketDataProvider } from './provider'
import { isFresh, loadCache, saveCache } from './cache'
import { ProviderPool } from './pool'

declare module '@deepseek-ai/cordis' {
  interface Context {
    marketData: MarketData
  }
}

export class MarketData extends Service {
  /** 已注册的行情供应商（注册顺序即优先级：先注册的为主源） */
  private providers = new Map<string, MarketDataProvider>()
  /** 缺省主源名字：注册顺序里排最前 */
  private defaultProvider = 'eastmoney'
  private pool: ProviderPool | null = null

  constructor(ctx: Context) {
    super(ctx, 'marketData')
  }

  /** 注册一家行情供应商（返回注销函数，随插件卸载自动清理） */
  registerProvider(provider: MarketDataProvider): () => void {
    this.providers.set(provider.name, provider)
    this.pool = null // 注册表变了，下次按最新顺序重建故障转移池
    return () => {
      this.providers.delete(provider.name)
      this.pool = null
    }
  }

  /** 构建故障转移池：主源排最前，其余按注册顺序作为备用 */
  private ensurePool(): ProviderPool {
    if (!this.pool) {
      const main = this.providers.get(this.defaultProvider)
      const rest = [...this.providers.values()].filter((p) => p.name !== this.defaultProvider)
      this.pool = new ProviderPool(main ? [main, ...rest] : rest, this.ctx.logger)
    }
    return this.pool
  }

  /**
   * 拉日K线（带本地缓存）：
   * 10 分钟内重复请求 / 当天收盘后已拉过 → 直接用缓存，不请求接口。
   * 缓存不跨天（前复权价格除权后会变），见 cache.ts 注释。
   */
  async daily(symbol: string, options?: DailyOptions): Promise<KLine[]> {
    const days = options?.days ?? 120

    const cached = await loadCache(symbol)
    if (cached && cached.klines.length >= days && isFresh(cached)) {
      this.ctx.logger.info(`[缓存] ${symbol} 日K命中本地缓存（${cached.klines.length} 根，fetchedAt ${cached.fetchedAt}）`)
      return cached.klines.slice(-days)
    }

    const klines = await this.ensurePool().run((p) => p.daily(symbol, options), `日K ${symbol}`)
    await saveCache(symbol, klines)
    return klines
  }

  /** 查实时行情（不缓存，保持实时；主源挂了自动走备用） */
  quote(symbol: string): Promise<Quote> {
    return this.ensurePool().run((p) => p.quote(symbol), `行情 ${symbol}`)
  }
}

export default MarketData
