// 交易缝：BrokerService
// 消费者只认 ctx.broker，不关心背后是模拟盘还是真券商。换交易渠道 = 换 Provider。
import { Context, Service } from '@deepseek-ai/cordis'
import type { BrokerFill, BrokerOrder, BrokerPosition, BrokerProvider, BrokerTrade } from './types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    broker: BrokerService
  }
}

export class BrokerService extends Service {
  private providers = new Map<string, BrokerProvider>()
  private defaultProvider = 'paper'

  constructor(ctx: Context) {
    super(ctx, 'broker')
  }

  registerProvider(provider: BrokerProvider): () => void {
    this.providers.set(provider.name, provider)
    return () => this.providers.delete(provider.name)
  }

  private get(name?: string): BrokerProvider {
    const provider = this.providers.get(name ?? this.defaultProvider)
    if (!provider) throw new Error(`未注册交易渠道: ${name ?? this.defaultProvider}`)
    return provider
  }

  buy(order: BrokerOrder): Promise<BrokerFill> {
    return this.get().buy(order)
  }

  sell(order: BrokerOrder): Promise<BrokerFill> {
    return this.get().sell(order)
  }

  has(symbol: string): Promise<boolean> {
    return this.get().has(symbol)
  }

  positions(): Promise<BrokerPosition[]> {
    return this.get().positions()
  }

  cash(): Promise<number> {
    return this.get().cash()
  }

  capital(): Promise<number> {
    return this.get().capital()
  }

  trades(): Promise<BrokerTrade[]> {
    return this.get().trades()
  }
}

export default BrokerService
