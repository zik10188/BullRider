// 挂价参考测试（纯函数：ATR 计算 / 三档价格 / ETF 最小变动单位 / 数据不足降级 / 保守档钳制）
import test from 'node:test'
import assert from 'node:assert/strict'
import { computePriceGuide, tickOf } from '../price-guide/compute'
import type { KLine } from '../market-data/types'

/** 造一根带指定高低点的日K（日期仅占位） */
function bar(i: number, close: number, high: number, low: number): KLine {
  return { date: `2026-09-${String(1 + i).padStart(2, '0')}`, open: close, close, high, low, volume: 1000, amount: 1000 }
}

/** 15 根恒定波幅日K：close=10，high=10.5，low=9.5 → 每根 TR = max(1, 0.5, 0.5) = 1，ATR = 1 */
function steadyBars(n = 15): KLine[] {
  return Array.from({ length: n }, (_, i) => bar(i, 10, 10.5, 9.5))
}

test('tickOf：股票 0.01，沪 5 / 深 15 开头 ETF 0.001', () => {
  assert.equal(tickOf('600519'), 0.01)
  assert.equal(tickOf('000823'), 0.01)
  assert.equal(tickOf('510300'), 0.001)
  assert.equal(tickOf('159915'), 0.001)
})

test('ATR 与三档价格：恒定波幅数据下每档精确可推', () => {
  const g = computePriceGuide('000823', 10, steadyBars())
  if (!g.available) return assert.fail('应当可用')
  assert.ok(Math.abs(g.atr - 1) < 1e-9)
  assert.equal(g.atrPercent, 10)
  assert.equal(g.support, 9.5)
  const [aggr, steady, cons] = g.tiers
  // 激进 = 现价 + 1 tick = 10.01；稳健 = floor(10 − 0.4) = 9.60；保守 = max(9.5, floor(8.8)) 且 < 稳健 = 9.5
  assert.equal(aggr.price, 10.01)
  assert.equal(steady.price, 9.6)
  assert.equal(cons.price, 9.5)
})

test('ETF 最小变动单位 0.001：激进档对齐千分位', () => {
  const g = computePriceGuide('510300', 4.207, steadyBars())
  assert.ok(g.available)
  if (!g.available) return
  assert.equal(g.tick, 0.001)
  assert.equal(g.tiers[0].price, 4.208)
})

test('日K不足 15 根：available=false 且给人话原因', () => {
  const g = computePriceGuide('000823', 10, steadyBars(14))
  assert.equal(g.available, false)
  if (!g.available) assert.match(g.reason, /日K不足 15 根/)
})

test('现价无效：available=false', () => {
  assert.equal(computePriceGuide('000823', 0, steadyBars()).available, false)
  assert.equal(computePriceGuide('000823', NaN, steadyBars()).available, false)
})

test('保守档钳制：窄幅横盘股保守档不高于稳健档 − 1 tick', () => {
  // 恒定 TR=0.02：high=10.01 low=9.99 close=10 → ATR=0.02
  const bars = Array.from({ length: 15 }, (_, i) => bar(i, 10, 10.01, 9.99))
  const g = computePriceGuide('000823', 10, bars)
  assert.ok(g.available)
  if (!g.available) return
  const steady = g.tiers[1].price
  const cons = g.tiers[2].price
  assert.ok(cons <= steady - 0.01, `保守档 ${cons} 应低于稳健档 ${steady} − 1 tick`)
})
