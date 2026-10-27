// 实盘卖出参考测试：风控止损、技术保护、两档止盈、趋势状态和数据不足边界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeSellGuide } from '../price-guide/sell-guide'
import type { KLine } from '../market-data/types'

function bar(i: number, close: number, high: number, low: number): KLine {
  return { date: `2026-09-${String(1 + i).padStart(2, '0')}`, open: close, close, high, low, volume: 1000, amount: 1000 }
}

/** ATR=1：close=10，high=10.5，low=9.5。 */
function steadyBars(n = 15): KLine[] {
  return Array.from({ length: n }, (_, i) => bar(i, 10, 10.5, 9.5))
}

test('卖出参考：正常持仓给出风控线、技术保护线和递增两档止盈', () => {
  const guide = computeSellGuide('600519', 12, 10, steadyBars(), 'HOLD', 0.1)
  assert.ok(guide.available)
  if (!guide.available) return
  assert.equal(guide.stopLossPrice, 9)
  assert.equal(guide.protectionPrice, 10.8)
  assert.equal(guide.effectiveStopPrice, 10.8)
  assert.equal(guide.targets[0].price, 12.8)
  assert.equal(guide.targets[1].price, 13.6)
  assert.equal(guide.riskTriggered, false)
  assert.equal(guide.trendLabel, '趋势中性')
})

test('卖出参考：现价跌破有效防守线时明确提示风险', () => {
  const guide = computeSellGuide('600519', 8.8, 10, steadyBars(), 'SELL', 0.1)
  assert.ok(guide.available)
  if (!guide.available) return
  assert.equal(guide.riskTriggered, true)
  assert.match(guide.advice, /不高于有效防守线/)
  assert.match(guide.advice, /执行纪律/)
})

test('卖出参考：ETF 使用 0.001 元最小变动单位', () => {
  const guide = computeSellGuide('510300', 4.207, 4.1, steadyBars(), 'HOLD', 0.1)
  assert.ok(guide.available)
  if (!guide.available) return
  assert.equal(guide.tick, 0.001)
  for (const value of [guide.stopLossPrice, guide.protectionPrice, ...guide.targets.map((t) => t.price)]) {
    assert.ok(Math.abs(value / guide.tick - Math.round(value / guide.tick)) < 1e-9)
  }
})

test('卖出参考：趋势为 SELL 时优先提示退出', () => {
  const guide = computeSellGuide('600519', 12, 10, steadyBars(), 'SELL', 0.1)
  assert.ok(guide.available)
  if (!guide.available) return
  assert.equal(guide.trend, 'SELL')
  assert.match(guide.advice, /优先考虑退出/)
})

test('卖出参考：日K不足、ATR为零、成本或现价无效时降级', () => {
  assert.equal(computeSellGuide('600519', 10, 10, steadyBars(14), 'HOLD', 0.1).available, false)
  assert.equal(computeSellGuide('600519', 0, 10, steadyBars(), 'HOLD', 0.1).available, false)
  assert.equal(computeSellGuide('600519', 10, 0, steadyBars(), 'HOLD', 0.1).available, false)
  const flat = steadyBars().map((k, i) => i === 14 ? { ...k, high: 10, low: 10 } : { ...k, high: 10, low: 10 })
  assert.equal(computeSellGuide('600519', 10, 10, flat, 'HOLD', 0.1).available, false)
})
