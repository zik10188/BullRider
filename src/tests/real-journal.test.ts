// 实盘记录测试（用临时目录，不碰真实 .data）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_REAL_FEE, derivePositions, deriveRealPnl, estimateRealFee, loadJournal, newId, normalizeRealFeeConfig, saveJournal, type RealTrade } from '../real/journal'
import { loadPrefs, savePrefs } from '../prefs/store'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bullrider-real-test-'))
}

function t(partial: Partial<RealTrade> & Pick<RealTrade, 'code' | 'side' | 'price' | 'shares'>): RealTrade {
  return { id: newId(), date: '2026-01-05', ...partial }
}

test('loadJournal：文件不存在 → 空数组', async () => {
  const dir = await tempDir()
  try {
    assert.deepEqual(await loadJournal(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('save/load 往返 + 坏股数/负费用被过滤', async () => {
  const dir = await tempDir()
  try {
    const trades: RealTrade[] = [
      t({ code: '601398', side: 'BUY', price: 5.5, shares: 700, fee: 5, name: '工商银行' }),
      t({ code: '600050', side: 'BUY', price: 4.6, shares: 1100 }),
    ]
    await saveJournal(trades, dir)
    assert.equal((await loadJournal(dir)).length, 2)

    // 混入一条非法记录（股数为小数）→ saveJournal 原样落盘，loadJournal 时被丢弃
    const raw = JSON.parse(await readFile(resolve(dir, 'real-journal.json'), 'utf-8')) as RealTrade[]
    raw.push({ id: 'bad', date: '2026-01-06', code: '600519', side: 'BUY', price: 1, shares: 10.5 })
    raw.push({ id: 'bad-fee', date: '2026-01-06', code: '600519', side: 'BUY', price: 1, shares: 100, fee: -1 })
    await saveJournal(raw, dir)
    const loaded = await loadJournal(dir)
    assert.equal(loaded.length, 2, '非法记录应被过滤')
    assert.ok(loaded.every((x) => x.id !== 'bad' && x.id !== 'bad-fee'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('derivePositions：移动加权成本（买入含费、卖出按均价出账）', () => {
  const trades: RealTrade[] = [
    t({ code: '601398', side: 'BUY', price: 5, shares: 1000, fee: 10, date: '2026-01-05' }),  // 成本 5010 → 均价 5.01
    t({ code: '601398', side: 'BUY', price: 6, shares: 1000, fee: 20, date: '2026-01-06' }),  // 成本 6020 → 累计 11030
    t({ code: '601398', side: 'SELL', price: 6.5, shares: 800, date: '2026-01-07' }),         // 出账 800 × 5.515 = 4412
  ]
  const [p] = derivePositions(trades)
  assert.equal(p.code, '601398')
  assert.equal(p.shares, 1200)
  // (5010 + 6020 - 800×5.515) / 1200
  const expectedCost = 5010 + 6020 - 800 * ((5010 + 6020) / 2000)
  assert.ok(Math.abs(p.positionCost - expectedCost) < 1e-6, `持仓成本 ${p.positionCost} ≈ ${expectedCost}`)
  assert.ok(Math.abs(p.avgCost - expectedCost / 1200) < 1e-6)
  assert.ok(Math.abs(p.totalSellAmount - 6.5 * 800) < 1e-6)
})

test('derivePositions：清仓后不再出现在持仓里，乱序输入按日期排序', () => {
  const buy = t({ code: '600050', side: 'BUY', price: 4.6, shares: 1100, date: '2026-01-05' })
  const sell = t({ code: '600050', side: 'SELL', price: 4.8, shares: 1100, date: '2026-01-08' })
  const other = t({ code: '601398', side: 'BUY', price: 5.5, shares: 700, date: '2026-01-06' })
  // 故意乱序：卖在前、买在后
  const positions = derivePositions([sell, other, buy])
  assert.equal(positions.length, 1, '清仓的 600050 不应出现')
  assert.equal(positions[0].code, '601398')
  assert.equal(positions[0].shares, 700)
  assert.ok(Math.abs(positions[0].avgCost - 5.5) < 1e-9)
})

test('derivePositions：同一日多笔按 id 稳定排序、空输入', () => {
  assert.deepEqual(derivePositions([]), [])
  const a = t({ code: '600050', side: 'BUY', price: 4.6, shares: 500 })
  const b = t({ code: '600050', side: 'BUY', price: 4.7, shares: 600 })
  const positions = derivePositions([a, b])
  assert.equal(positions[0].shares, 1100)
})

test('estimateRealFee：买入佣金触发最低收费并计过户费', () => {
  const fee = estimateRealFee({ code: '600000', side: 'BUY', price: 5, shares: 100 }, DEFAULT_REAL_FEE)
  assert.equal(fee, 5) // 500 元买入：最低佣金 5 元，过户费 0.005 元，合计按分舍入为 5.00
})

test('estimateRealFee：卖出含印花税；免五时按佣金费率算', () => {
  const sell = estimateRealFee({ code: '600000', side: 'SELL', price: 10, shares: 1000 }, { commissionRatePercent: 0.025, minCommission: 0 })
  assert.equal(sell, 7.6) // 2.5 佣金 + 5 印花税 + 0.1 元过户费
  const buy = estimateRealFee({ code: '600000', side: 'BUY', price: 10, shares: 1000 }, { commissionRatePercent: 0.025, minCommission: 0 })
  assert.equal(buy, 2.6) // 2.5 佣金 + 0.1 元过户费
})

test('estimateRealFee：ETF 不收股票印花税和过户费', () => {
  const fee = estimateRealFee({ code: '510300', side: 'SELL', price: 4.2, shares: 1000 }, { commissionRatePercent: 0.025, minCommission: 0 })
  assert.equal(fee, 1.05)
})

test('deriveRealPnl：已实现、总盈亏和缺费计数', () => {
  const trades: RealTrade[] = [
    t({ code: '600000', side: 'BUY', price: 10, shares: 1000, fee: 2.6, date: '2026-01-05' }),
    t({ code: '600000', side: 'SELL', price: 11, shares: 400, fee: 4.42, date: '2026-01-06' }),
    t({ code: '600001', side: 'BUY', price: 20, shares: 100, date: '2026-01-07' }),
  ]
  const pnl = deriveRealPnl(trades, 120)
  // 卖出净回款 4395.58 - 出账成本 4001.04
  assert.ok(Math.abs(pnl.realized - (11 * 400 - 4.42 - 10.0026 * 400)) < 1e-6)
  assert.equal(pnl.unrealized, 120)
  assert.ok(Math.abs(pnl.total - (pnl.realized + 120)) < 1e-9)
  assert.equal(pnl.missingFeeCount, 1, '第三笔缺费用要被计数')
})

test('deriveRealPnl：未卖出时实现盈亏为零，总盈亏等于浮盈亏', () => {
  const pnl = deriveRealPnl([t({ code: '600000', side: 'BUY', price: 10, shares: 1000, fee: 2.6 })], 150)
  assert.equal(pnl.realized, 0)
  assert.equal(pnl.total, 150)
})

test('费率配置：非法值回退默认，免五的 0 值保留，并随偏好持久化', async () => {
  assert.deepEqual(normalizeRealFeeConfig({ commissionRatePercent: -1, minCommission: 2000 }), DEFAULT_REAL_FEE)
  assert.deepEqual(normalizeRealFeeConfig({ commissionRatePercent: 0, minCommission: 0 }), { commissionRatePercent: 0, minCommission: 0 })
  const dir = await tempDir()
  try {
    const realFee = { commissionRatePercent: 0.015, minCommission: 0 }
    await savePrefs({ realFee }, dir)
    assert.deepEqual((await loadPrefs(dir)).realFee, realFee)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
