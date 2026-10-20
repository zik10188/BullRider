// 模拟账户账目测试（纯函数，不碰磁盘/网络）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccount, buy, sell, deposit } from '../paper/account'
import { closeTo } from './helpers'

test('买入：费用、均价、现金核对（10元×100股=一手1000.25元）', () => {
  const acc = createAccount(100_000)
  const res = buy(acc, '600519', '贵州茅台', 10)

  assert.equal(res.shares, 9900) // floor(100000/1000.25)*100
  assert.ok(closeTo(res.amount, 99_000))
  assert.ok(closeTo(res.fee, 24.75))
  assert.ok(closeTo(acc.cash, 100_000 - 99_000 - 24.75))
  assert.ok(closeTo(acc.positions[0]?.avgCost ?? NaN, (99_000 + 24.75) / 9900))
  assert.equal(acc.trades.length, 1)
})

test('买入后资产曲线新增快照', () => {
  const acc = createAccount(100_000)
  buy(acc, '600519', '贵州茅台', 10)
  assert.equal(acc.equityHistory?.length, 1)
  // 快照 = 现金 + 持仓按成交价估值 = 975.25 + 9900*10 = 99875.25
  assert.ok(closeTo(acc.equityHistory?.[0]?.equity ?? NaN, 100_000 - 99_024.75 + 99_000))
})

test('卖出：已实现盈亏 = 卖出净额 - 成本', () => {
  const acc = createAccount(100_000)
  buy(acc, '600519', '贵州茅台', 10)
  const res = sell(acc, '600519', '贵州茅台', 11)

  const proceeds = 9900 * 11 // 108900
  const fee = proceeds * 0.00075 // 81.675
  const cost = 99_024.75
  assert.ok(closeTo(res.profit ?? NaN, proceeds - fee - cost))
  assert.ok(closeTo(acc.cash, 975.25 + proceeds - fee))
  assert.equal(acc.positions.length, 0) // 清仓
  assert.equal(acc.trades.length, 2)
  assert.equal(acc.equityHistory?.length, 2)
})

test('加仓：均价按总成本重新计算（买入是全仓，需价格回落后才有现金加仓）', () => {
  const acc = createAccount(100_000)
  buy(acc, '600519', '贵州茅台', 100) // 900股，花90022.5，剩9977.5
  buy(acc, '600519', '贵州茅台', 50) // 回落后再买100股（一手5001.25）

  const pos = acc.positions[0]
  assert.equal(pos?.shares, 1000)
  // 总成本 = 90022.5 + 5001.25 = 95023.75 → 均价 95.02375
  assert.ok(closeTo(pos?.avgCost ?? NaN, 95_023.75 / 1000))
})

test('现金不足买一手 → 报错', () => {
  const acc = createAccount(1000)
  assert.throws(() => buy(acc, '600519', '贵州茅台', 10), /现金不足/)
})

test('未持仓卖出 → 报错', () => {
  const acc = createAccount(100_000)
  assert.throws(() => sell(acc, '600519', '贵州茅台', 10), /没有持有/)
})

test('部分卖出：剩余持仓保留', () => {
  const acc = createAccount(100_000)
  buy(acc, '600519', '贵州茅台', 10) // 9900股
  const res = sell(acc, '600519', '贵州茅台', 10, {}, 1000)
  assert.equal(res.shares, 1000)
  assert.equal(acc.positions[0]?.shares, 8900)
})

test('卖出参数非法：负数、零、小数和超持仓都必须拒绝且不修改账户', () => {
  const acc = createAccount(100_000)
  buy(acc, '600519', '贵州茅台', 10)
  const before = JSON.stringify(acc)
  for (const shares of [-100, 0, 1.5, 10_000]) {
    assert.throws(() => sell(acc, '600519', '贵州茅台', 10, {}, shares))
    assert.equal(JSON.stringify(acc), before, `卖出 ${shares} 股后账户不应变化`)
  }
})

test('卖出价格无效：拒绝且不修改账户', () => {
  const acc = createAccount(100_000)
  buy(acc, '600519', '贵州茅台', 10)
  const before = JSON.stringify(acc)
  assert.throws(() => sell(acc, '600519', '贵州茅台', -1), /卖出价格无效/)
  assert.equal(JSON.stringify(acc), before)
})

test('指定金额买入：预算 5000 元 → 只买 4 手，现金大量保留', () => {
  const acc = createAccount(100_000)
  const res = buy(acc, '600519', '贵州茅台', 10, {}, 5000)
  // 一手成本 1000.25 → floor(5000/1000.25)=4 手 = 400 股
  assert.equal(res.shares, 400)
  assert.ok(closeTo(res.amount, 4000))
  assert.ok(closeTo(res.fee, 1))
  // 现金 = 100000 - 4001 = 95999
  assert.ok(closeTo(acc.cash, 95_999))
  // 现金还很多，能继续买别的
  const res2 = buy(acc, '601318', '中国平安', 50, {}, 10_000)
  assert.equal(res2.shares, 100) // 一手 5001.25 → 只买得起 1 手
  assert.equal(acc.positions.length, 2)
})

test('指定金额买入：预算不够一手 → 报错，账户不变', () => {
  const acc = createAccount(100_000)
  assert.throws(() => buy(acc, '600519', '贵州茅台', 10, {}, 500), /预算/)
  assert.equal(acc.cash, 100_000)
  assert.equal(acc.trades.length, 0)
})

test('充值：现金与初始资金基准同步增加，流水记 DEPOSIT', () => {
  const acc = createAccount(100_000)
  buy(acc, '600519', '贵州茅台', 10) // 全仓 → 现金 975.25
  deposit(acc, 50_000)
  assert.ok(closeTo(acc.cash, 975.25 + 50_000))
  assert.ok(closeTo(acc.capital, 150_000)) // 基准同步抬高，盈亏统计不失真
  const t = acc.trades[acc.trades.length - 1]
  assert.equal(t.action, 'DEPOSIT')
  assert.ok(closeTo(t.amount, 50_000))
  assert.equal(acc.equityHistory?.length, 2) // 买入 + 充值各一个快照
})

test('充值：金额无效 → 报错', () => {
  const acc = createAccount(100_000)
  assert.throws(() => deposit(acc, 0), /充值金额无效/)
  assert.throws(() => deposit(acc, -100), /充值金额无效/)
})
