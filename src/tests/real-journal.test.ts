// 实盘记录测试（用临时目录，不碰真实 .data）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { derivePositions, loadJournal, newId, saveJournal, type RealTrade } from '../real/journal'

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

test('save/load 往返 + 坏数据被过滤', async () => {
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
    await saveJournal(raw, dir)
    const loaded = await loadJournal(dir)
    assert.equal(loaded.length, 2, '非法记录应被过滤')
    assert.ok(loaded.every((x) => x.id !== 'bad'))
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
