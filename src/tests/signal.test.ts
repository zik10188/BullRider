// 信号策略测试（合成数据，不碰网络）
import test from 'node:test'
import assert from 'node:assert/strict'
import { MaCrossProvider } from '../signal/ma-cross'
import { RsiProvider } from '../signal/rsi'
import { MacdProvider } from '../signal/macd'
import { series } from './helpers'

test('ma-cross：12根横盘后跳涨 → 金叉 → BUY', () => {
  const closes = Array<number>(12).fill(10).concat([30])
  const signal = new MaCrossProvider().evaluate(series(closes))
  assert.equal(signal.kind, 'BUY')
  assert.equal(signal.strategy, 'ma-cross')
})

test('ma-cross：12根横盘后跳跌 → 死叉 → SELL', () => {
  const closes = Array<number>(12).fill(10).concat([2])
  const signal = new MaCrossProvider().evaluate(series(closes))
  assert.equal(signal.kind, 'SELL')
})

test('ma-cross：全程横盘 → 无交叉 → HOLD', () => {
  const closes = Array<number>(15).fill(10)
  const signal = new MaCrossProvider().evaluate(series(closes))
  assert.equal(signal.kind, 'HOLD')
})

test('ma-cross：数据不足应报错', () => {
  assert.throws(() => new MaCrossProvider().evaluate(series([10, 10, 10])))
})

test('rsi：持续上涨 → 超买 → SELL', () => {
  const closes = Array.from({ length: 25 }, (_, i) => 10 + i)
  const signal = new RsiProvider().evaluate(series(closes))
  assert.equal(signal.kind, 'SELL')
  assert.ok(signal.indicators.rsi > 70)
})

test('rsi：持续下跌 → 超卖 → BUY', () => {
  const closes = Array.from({ length: 25 }, (_, i) => 60 - i)
  const signal = new RsiProvider().evaluate(series(closes))
  assert.equal(signal.kind, 'BUY')
  assert.ok(signal.indicators.rsi < 30)
})

test('rsi：温和波动 → 中性 → HOLD', () => {
  const closes = Array.from({ length: 25 }, (_, i) => 10 + (i % 2 === 0 ? 0.5 : -0.5))
  const signal = new RsiProvider().evaluate(series(closes))
  assert.equal(signal.kind, 'HOLD')
})

test('macd：先跌后强势拉升 → 多头动能（DIF > DEA）', () => {
  const down = Array.from({ length: 15 }, (_, i) => 20 - i * 0.5)
  const up = Array.from({ length: 30 }, (_, i) => 12.5 * Math.pow(1.03, i + 1))
  const signal = new MacdProvider().evaluate(series([...down, ...up]))
  assert.ok(signal.indicators.dif > signal.indicators.dea)
  assert.notEqual(signal.kind, 'SELL')
})

test('macd：先涨后持续下跌 → 空头动能（DIF < DEA）', () => {
  const up = Array.from({ length: 15 }, (_, i) => 10 * Math.pow(1.02, i + 1))
  const down = Array.from({ length: 30 }, (_, i) => up[up.length - 1] * Math.pow(0.97, i + 1))
  const signal = new MacdProvider().evaluate(series([...up, ...down]))
  assert.ok(signal.indicators.dif < signal.indicators.dea)
  assert.notEqual(signal.kind, 'BUY')
})

test('macd：数据不足应报错', () => {
  assert.throws(() => new MacdProvider().evaluate(series(Array<number>(20).fill(10))))
})
