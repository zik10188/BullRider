// 信号质量追踪测试（回合制两层记账 + 结算规则 + 补历史，全部离线假依赖）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TIMEOUT_BARS,
  ingestSignals,
  deriveRounds,
  derivePending,
  layerStats,
  settleCheck,
  replayStock,
  loadTrack,
  saveTrack,
  deleteStock,
  type TrackStore,
  type TrackDeps,
  type TrackEvent,
} from '../track/tracker'
import { series, closeTo } from './helpers'
import type { KLine } from '../market-data/types'

function store(): TrackStore {
  return { signals: [], replayed: {} }
}

function events(list: Array<[string, number, 'BUY' | 'SELL']>): TrackEvent[] {
  return list.map(([date, price, kind]) => ({ date, price, kind }))
}

/** 收盘价缓慢上行的 120 根日K：close[i] = 10 + i*0.1 */
const kl120 = series(Array.from({ length: 120 }, (_, i) => 10 + i * 0.1))

test('ingest：连续 3 次 BUY + 1 次 SELL → 信号层 3 条全结算，回合层 1 条（入场取最早）', () => {
  const s = store()
  const added = ingestSignals(s, '601118', '海南橡胶', events([
    ['2026-01-05', 10, 'BUY'],
    ['2026-01-06', 11, 'BUY'],
    ['2026-01-07', 12, 'BUY'],
    ['2026-01-09', 13.2, 'SELL'],
  ]), 'replay')
  assert.equal(added, 3)
  assert.equal(s.signals.length, 3)
  assert.ok(s.signals.every((x) => x.exit && x.settleId))
  // 信号层：各条以各自入场价结算（追高惩罚可见）
  assert.ok(closeTo(s.signals[0].exit!.returnPercent, 32))
  assert.ok(closeTo(s.signals[1].exit!.returnPercent, 20))
  assert.ok(closeTo(s.signals[2].exit!.returnPercent, 10))
  // 回合层：合并为 1 条，入场价 = 最早一条
  const rounds = deriveRounds(s)
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].entryPrice, 10)
  assert.ok(closeTo(rounds[0].returnPercent, 32))
  assert.equal(rounds[0].buyCount, 3)
})

test('ingest：两段独立回合 + 空仓 SELL 丢弃 + 同日 BUY 去重', () => {
  const s = store()
  ingestSignals(s, '600000', undefined, events([
    ['2026-01-05', 10, 'BUY'],
    ['2026-01-06', 11, 'SELL'],
    ['2026-01-07', 9, 'BUY'],
    ['2026-01-08', 10.8, 'SELL'],
  ]), 'replay')
  assert.equal(deriveRounds(s).length, 2)
  // 空仓 SELL（没得结算）与重复 BUY（同日）都不入账
  const s2 = store()
  const added = ingestSignals(s2, '600000', undefined, events([
    ['2026-01-05', 10, 'SELL'], // 空仓 → 丢弃
    ['2026-01-06', 10, 'BUY'],
    ['2026-01-06', 10.5, 'BUY'], // 同日重复喊买 → 只记一条
  ]), 'replay')
  assert.equal(added, 1)
  assert.equal(s2.signals.length, 1)
  assert.equal(derivePending(s2).length, 1, '唯一 BUY 保持待处理')
})

test('layerStats：胜率/平均盈亏/盈亏比/最大连亏 手工核对', () => {
  const rows = [
    { returnPercent: 10, exitDate: '2026-01-01' },
    { returnPercent: -5, exitDate: '2026-01-02' },
    { returnPercent: -3, exitDate: '2026-01-03' },
    { returnPercent: 8, exitDate: '2026-01-04' },
    { returnPercent: -2, exitDate: '2026-01-05' },
    { returnPercent: 6, exitDate: '2026-01-06' },
  ]
  const st = layerStats(rows, 2)
  assert.equal(st.settled, 6)
  assert.equal(st.pending, 2)
  assert.ok(closeTo(st.winRate, 50))
  assert.ok(closeTo(st.avgReturn, 14 / 6))
  assert.ok(closeTo(st.avgWin, 8))
  assert.ok(closeTo(st.avgLoss, -10 / 3))
  assert.ok(closeTo(st.profitFactor, 8 / (10 / 3)))
  assert.equal(st.maxConsecutiveLosses, 2) // -5、-3 连续两亏
})

