// 选股推荐测试：快照硬过滤纯函数（不碰网络）+ ETF 白名单加载
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fetchSnapshotPage, filterSnapshot, isListedLongEnough, type SnapshotRow } from '../screener/screener'
import { DEFAULT_ETF_LIST, loadEtfList } from '../screener/etf-list'

const OPTS = { minPrice: 3, maxPrice: 20, maxCandidates: 100, minAmount: 20_000_000 }
const TODAY = new Date('2026-10-12T10:00:00+08:00')

function row(partial: Partial<SnapshotRow>): SnapshotRow {
  return { code: '600000', name: '某某股份', price: 10, changePercent: 1, amount: 50_000_000, listDate: '20150101', ...partial }
}

test('硬过滤：价格区间内外', () => {
  const out = filterSnapshot(
    [row({ code: '600001', price: 10 }), row({ code: '600002', price: 2 }), row({ code: '600003', price: 25 })],
    OPTS,
    TODAY,
  )
  assert.deepEqual(out.map((r) => r.code), ['600001'])
})

test('硬过滤：ST/退市风险名称被排除（大小写不敏感）', () => {
  const out = filterSnapshot(
    [row({ code: '600001', name: 'ST某股' }), row({ code: '600002', name: '*ST某股' }), row({ code: '600003', name: 'st weird' }), row({ code: '600004', name: '某某退' }), row({ code: '600005', name: '正常股份' })],
    OPTS,
    TODAY,
  )
  assert.deepEqual(out.map((r) => r.code), ['600005'])
})

test('硬过滤：涨停/跌停被排除（主板 ±10%，|涨跌|≥9.8 判停）', () => {
  const out = filterSnapshot(
    [row({ code: '600001', changePercent: 10.02 }), row({ code: '600002', changePercent: -9.95 }), row({ code: '600003', changePercent: 9.5 })],
    OPTS,
    TODAY,
  )
  assert.deepEqual(out.map((r) => r.code), ['600003'])
})

test('硬过滤：成交额不足 / 停牌无效价', () => {
  const out = filterSnapshot(
    [row({ code: '600001', amount: 19_999_999 }), row({ code: '600002', amount: 20_000_000 }), row({ code: '600003', price: 0 })],
    OPTS,
    TODAY,
  )
  assert.deepEqual(out.map((r) => r.code), ['600002'])
})

test('次新股过滤：上市不满 90 自然日被排除，无日期不误杀', () => {
  const recent = '2026-09-20'.replaceAll('-', '') // 距 TODAY 约 22 天
  const out = filterSnapshot(
    [row({ code: '600001', listDate: recent }), row({ code: '600002', listDate: '' }), row({ code: '600003', listDate: '20260101' })],
    OPTS,
    TODAY,
  )
  assert.deepEqual(out.map((r) => r.code), ['600002', '600003'])
})

test('isListedLongEnough：边界值与坏数据', () => {
  assert.equal(isListedLongEnough('20260701', 90, TODAY), true)  // 约 103 天前
  assert.equal(isListedLongEnough('20260801', 90, TODAY), false) // 约 72 天前
  assert.equal(isListedLongEnough('20261001', 90, TODAY), false) // 约 11 天前
  assert.equal(isListedLongEnough('19910403', 90, TODAY), true)
  assert.equal(isListedLongEnough('', 90, TODAY), true)
  assert.equal(isListedLongEnough('bad-date', 90, TODAY), true)
})

test('loadEtfList：无文件用内置默认，覆盖文件优先生效，坏格式回退默认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bullrider-etf-'))
  try {
    const d1 = await loadEtfList(dir)
    assert.ok(d1.length >= 25, '内置默认清单应存在')
    assert.ok(DEFAULT_ETF_LIST.every((e) => /^\d{6}$/.test(e.code) && e.name.length > 0))
    await writeFile(resolve(dir, 'etf-list.json'), JSON.stringify([{ code: '510300', name: '沪深300ETF' }]), 'utf-8')
    const d2 = await loadEtfList(dir)
    assert.deepEqual(d2, [{ code: '510300', name: '沪深300ETF' }], '覆盖文件优先生效')
    await writeFile(resolve(dir, 'etf-list.json'), '{bad json', 'utf-8')
    assert.equal((await loadEtfList(dir)).length, d1.length, '坏格式回退默认')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const pageResp = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } })

test('fetchSnapshotPage：偶发 502 自动重试后成功', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return calls === 1 ? pageResp('bad gateway', 502) : pageResp(JSON.stringify([{ code: '600000' }]))
  })
  const out = await fetchSnapshotPage('https://example.com/page', 2, 1)
  assert.equal(calls, 2, '第一次 502 + 重试 1 次')
  assert.deepEqual(out, [{ code: '600000' }])
})

test('fetchSnapshotPage：重试耗尽仍失败，抛最后一次错误', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return pageResp('oops', 502)
  })
  await assert.rejects(fetchSnapshotPage('https://example.com/page', 2, 1), /HTTP 502/)
  assert.equal(calls, 3, '1 次原始 + 2 次重试')
})

test('fetchSnapshotPage：网络异常（fetch 抛错）同样走重试', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 1) throw new Error('fetch failed')
    return pageResp('[]')
  })
  const out = await fetchSnapshotPage('https://example.com/page', 2, 1)
  assert.equal(calls, 2)
  assert.deepEqual(out, [])
})
