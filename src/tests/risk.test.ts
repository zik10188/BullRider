// 风控规则测试
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import RiskService from '../risk/service'
import { DEFAULT_RISK_CONFIG } from '../risk/types'

function makeRisk(overrides: Partial<typeof DEFAULT_RISK_CONFIG> = {}): RiskService {
  return new RiskService(new Context(), overrides)
}

test('风控：单股仓位超限 → 拒绝', () => {
  const risk = makeRisk({ maxPositionRatio: 0.25 })
  // 总资产 10万，已持有 1万，再买 2万 → 3/10 = 30% > 25%
  const v = risk.checkBuy({ cost: 20_000, cash: 90_000, equity: 100_000, currentPosValue: 10_000, totalPosValue: 10_000, todayLoss: 0 })
  assert.equal(v.allowed, false)
  assert.match(v.reason ?? '', /单股仓位超限/)
})

test('风控：现金不足 → 拒绝', () => {
  const risk = makeRisk()
  const v = risk.checkBuy({ cost: 50_000, cash: 10_000, equity: 100_000, currentPosValue: 0, totalPosValue: 90_000, todayLoss: 0 })
  assert.equal(v.allowed, false)
  assert.match(v.reason ?? '', /现金不足/)
})

test('风控：总仓位超限 → 拒绝', () => {
  const risk = makeRisk({ totalPositionRatio: 0.8 })
  // 已持仓 7万，再买 2万 → 9/10 = 90% > 80%
  const v = risk.checkBuy({ cost: 20_000, cash: 30_000, equity: 100_000, currentPosValue: 0, totalPosValue: 70_000, todayLoss: 0 })
  assert.equal(v.allowed, false)
  assert.match(v.reason ?? '', /总仓位超限/)
})

test('风控：单日亏损熔断 → 拒绝', () => {
  const risk = makeRisk({ dailyLossLimit: 2000 })
  const v = risk.checkBuy({ cost: 5000, cash: 50_000, equity: 100_000, currentPosValue: 0, totalPosValue: 50_000, todayLoss: 2500 })
  assert.equal(v.allowed, false)
  assert.match(v.reason ?? '', /熔断/)
})

test('风控：全部合规 → 放行', () => {
  const risk = makeRisk({ maxPositionRatio: 0.25, totalPositionRatio: 0.8 })
  const v = risk.checkBuy({ cost: 10_000, cash: 90_000, equity: 100_000, currentPosValue: 0, totalPosValue: 0, todayLoss: 0 })
  assert.equal(v.allowed, true)
})

test('止损：浮亏跌破止损线 → 触发', () => {
  const risk = makeRisk({ stopLossRatio: 0.08 })
  const s = risk.checkStopLoss({ symbol: '600519', avgCost: 100, price: 91 }) // -9%
  assert.equal(s.triggered, true)
  assert.match(s.reason ?? '', /止损/)
})

test('止损：浮亏未到线 / 浮盈 → 不触发', () => {
  const risk = makeRisk({ stopLossRatio: 0.08 })
  assert.equal(risk.checkStopLoss({ symbol: '600519', avgCost: 100, price: 95 }).triggered, false) // -5%
  assert.equal(risk.checkStopLoss({ symbol: '600519', avgCost: 100, price: 120 }).triggered, false)
})