/** 假依赖：固定K线 + 按当前窗口末位索引出票的脚本策略 */
function depsOf(klines: KLine[], script: (i: number) => 'BUY' | 'SELL' | 'HOLD'): TrackDeps {
  return {
    daily: async () => klines,
    evaluate: (window) => script(window.length - 1),
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bullrider-track-test-'))
}

test('settleCheck：回放发现错过的 SELL → 按当日收盘结算，days 用日期差', async () => {
  const dir = await tempDir()
  try {
    const s = store()
    s.signals.push({ code: '600000', date: '2026-01-05', price: 10, source: 'replay' }) // 在途，idx=4
    await saveTrack(s, dir) // settleCheck 内部自己 loadTrack，先落盘
    const deps = depsOf(kl120, (i) => (i === 14 ? 'SELL' : 'HOLD')) // 入场后第10根喊卖（当时漏记）
    const r = await settleCheck(deps, dir)
    assert.equal(r.checked, 1)
    assert.equal(r.settled, 1)
    const loaded = await loadTrack(dir)
    const [entry] = loaded.signals
    assert.equal(entry.exit?.reason, 'SELL')
    assert.ok(closeTo(entry.exit.price, 10 + 14 * 0.1))
    assert.equal(entry.exit.days, 10)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settleCheck：旧回合先 SELL 又出现新 BUY 时，只结算旧回合，不把新 BUY 超时', async () => {
  const dir = await tempDir()
  try {
    const s = store()
    s.signals.push({ code: '600000', date: kl120[4].date, price: 10, source: 'replay' })
    await saveTrack(s, dir)
    const deps = depsOf(kl120, (i) => {
      if (i === 14) return 'SELL'
      if (i === 100 || i === 110) return 'BUY'
      return 'HOLD'
    })
    const r = await settleCheck(deps, dir)
    assert.equal(r.settled, 1)
    const loaded = await loadTrack(dir)
    assert.equal(loaded.signals.length, 3)
    assert.equal(loaded.signals[0].exit?.reason, 'SELL')
    assert.equal(loaded.signals[1].exit, undefined, '新 BUY 在途跨度只有 19 根，不应超时')
    assert.equal(loaded.signals[2].exit, undefined, '新 BUY 在途跨度只有 9 根，不应超时')
    assert.equal(derivePending(loaded)[0].entries.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test(`settleCheck：一直不喊 SELL 且跨度超过 ${TIMEOUT_BARS} 根 → 按最新收盘强制结算（超时）`, async () => {
  const dir = await tempDir()
  try {
    const s = store()
    s.signals.push({ code: '600000', date: '2026-01-05', price: 10, source: 'replay' })
    await saveTrack(s, dir)
    const deps = depsOf(kl120, () => 'HOLD')
    const r = await settleCheck(deps, dir)
    assert.equal(r.settled, 1)
    const [entry] = (await loadTrack(dir)).signals
    assert.equal(entry.exit?.reason, 'TIMEOUT')
    assert.ok(closeTo(entry.exit.price, 10 + 119 * 0.1))
    assert.equal(entry.exit.days, 115)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settleCheck：在途跨度未超时 → 保持待处理不动', async () => {
  const dir = await tempDir()
  try {
    const s = store()
    const late = kl120[100].date // idx=100，跨度 19 根
    s.signals.push({ code: '600000', date: late, price: 10, source: 'scan' })
    await saveTrack(s, dir)
    const r = await settleCheck(depsOf(kl120, () => 'HOLD'), dir)
    assert.equal(r.settled, 0)
    const [entry] = (await loadTrack(dir)).signals
    assert.equal(entry.exit, undefined, '未超时不结算')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('replayStock：滑窗补历史入账并结算；同日K重跑幂等；次新股跳过', async () => {
  const dir = await tempDir()
  try {
    const deps = depsOf(series(Array.from({ length: 100 }, (_, i) => 10 + i * 0.1)), (i) => (i === 70 ? 'BUY' : i === 90 ? 'SELL' : 'HOLD'))
    const added = await replayStock('600000', '测试股', deps, dir)
    assert.equal(added, 1)
    const loaded = await loadTrack(dir)
    assert.equal(loaded.signals.length, 1)
    assert.equal(deriveRounds(loaded).length, 1)
    // 重跑：replayed 记录命中 → 不重复入账
    const again = await replayStock('600000', '测试股', deps, dir)
    assert.equal(again, 0)
    assert.equal((await loadTrack(dir)).signals.length, 1)
    // 次新股：日K不足 60 根直接跳过
    const depsNew = depsOf(series(Array.from({ length: 30 }, () => 10)), () => 'BUY')
    assert.equal(await replayStock('301111', '次新', depsNew, dir), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('replayStock：行情接口故障 → 返回 0 不入账、不写 replayed 标记（下次扫描自动重试）', async () => {
  const dir = await tempDir()
  try {
    const broken: TrackDeps = { daily: async () => { throw new Error('HTTP 503') }, evaluate: () => 'HOLD' }
    assert.equal(await replayStock('600000', '测试股', broken, dir), 0)
    const loaded = await loadTrack(dir)
    assert.equal(loaded.signals.length, 0)
    assert.equal(loaded.replayed?.['600000'], undefined, '失败不写标记，下次重试')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteStock：删指定股全部记录并清 replayed 标记，其他股不受影响；不存在的股返回 0', async () => {
  const dir = await tempDir()
  try {
    const s = store()
    s.signals.push(
      { code: '600000', date: '2026-01-05', price: 10, source: 'replay' },
      { code: '600000', date: '2026-01-06', price: 11, source: 'replay' },
      { code: '000001', date: '2026-01-07', price: 12, source: 'replay' },
    )
    s.replayed = { '600000': '2026-01-07', '000001': '2026-01-07' }
    await saveTrack(s, dir)
    assert.equal(await deleteStock('600000', dir), 2)
    const loaded = await loadTrack(dir)
    assert.equal(loaded.signals.length, 1)
    assert.equal(loaded.signals[0].code, '000001')
    assert.equal(loaded.replayed?.['600000'], undefined, '补历史标记一并清除（下次触发 BUY 会重新补）')
    assert.equal(loaded.replayed?.['000001'], '2026-01-07')
    assert.equal(await deleteStock('600000', dir), 0, '再删已不存在的股 → 0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
