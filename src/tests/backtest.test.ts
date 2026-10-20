// 回测引擎账目测试（固定决策脚本，手工可核对）
import test from 'node:test'
import assert from 'node:assert/strict'
import { runBacktest } from '../backtest/engine'
import { series, closeTo } from './helpers'
import { MaCrossProvider } from '../signal/ma-cross'
import { RsiProvider } from '../signal/rsi'
import { MacdProvider } from '../signal/macd'
import { DonchianProvider } from '../signal/donchian'
import { BollingerProvider } from '../signal/bollinger'
import { CompositeProvider } from '../signal/composite'
import type { SignalProvider } from '../signal/provider'

/** 固定价格序列：30 根，收盘全是 10 元 */
const klines = series(Array<number>(30).fill(10))

test('回测账目：第10根收盘发买入信号、下一根开盘成交，费用与盈亏手工核对', () => {
  // 第10根收盘发买入信号并在第11根开盘成交；第20根收盘发卖出信号并在第21根开盘成交
  const decide = (history: unknown[]): 'BUY' | 'SELL' | 'HOLD' => {
    const i = history.length - 1
    if (i === 10) return 'BUY'
    if (i === 20) return 'SELL'
    return 'HOLD'
  }

  const capital = 100_000
  const result = runBacktest('test', 'fixed', klines, decide as never, { capital, warmup: 0 })

  // 买入核算：每股10元，一手100股
  const perLot = 10 * 100 * 1.00025 // 1000.25
  const shares = Math.floor(capital / perLot) * 100 // 9900
  const buyAmount = shares * 10 // 99000
  const buyFee = buyAmount * 0.00025 // 24.75
  const cashAfterBuy = capital - buyAmount - buyFee // 975.25

  // 卖出核算
  const proceeds = shares * 10 // 99000
  const sellFee = proceeds * 0.00075 // 74.25
  const netProceeds = proceeds - sellFee // 98925.75
  const finalEquity = cashAfterBuy + netProceeds // 99901.00
  const tradeProfit = netProceeds - (buyAmount + buyFee) // -99.00

  assert.equal(result.tradeCount, 1)
  assert.ok(closeTo(result.trades[0]?.entryPrice ?? NaN, 10))
  assert.ok(closeTo(result.trades[0]?.exitPrice ?? NaN, 10))
  assert.equal(result.trades[0]?.days, 10)
  assert.ok(closeTo(result.trades[0]?.returnPercent ?? NaN, (tradeProfit / (buyAmount + buyFee)) * 100))
  assert.ok(closeTo(result.finalEquity, finalEquity, 1e-6))
  assert.ok(closeTo(result.totalReturnPercent, (finalEquity / capital - 1) * 100))
  assert.ok(closeTo(result.winRate, 0)) // 唯一一笔亏损
  assert.ok(result.maxDrawdownPercent >= 0)
})

test('回测账目：本金买不起一手 → 0次交易，资金原封不动', () => {
  const decide = (): 'BUY' | 'SELL' | 'HOLD' => 'BUY'
  const result = runBacktest('test', 'fixed', klines, decide, { capital: 500, warmup: 0 })
  assert.equal(result.tradeCount, 0)
  assert.ok(closeTo(result.finalEquity, 500))
  assert.ok(closeTo(result.totalReturnPercent, 0))
})

test('回测账目：买入持有基准公式正确', () => {
  const kl = series(Array.from({ length: 30 }, (_, i) => 10 + i)) // 10 → 39
  const decide = (): 'BUY' | 'SELL' | 'HOLD' => 'HOLD'
  const result = runBacktest('test', 'fixed', kl, decide, { capital: 100_000, warmup: 0 })
  assert.ok(closeTo(result.buyHoldReturnPercent, (39 / 10 - 1) * 100))
  assert.equal(result.tradeCount, 0)
})

test('回测预热期适配：每个策略按 minBars 设置 warmup，250 根全策略回测不炸', () => {
  // 回归背景：warmup 固定 11 时，rsi/macd/donchian/bollinger/composite 在回放早期（history<minBars）抛"数据不足"炸掉整个回测
  const kl = series(Array.from({ length: 250 }, (_, i) => 10 + (i % 50) * 0.05))
  const providers: SignalProvider[] = [
    new MaCrossProvider(), new RsiProvider(), new MacdProvider(),
    new DonchianProvider(), new BollingerProvider(), new CompositeProvider(),
  ]
  for (const p of providers) {
    const r = runBacktest('test', p.name, kl, (h) => p.evaluate(h).kind, { capital: 100_000, warmup: p.minBars - 1 })
    assert.equal(r.strategy, p.name)
    assert.ok(r.barCount === 250)
  }
})

test('回测买入持有基准：统一从区间第一根起算（与 warmup 无关）', () => {
  // warmup 不同也不影响 buyHold，保证跨策略超额收益可比
  const kl = series([10, 11, 12, 13, 14, 15])
  const a = runBacktest('test', 'a', kl, () => 'HOLD', { capital: 100_000, warmup: 0 })
  const b = runBacktest('test', 'b', kl, () => 'HOLD', { capital: 100_000, warmup: 4 })
  assert.ok(closeTo(a.buyHoldReturnPercent, (15 / 10 - 1) * 100))
  assert.ok(closeTo(b.buyHoldReturnPercent, (15 / 10 - 1) * 100))
})

test('回测成交口径：上一根收盘出信号，下一根开盘成交', () => {
  const kl = [
    { date: '2026-01-01', open: 10, close: 11, high: 11, low: 10, volume: 1000, amount: 0 },
    { date: '2026-01-02', open: 20, close: 21, high: 21, low: 20, volume: 1000, amount: 0 },
    { date: '2026-01-03', open: 30, close: 31, high: 31, low: 30, volume: 1000, amount: 0 },
    { date: '2026-01-04', open: 40, close: 41, high: 41, low: 40, volume: 1000, amount: 0 },
  ]
  const decide = (history: typeof kl): 'BUY' | 'SELL' | 'HOLD' => {
    if (history.length === 1) return 'BUY'
    if (history.length === 3) return 'SELL'
    return 'HOLD'
  }
  const result = runBacktest('test', 'next-open', kl, decide, { capital: 100_000, warmup: 0 })
  assert.equal(result.tradeCount, 1)
  assert.equal(result.trades[0].entryDate, '2026-01-02')
  assert.equal(result.trades[0].entryPrice, 20)
  assert.equal(result.trades[0].exitDate, '2026-01-04')
  assert.equal(result.trades[0].exitPrice, 40)
})

test('回测成交口径：最后一根才出现的 BUY 不成交', () => {
  const kl = series([10, 11, 12, 13])
  const result = runBacktest(
    'test',
    'last-buy',
    kl,
    (history) => history.length === kl.length - 1 ? 'BUY' : 'HOLD',
    { capital: 100_000, warmup: 0 },
  )
  assert.equal(result.tradeCount, 0)
  assert.ok(closeTo(result.finalEquity, 100_000))
})
