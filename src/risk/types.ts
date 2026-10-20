// 风控类型定义与默认参数

export interface RiskConfig {
  /** 单只股票市值占总资产上限（默认 0.5 = 50%，2026-10-15 依实盘体验由 0.25 上调） */
  maxPositionRatio: number
  /** 总持仓市值占总资产上限（默认 0.8 = 80%） */
  totalPositionRatio: number
  /** 持仓浮亏超过此比例触发止损（默认 0.1 = -10%，2026-10-15 依实盘体验由 0.08 放宽） */
  stopLossRatio: number
  /** 单日已实现亏损熔断（元，默认 0 = 不启用） */
  dailyLossLimit: number
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  // 内置默认 = 用户实盘体验调优值（.data/risk.json 可按需覆盖）
  maxPositionRatio: 0.5,
  totalPositionRatio: 0.8,
  stopLossRatio: 0.1,
  dailyLossLimit: 0,
}

export interface RiskVerdict {
  allowed: boolean
  reason?: string
}

export interface StopLossCheck {
  triggered: boolean
  reason?: string
}
