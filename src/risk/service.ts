// 风控服务：任何买入下单前必须过检查；持仓触发止损线则建议卖出。
// 对应 docs/risk-compliance.md 里的风控措施。
import { Context, Service } from '@deepseek-ai/cordis'
import { DEFAULT_RISK_CONFIG, type RiskConfig, type RiskVerdict, type StopLossCheck } from './types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    risk: RiskService
  }
}

export class RiskService extends Service {
  readonly config: RiskConfig

  constructor(ctx: Context, config: Partial<RiskConfig> = {}) {
    super(ctx, 'risk')
    this.config = { ...DEFAULT_RISK_CONFIG, ...config }
  }

  /** 买入前风控：单日熔断 / 现金 / 单股仓位 / 总仓位 */
  checkBuy(input: {
    cost: number
    cash: number
    equity: number
    currentPosValue: number
    totalPosValue: number
    todayLoss: number
  }): RiskVerdict {
    const { cost, cash, equity, currentPosValue, totalPosValue, todayLoss } = input
    if (equity <= 0) return { allowed: false, reason: '账户净值为 0，无法交易' }
    if (this.config.dailyLossLimit > 0 && todayLoss >= this.config.dailyLossLimit) {
      return { allowed: false, reason: `单日亏损熔断：今日已亏 ${todayLoss.toFixed(2)} 元（上限 ${this.config.dailyLossLimit} 元）` }
    }
    if (cost > cash) {
      return { allowed: false, reason: `现金不足：需 ${Math.round(cost).toLocaleString()} 元，现金 ${Math.round(cash).toLocaleString()} 元` }
    }
    const posRatio = (currentPosValue + cost) / equity
    if (posRatio > this.config.maxPositionRatio) {
      return { allowed: false, reason: `单股仓位超限：买入后 ${(posRatio * 100).toFixed(1)}% > 上限 ${(this.config.maxPositionRatio * 100).toFixed(0)}%（避免押注单只股票）` }
    }
    const totalRatio = (totalPosValue + cost) / equity
    if (totalRatio > this.config.totalPositionRatio) {
      return { allowed: false, reason: `总仓位超限：买入后 ${(totalRatio * 100).toFixed(1)}% > 上限 ${(this.config.totalPositionRatio * 100).toFixed(0)}%` }
    }
    return { allowed: true }
  }

  /** 止损检查：持仓浮亏是否触发止损线 */
  checkStopLoss(input: { symbol: string; avgCost: number; price: number }): StopLossCheck {
    const { symbol, avgCost, price } = input
    if (avgCost <= 0) return { triggered: false }
    const lossRatio = price / avgCost - 1
    if (lossRatio <= -this.config.stopLossRatio) {
      return { triggered: true, reason: `${symbol} 浮亏 ${(lossRatio * 100).toFixed(1)}%（已跌破 -${(this.config.stopLossRatio * 100).toFixed(0)}% 止损线）` }
    }
    return { triggered: false }
  }
}

export default RiskService
