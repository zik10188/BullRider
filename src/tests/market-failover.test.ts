// 数据源故障转移池测试（离线假 Provider）+ 腾讯数据解析测试（固定响应 fixture，不联网）
import test from 'node:test'
import assert from 'node:assert/strict'
import { ProviderPool } from '../market-data/pool'
import { parseDailyJson, parseQuoteBody, toTencentSymbol } from '../market-data/tencent'
import { toSecId, scaleBy } from '../market-data/eastmoney'
import type { MarketDataProvider } from '../market-data/provider'
import type { KLine, Quote } from '../market-data/types'

/** 假数据源：前 failTimes 次调用抛错，之后成功；calls 记录被调用次数 */
function fakeProvider(name: string, failTimes: number, calls: { n: number }): MarketDataProvider {
  const hit = (): never => { throw new Error(`boom from ${name}`) }
  return {
    name,
    async daily(): Promise<KLine[]> { calls.n++; if (calls.n <= failTimes) hit(); return [{ date: '2026-10-14', open: 1, close: 1, high: 1, low: 1, volume: 1, amount: 0 }] },
    async quote(): Promise<Quote> { calls.n++; if (calls.n <= failTimes) hit(); return { symbol: '000000', name, price: 1, open: 1, high: 1, low: 1, prevClose: 1, changePercent: 0 } },
  }
}

const kl: KLine = { date: '2026-10-14', open: 1, close: 1, high: 1, low: 1, volume: 1, amount: 0 }

test('failover：主源失败自动切备用，成功后计数清零', async () => {
  const mainCalls = { n: 0 }
  const backupCalls = { n: 0 }
  const pool = new ProviderPool([fakeProvider('main', 1, mainCalls), fakeProvider('backup', 0, backupCalls)], undefined, 5, 60_000)
  const r = await pool.run((p) => p.daily('600000'), '日K')
  assert.equal(r[0].date, '2026-10-14')
  assert.equal(mainCalls.n, 1)
  assert.equal(backupCalls.n, 1)
  // 主源恢复后下次直接走主源
  await pool.run((p) => p.daily('600000'), '日K')
  assert.equal(mainCalls.n, 2)
  assert.equal(backupCalls.n, 1)
})

test('熔断：连续失败达阈值后冷却期内不再触探主源，冷却结束自动恢复（半开）', async () => {
  const mainCalls = { n: 0 }
  const backupCalls = { n: 0 }
  // 主源连错 3 次后永远成功；冷却 10ms 便于测试恢复
  const pool = new ProviderPool([fakeProvider('main', 3, mainCalls), fakeProvider('backup', 0, backupCalls)], undefined, 3, 10)
  for (let i = 0; i < 3; i++) await pool.run((p) => p.daily('600000'), '日K')
  assert.equal(mainCalls.n, 3)
  assert.equal(backupCalls.n, 3)
  // 第 4 次：主源已熔断 → 不再被调用
  await pool.run((p) => p.daily('600000'), '日K')
  assert.equal(mainCalls.n, 3, '冷却期内主源不被触探')
  assert.equal(backupCalls.n, 4)
  // 冷却结束（半开）：主源恢复尝试并成功 → 解除熔断
  await new Promise((r) => setTimeout(r, 20))
  await pool.run((p) => p.daily('600000'), '日K')
  assert.equal(mainCalls.n, 4)
  assert.equal(backupCalls.n, 4, '主源成功后不切备用')
  // 熔断已解除：再失败一次也从 1 重新计数（这里主源恒成功，直接验证走主源）
  await pool.run((p) => p.daily('600000'), '日K')
  assert.equal(mainCalls.n, 5)
})

test('熔断：默认阈值为 3（不传参时连续失败 3 次即熔断，防风控期多撞墙）', async () => {
  const mainCalls = { n: 0 }
  const backupCalls = { n: 0 }
  const pool = new ProviderPool([fakeProvider('main', 99, mainCalls), fakeProvider('backup', 0, backupCalls)])
  for (let i = 0; i < 3; i++) await pool.run((p) => p.daily('600000'), '日K')
  assert.equal(mainCalls.n, 3)
  await pool.run((p) => p.daily('600000'), '日K')
  assert.equal(mainCalls.n, 3, '第 4 次起主源已被熔断不再触探')
  assert.equal(backupCalls.n, 4)
})

test('熔断：备用源也失败时，冷却期内仍绝不回撞熔断主源', async () => {
  const mainCalls = { n: 0 }
  const backupCalls = { n: 0 }
  let backupShouldFail = false
  const backup: MarketDataProvider = {
    name: 'backup',
    async daily() {
      backupCalls.n++
      if (backupShouldFail) throw new Error('boom from backup')
      return [kl]
    },
    async quote() {
      throw new Error('not used')
    },
  }
  const pool = new ProviderPool(
    [fakeProvider('main', 3, mainCalls), backup],
    undefined,
    3,
    60_000,
  )
  for (let i = 0; i < 3; i++) await pool.run((p) => p.daily('600000'), '日K')
  backupShouldFail = true
  await assert.rejects(() => pool.run((p) => p.daily('600000'), '日K'), /boom from backup/)
  assert.equal(mainCalls.n, 3, '主源进入冷却后，即使备用也失败也不能再次访问主源')
  assert.equal(backupCalls.n, 4)
})

