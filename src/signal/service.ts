// 信号缝：SignalService
// 输入一段日K，输出交易建议。换策略 = 换 Provider，调用方不变。
import { Context, Service } from '@deepseek-ai/cordis'
import type { KLine } from '../market-data/types'
import type { Signal } from './types'
import type { SignalProvider } from './provider'

declare module '@deepseek-ai/cordis' {
  interface Context {
    signal: SignalService
  }
}

export class SignalService extends Service {
  /** 已注册的策略 */
  private providers = new Map<string, SignalProvider>()
  /** 当前默认策略 */
  private defaultProvider = 'ma-cross'

  constructor(ctx: Context) {
    super(ctx, 'signal')
  }

  /** 注册一个策略（返回注销函数，随插件卸载自动清理） */
  registerProvider(provider: SignalProvider): () => void {
    this.providers.set(provider.name, provider)
    return () => this.providers.delete(provider.name)
  }

  private get(name?: string): SignalProvider {
    const provider = this.providers.get(name ?? this.defaultProvider)
    if (!provider) throw new Error(`未注册信号策略: ${name ?? this.defaultProvider}`)
    return provider
  }

  /** 计算一个信号（可按名字选策略） */
  evaluate(klines: KLine[], strategy?: string): Signal {
    return this.get(strategy).evaluate(klines)
  }

  /** 策略的最低K线数（回测方据此设置预热期） */
  getMinBars(name?: string): number {
    return this.get(name).minBars
  }
}

export default SignalService
