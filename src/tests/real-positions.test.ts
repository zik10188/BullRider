// 实盘持仓估值测试（CLI real 命令与 Web GET /api/real 共享的 valuePositions：浮盈计算 + 赛马注入 + 异常兜底 + 合并去重）
import test from 'node:test'
import assert from 'node:assert/strict'
import { valuePositions, type ValueDeps } from '../real/positions'
import type { RealTrade } from '../real/journal'
import type { KLine } from '../market-data/types'
import type { Signal, SignalKind } from '../signal/types'
import { series, closeTo } from './helpers'

const kl120: KLine[] = series(Array.from({ length: 120 }, (_, i) => 20 + i * 0.05))

function sig(kind: SignalKind): Signal {
  return { kind, date: '2026-10-15', price: 25.46, strategy: 'composite', reason: '测试理由', indicators: {} }
}

function trade(over: Partial<RealTrade>): RealTrade {
  return { id: 't1', date: '2026-10-15', code: '000823', name: '超声电子', side: 'BUY', price: 25, shares: 100, ...over }
}

function deps(over: Partial<ValueDeps> = {}): ValueDeps {
  return {
    quote: async () => ({ name: '超声电子', price: 25.46 }),
    daily: async () => kl120,
    evaluate: () => sig('BUY'),
    ...over,
  }
}

test('估值：浮盈 = (现价 − 含费均价) × 股数，百分比按持仓占用成本', async () => {
  // 买入 100 股 @25 + 手续费 1 → 成本 2501，均价 25.01；现价 25.46
  const rows = await valuePositions(deps(), [trade({ price: 25, fee: 1 })])
  assert.equal(rows.length, 1)
  assert.ok(closeTo(rows[0].avgCost, 25.01))
  assert.ok(closeTo(rows[0].profit, (25.46 - 25.01) * 100))
  assert.ok(closeTo(rows[0].profitPercent, ((25.46 - 25.01) * 100 / 2501) * 100))
  assert.ok(closeTo(rows[0].marketValue, 2546))
})

test('赛马建议：evaluate 结果注入 signal（含理由）', async () => {
  const rows = await valuePositions(deps({ evaluate: () => sig('SELL') }), [trade({})])
  assert.equal(rows[0].signal?.kind, 'SELL')
  assert.equal(rows[0].signal?.reason, '测试理由')
})

test('日K不足：估值照常给出，signal 为空不炸', async () => {
  const rows = await valuePositions(deps({ daily: async () => { throw new Error('数据不足') } }), [trade({})])
  assert.ok(closeTo(rows[0].currentPrice, 25.46))
  assert.equal(rows[0].signal, undefined)
})

test('单只行情挂掉：该行 NaN 兜底，其余持仓不受影响', async () => {
  const rows = await valuePositions(deps({
    quote: async (code) => {
      if (code === '000823') throw new Error('fetch failed')
      return { name: '贵州茅台', price: 1500 }
    },
  }), [trade({ code: '000823' }), trade({ id: 't2', code: '600519', name: '贵州茅台', price: 1400 })])
  assert.equal(rows.length, 2)
  assert.ok(Number.isNaN(rows[0].currentPrice))
  assert.ok(Number.isNaN(rows[0].profit))
  assert.ok(closeTo(rows[1].currentPrice, 1500))
  assert.ok(closeTo(rows[1].profit, 100 * 100)) // (1500-1400)*100
})

test('同股多笔合并：3 笔买入只请求 1 次行情（按持仓去重，不按成交笔数）', async () => {
  let quoteCalls = 0
  const rows = await valuePositions(deps({
    quote: async () => { quoteCalls++; return { name: '超声电子', price: 25.46 } },
  }), [
    trade({ id: 'a', date: '2026-10-09', price: 25 }),
    trade({ id: 'b', date: '2026-10-10', price: 25.2 }),
    trade({ id: 'c', date: '2026-10-11', price: 25.4 }),
  ])
  assert.equal(rows.length, 1, '合并为一行持仓')
  assert.equal(rows[0].shares, 300)
  assert.equal(quoteCalls, 1, '每股只请求一次行情')
})