test('熔断：所有数据源都挂 → 抛最后一次的错误', async () => {
  const pool = new ProviderPool([fakeProvider('main', 99, { n: 0 }), fakeProvider('backup', 99, { n: 0 })], undefined, 5, 60_000)
  await assert.rejects(() => pool.run((p) => p.quote('600000'), '行情'), /boom from backup/)
})

// ================= 腾讯数据解析（fixture 来自真实响应，不联网） =================

test('parseDailyJson：qfqday 数组 → KLine[]（amount 置 0，volume 为手）', () => {
  const text = JSON.stringify({
    code: 0, msg: '',
    data: { sz002181: { qfqday: [
      ['2026-10-09', '8.480', '9.390', '9.390', '8.200', '865920.000'],
      ['2026-10-12', '9.410', '10.010', '10.300', '9.200', '1610594.000'],
    ] } },
  })
  const rows = parseDailyJson(text, 'sz002181')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].date, '2026-10-09')
  assert.ok(Math.abs(rows[0].close - 9.39) < 1e-9)
  assert.ok(Math.abs(rows[1].high - 10.3) < 1e-9)
  assert.equal(rows[0].volume, 865920)
  assert.equal(rows[0].amount, 0, '腾讯日K不含成交额，置 0')
})

test('parseDailyJson：空数据抛错', () => {
  assert.throws(() => parseDailyJson('{"code":0,"data":{"sz002181":{}}}', 'sz002181'), /无数据/)
})

test('parseQuoteBody：~ 分隔字段 → Quote（名称/现价/涨跌幅/高低开收）', () => {
  // 索引：[1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [30]时间 [31]涨跌额 [32]涨跌幅% [33]最高 [34]最低
  // 用数组 join 精确对位，避免手写 0 序列数错
  const f = ['51', '粤传媒', '002181', '10.29', '9.77', '9.41', '136261', '110418', '136261', '10.28', '', '10.28', '', '10.28',
    ...Array(16).fill('0'), // [14]~[29]
    '20261014151451', // [30] 时间
    '0.52', '5.32', '10.30', '9.31', '10.29', '136261', '140099', '5.36']
  const body = `v_sz002181="${f.join('~')}";`
  const q = parseQuoteBody(body, 'sz002181')
  assert.equal(q.name, '粤传媒')
  assert.ok(Math.abs(q.price - 10.29) < 1e-9)
  assert.ok(Math.abs(q.prevClose - 9.77) < 1e-9)
  assert.ok(Math.abs(q.open - 9.41) < 1e-9)
  assert.ok(Math.abs(q.high - 10.3) < 1e-9)
  assert.ok(Math.abs(q.low - 9.31) < 1e-9)
  assert.ok(Math.abs(q.changePercent - 5.32) < 1e-9)
})

test('代码映射：股票与场内ETF 都能落到正确的市场段，其他代码拒绝', () => {
  // 东财 secid：沪市（6 股票、5 ETF）→ 1.x，深市（0/3 股票、15 ETF）→ 0.x
  assert.equal(toSecId('600519'), '1.600519')
  assert.equal(toSecId('510300'), '1.510300')
  assert.equal(toSecId('588000'), '1.588000')
  assert.equal(toSecId('000001'), '0.000001')
  assert.equal(toSecId('300750'), '0.300750')
  assert.equal(toSecId('159915'), '0.159915')
  assert.throws(() => toSecId('830001'), /暂不支持/)
  // 腾讯：sh/sz 前缀同理
  assert.equal(toTencentSymbol('600519'), 'sh600519')
  assert.equal(toTencentSymbol('510300'), 'sh510300')
  assert.equal(toTencentSymbol('000001'), 'sz000001')
  assert.equal(toTencentSymbol('159915'), 'sz159915')
  assert.throws(() => toTencentSymbol('830001'), /暂不支持/)
})

test('scaleBy：按接口精度位数缩放价格字段（股票 2 位、场内基金 3 位）', () => {
  // 东财实测：510300 返回 f43=4207、f59=3 → 4.207 元；股票 f59=2 → ÷100
  assert.ok(Math.abs(scaleBy(4207, 3) - 4.207) < 1e-9)
  assert.ok(Math.abs(scaleBy(405, 2) - 4.05) < 1e-9)
  assert.ok(Math.abs(scaleBy(-203, undefined) - -2.03) < 1e-9, '缺省按 2 位（涨跌幅恒 ÷100 的场景可直接复用）')
  assert.equal(scaleBy(undefined, 3), 0, '缺字段 → 0')
})
