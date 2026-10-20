// 唐奇安突破 + 布林带策略测试（合成数据，不碰网络）
import test from 'node:test'
import assert from 'node:assert/strict'
import { DonchianProvider } from '../signal/donchian'
import { BollingerProvider } from '../signal/bollinger'
import { series } from './helpers'

// ---------- 唐奇安 ----------

test('donchian：20根横盘后跳涨创新高 → BUY', () => {
  const closes = Array<number>(20).fill(10).concat([11])
  const s = new DonchianProvider().evaluate(series(closes))
  assert.equal(s.kind, 'BUY')
  assert.equal(s.strategy, 'donchian')
  assert.ok(s.indicators.upper > 0 && s.indicators.lower > 0)
})

test('donchian：20根横盘后跳跌破新低 → SELL', () => {
  const closes = Array<number>(20).fill(10).concat([9])
  assert.equal(new DonchianProvider().evaluate(series(closes)).kind, 'SELL')
})

test('donchian：通道内平收 → HOLD', () => {
  // 前 20 日 10 元，当日平收 10：未创新高也未破新低
  const closes = Array<number>(20).fill(10).concat([10])
  assert.equal(new DonchianProvider().evaluate(series(closes)).kind, 'HOLD')
})

test('donchian：K线不足 21 根 → 报错', () => {
  assert.throws(() => new DonchianProvider().evaluate(series(Array<number>(20).fill(10))))
})

// ---------- 布林带 ----------

test('bollinger：横盘后大跌出下轨 → BUY', () => {
  const closes = Array<number>(20).fill(10).concat([8])
  const s = new BollingerProvider().evaluate(series(closes))
  assert.equal(s.kind, 'BUY')
  assert.equal(s.strategy, 'bollinger')
  assert.ok(s.indicators.lower < 10 && s.indicators.upper > 10)
})

test('bollinger：横盘后大涨出上轨 → SELL', () => {
  const closes = Array<number>(20).fill(10).concat([12])
  assert.equal(new BollingerProvider().evaluate(series(closes)).kind, 'SELL')
})

test('bollinger：带内波动 → HOLD', () => {
  // 10 上下 2% 小幅波动，最后一根 10.1，远未出 ±2σ 轨道
  const closes = Array.from({ length: 20 }, (_, i) => 10 * (1 + (i % 2 === 0 ? 0.02 : -0.02))).concat([10.1])
  assert.equal(new BollingerProvider().evaluate(series(closes)).kind, 'HOLD')
})

test('bollinger：K线不足 20 根 → 报错', () => {
  assert.throws(() => new BollingerProvider().evaluate(series(Array<number>(19).fill(10))))
})
