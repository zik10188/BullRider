// 动态权重 composite 测试：脚本化假策略构造确定性收益，验证权重机制
import test from 'node:test'
import assert from 'node:assert/strict'
import { CompositeProvider } from '../signal/composite'
import type { KLine } from '../market-data/types'
import type { Signal, SignalKind } from '../signal/types'
import type { SignalProvider } from '../signal/provider'
import { series } from './helpers'

/** 按历史长度输出固定结论的假策略（回测收益因此可精确预期） */
class ScriptedProvider implements SignalProvider {
  readonly minBars = 60
  constructor(readonly name: string, private fn: (len: number) => SignalKind) {}
  evaluate(klines: KLine[]): Signal {
    const last = klines[klines.length - 1]
    return { kind: this.fn(klines.length), date: last.date, price: last.close, strategy: this.name, reason: `${this.name} scripted`, indicators: {} }
  }
}

// 60 根 = 30 根 10 元横盘 + 30 根线性涨到 20
const uptrend = series([...Array<number>(30).fill(10), ...Array.from({ length: 30 }, (_, i) => 10 + ((i + 1) * 10) / 30)])

const earlyBird = new ScriptedProvider('early', (len) => (len >= 30 ? 'BUY' : 'HOLD')) // 涨前埋伏 → 窗口回测 ≈ +100%
const lateBird = new ScriptedProvider('late', (len) => (len >= 55 ? 'BUY' : 'HOLD'))   // 涨末才买 → ≈ +9%
const earlySeller = new ScriptedProvider('eSell', (len) => (len < 30 ? 'HOLD' : len < 50 ? 'BUY' : 'SELL')) // 涨前埋伏、涨中段卖出 ≈ +66%，期末空仓
const richHolder = new ScriptedProvider('rich', (len) => (len < 30 ? 'HOLD' : len < 46 ? 'BUY' : 'HOLD')) // 涨前埋伏拿到期末 ≈ +100%，但当前票面 HOLD
const alwaysHold = new ScriptedProvider('flat', () => 'HOLD')                          // 永不交易 → 0
const alwaysSell = new ScriptedProvider('spook', () => 'SELL')                         // 永不买入 → 0

test('权重：霸主策略（≈75%）单票 BUY 即触发', () => {
  const s = new CompositeProvider([earlyBird, alwaysHold, lateBird]).evaluate(uptrend)
  assert.equal(s.kind, 'BUY')
  assert.ok(s.indicators['w_early'] > 0.7, `早鸟权重应 ≈0.75，实际 ${s.indicators['w_early']}`)
  assert.ok(s.indicators.buyWeight >= 0.5)
})

test('权重：平权下单票 SELL（1/3）不过半 → HOLD', () => {
  const s = new CompositeProvider([alwaysSell, alwaysHold, alwaysHold]).evaluate(uptrend)
  assert.equal(s.kind, 'HOLD')
})

test('权重：两个低权重票合计（≈23%）不过半 → HOLD（霸主在 HOLD）', () => {
  const s = new CompositeProvider([richHolder, alwaysSell, new ScriptedProvider('late2', () => 'SELL')]).evaluate(uptrend)
  assert.equal(s.kind, 'HOLD')
  assert.ok(s.reason.includes('不过半'))
  assert.ok(s.indicators['w_rich'] > 0.7)
})

test('权重：霸主 SELL（≈77%）+ 低权重 SELL → SELL', () => {
  const s = new CompositeProvider([earlySeller, alwaysSell, alwaysHold]).evaluate(uptrend)
  assert.equal(s.kind, 'SELL')
  assert.ok(s.indicators['w_eSell'] > 0.7)
})

test('全员亏损/不交易 → 权重平摊（各1/3），退化为等权兜底：2卖1持 → SELL', () => {
  const s = new CompositeProvider([alwaysSell, alwaysSell, alwaysHold]).evaluate(uptrend)
  assert.equal(s.kind, 'SELL')
  assert.ok(Math.abs(s.indicators['w_flat'] - 1 / 3) < 1e-6, `平权应各 1/3，实际 ${s.indicators['w_flat']}`)
})

test('两个恒BUY霸主合计权重过半 → BUY（恒SELL票被淹没）', () => {
  const s = new CompositeProvider([alwaysSell, new ScriptedProvider('b1', () => 'BUY'), new ScriptedProvider('b2', () => 'BUY')]).evaluate(uptrend)
  // 两个恒 BUY 策略在涨势里都能赚钱 → 权重不会平摊；这条验证"赚钱的 BUY 票"合计权重过半
  assert.equal(s.kind, 'BUY')
})

test('数据不足 60 根 → 报错；恰好 60 根 → 正常', () => {
  const p = new CompositeProvider([alwaysHold, alwaysHold, alwaysHold])
  assert.throws(() => p.evaluate(uptrend.slice(0, 59)))
  assert.equal(p.evaluate(uptrend).kind, 'HOLD')
})

test('集成：真实五策略跑 60 根，权重键与 ma5/ma10 齐全，reason 带权重说明', () => {
  const s = new CompositeProvider().evaluate(uptrend)
  assert.equal(s.strategy, 'composite')
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(s.kind))
  for (const key of ['ma5', 'ma10', 'rsi', 'dif', 'dea', 'macd', 'w_ma-cross', 'w_rsi', 'w_macd', 'w_donchian', 'w_bollinger', 'bollinger.upper', 'buyWeight', 'sellWeight']) {
    assert.ok(key in s.indicators, `indicators 缺少 ${key}`)
  }
  assert.ok(s.reason.includes('回测收益定权重'))
  assert.ok(['ma-cross', 'rsi', 'macd', 'donchian', 'bollinger'].every((n) => s.reason.includes(n)))
})
