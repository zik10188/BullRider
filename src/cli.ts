// BullRider 命令行入口（阶段1-5 第1层：数据 / 信号 / 回测 / 模拟盘+风控）
// 用法:
//   fetch    <股票代码> [--days N]              拉取日K + 基础分析
//   signal   <股票代码> [--days N]              计算买卖信号
//   backtest <股票代码> [--days N] [--capital C] 历史回测(对比买入持有)
//   paper    init|status|buy|sell|deposit|apply ...  模拟盘（下单自动过风控，buy 可 --amount 指定金额）
import { Context } from '@deepseek-ai/cordis'
import ConsoleLogger from '@deepseek-ai/cordis-plugin-logger-console'
import MarketData from './market-data/service'
import { EastmoneyProvider } from './market-data/eastmoney'
import { TencentProvider } from './market-data/tencent'
import SignalService from './signal/service'
import { MaCrossProvider } from './signal/ma-cross'
import { RsiProvider } from './signal/rsi'
import { MacdProvider } from './signal/macd'
import { DonchianProvider } from './signal/donchian'
import { BollingerProvider } from './signal/bollinger'
import { CompositeProvider } from './signal/composite'
import { runBacktest } from './backtest/engine'
import { createAccount } from './paper/account'
import { loadAccount, saveAccount, accountFilePath } from './paper/store'
import * as paperOps from './paper/ops'
import type { PaperAccount } from './paper/types'
import BrokerService from './broker/service'
import { PaperBrokerProvider } from './broker/paper'
import RiskService from './risk/service'
import type { RiskConfig } from './risk/types'
import { loadJournal } from './real/journal'
import { valuePositions } from './real/positions'
import type { KLine } from './market-data/types'

/** 简易均线（取最近 n 根收盘价平均） */
function ma(closes: number[], n: number): number {
  const window = closes.slice(-n)
  return window.reduce((a, b) => a + b, 0) / window.length
}

function usage() {
  console.log('用法:')
  console.log('  fetch    <股票代码> [--days N]              拉取日K + 基础分析')
  console.log('  signal   <股票代码> [--days N]              计算买卖信号')
  console.log('  backtest <股票代码> [--days N] [--capital C] 历史回测(对比买入持有)')
  console.log('  paper    init|status|buy|sell|deposit|apply ...  模拟盘(下单自动过风控)')
  console.log('  real     查看实盘记录(持仓估值 + 赛马建议 + 成交明细)')
  console.log('示例:')
  console.log('  fetch  600519 --days 30')
  console.log('  signal 300750 --days 60')
  console.log('  backtest 600519 --capital 200000')
  console.log('  paper init --capital 100000')
  console.log('  paper buy 600519 --amount 20000   # 只买 2 万元，不再全仓')
  console.log('  paper deposit 50000               # 追加 5 万元模拟资金')
}

/** 命令1：拉数据 + 基础分析 + 落盘 */
async function fetchAndShow(ctx: Context, symbol: string, days: number) {
  const marketData = ctx.marketData

  const quote = await marketData.quote(symbol)
  const klines: KLine[] = await marketData.daily(symbol, { days })
  if (klines.length === 0) {
    console.log(`没有取到 ${symbol} 的数据`)
    return
  }

  const closes = klines.map((k) => k.close)
  const ma5 = ma(closes, 5)
  const ma10 = ma(closes, 10)
  const high = Math.max(...klines.map((k) => k.high))
  const low = Math.min(...klines.map((k) => k.low))
  const last = klines[klines.length - 1]

  console.log('')
  console.log(`== ${quote.name} (${symbol}) ==`)
  console.log(`实时价: ${quote.price.toFixed(2)}  涨跌幅: ${quote.changePercent.toFixed(2)}%  今开: ${quote.open.toFixed(2)}`)
  console.log(`近 ${klines.length} 根日K: 最高 ${high.toFixed(2)} / 最低 ${low.toFixed(2)}`)
  console.log(`MA5: ${ma5.toFixed(2)}   MA10: ${ma10.toFixed(2)}   最新收盘: ${last.close.toFixed(2)}`)
  console.log('')
  console.log('  日期        开盘      收盘      最高      最低      成交量(手)')
  for (const k of klines.slice(-10)) {
    console.log(
      `  ${k.date}  ${k.open.toFixed(2).padStart(8)} ${k.close.toFixed(2).padStart(8)}`
      + ` ${k.high.toFixed(2).padStart(8)} ${k.low.toFixed(2).padStart(8)} ${String(k.volume).padStart(12)}`,
    )
  }

  const trend = last.close > ma5 && ma5 > ma10
    ? '短期偏强（站上MA5，且MA5>MA10）'
    : '短期偏弱/震荡'
  console.log(`\n简评: ${trend}`)

  // 落盘存储
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const dir = path.resolve(process.cwd(), '.data')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${symbol}.json`),
    JSON.stringify({ symbol, name: quote.name, fetchedAt: new Date().toISOString(), klines }, null, 2),
    'utf-8',
  )
  console.log(`已保存到 .data/${symbol}.json`)
}

/** 命令2：算信号 */
async function signalAndShow(ctx: Context, symbol: string, days: number, strategy?: string) {
  const klines = await ctx.marketData.daily(symbol, { days })
  if (klines.length === 0) {
    console.log(`没有取到 ${symbol} 的数据`)
    return
  }
  const quote = await ctx.marketData.quote(symbol)
  const signal = ctx.signal.evaluate(klines, strategy)

  console.log('')
  console.log(`== ${quote.name} (${symbol}) 信号 ==`)
  console.log(`动作: ${signal.kind}   基于: ${signal.date} 收盘 ${signal.price.toFixed(2)}`)
  console.log(`策略: ${signal.strategy}   ${JSON.stringify(signal.indicators)}`)
  console.log(`理由: ${signal.reason}`)
  // MA 对照表只对均线策略有意义
  if (signal.strategy === 'ma-cross') {
    console.log('')
    console.log('  日期        收盘     MA5     MA10')
    const closes = klines.map((k) => k.close)
    for (let i = Math.max(0, klines.length - 10); i < klines.length; i++) {
      const k = klines[i]
      const f = ma(closes.slice(0, i + 1), 5)
      const s = ma(closes.slice(0, i + 1), 10)
      console.log(`  ${k.date}  ${k.close.toFixed(2).padStart(8)} ${f.toFixed(2).padStart(7)} ${s.toFixed(2).padStart(7)}`)
    }
  }
}

/** 命令3：历史回测 */
async function backtestAndShow(ctx: Context, symbol: string, days: number, capital: number, strategy?: string) {
  const klines = await ctx.marketData.daily(symbol, { days })
  const minBars = ctx.signal.getMinBars(strategy)
  if (klines.length < minBars) {
    console.log(`${symbol} 历史K线仅 ${klines.length} 根，不足策略要求的 ${minBars} 根（次新股或长期停牌），无法回测`)
    return
  }
  const quote = await ctx.marketData.quote(symbol)

  const result = runBacktest(
    symbol,
    strategy ?? 'ma-cross',
    klines,
    (history) => ctx.signal.evaluate(history, strategy).kind,
    { capital, warmup: minBars - 1 }, // 按策略适配预热期，否则回放早期会炸"数据不足"
  )

  console.log('')
  console.log(`== ${quote.name} (${symbol}) 回测 ==`)
  console.log(`策略: ${result.strategy}   区间: ${result.periodStart} ~ ${result.periodEnd} (共 ${result.barCount} 根日K)`)
  console.log(`初始资金: ${result.initialCapital.toLocaleString()}   期末: ${Math.round(result.finalEquity).toLocaleString()}`)
  console.log(`策略总收益: ${result.totalReturnPercent.toFixed(2)}%    买入持有: ${result.buyHoldReturnPercent.toFixed(2)}%    超额: ${result.excessReturnPercent.toFixed(2)}%`)
  console.log(`交易 ${result.tradeCount} 次   胜率: ${result.winRate.toFixed(1)}%    最大回撤: ${result.maxDrawdownPercent.toFixed(2)}%`)
  if (result.trades.length > 0) {
    console.log('')
    console.log('  开仓日期    平仓日期    买入价    卖出价    收益率    持仓(天)')
    for (const t of result.trades) {
      console.log(
        `  ${t.entryDate}  ${t.exitDate}  ${t.entryPrice.toFixed(2).padStart(8)}`
        + ` ${t.exitPrice.toFixed(2).padStart(8)} ${t.returnPercent.toFixed(2).padStart(7)}% ${String(t.days).padStart(8)}`,
      )
    }
  }
  // 如果全程没交易，多半是本金买不起一手（A股一手=100股）
  if (result.tradeCount === 0) {
    const lastPrice = klines[klines.length - 1].close
    const oneLot = lastPrice * 100
    console.log(`\n提示: 全程 0 次交易 —— 本金 ${capital.toLocaleString()} 元买不起一手（该股一手约需 ${Math.round(oneLot).toLocaleString()} 元）`)
    console.log('       可用更大的 --capital，或选一只更便宜的股票回测。')
    return
  }
  const verdict = result.excessReturnPercent > 0
    ? `策略跑赢买入持有 ${result.excessReturnPercent.toFixed(2)} 个百分点`
    : `策略跑输买入持有 ${Math.abs(result.excessReturnPercent).toFixed(2)} 个百分点`
  console.log(`\n结论: ${verdict}（仅供参考，历史不代表未来，不构成投资建议）`)
}

// ================= 模拟盘（走 broker 缝 + 风控） =================

/** 读取可选的风控配置（.data/risk.json），缺省用内置默认 */
async function loadRiskConfig(): Promise<Partial<RiskConfig>> {
  try {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const raw = await fs.readFile(path.resolve(process.cwd(), '.data', 'risk.json'), 'utf-8')
    return JSON.parse(raw) as Partial<RiskConfig>
  } catch {
    return {}
  }
}

/** 迷你资产曲线（ASCII 火花线） */
function sparkline(values: number[]): string {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const blocks = '▁▂▃▄▅▆▇█'
  return values
    .map((v) => blocks[max === min ? 0 : Math.round(((v - min) / (max - min)) * (blocks.length - 1))])
    .join('')
}

async function paperStatus(ctx: Context, acc: PaperAccount) {
  const capital = await ctx.broker.capital()
  const cash = await ctx.broker.cash()
  const positions = await ctx.broker.positions()
  const trades = await ctx.broker.trades()

  console.log('')
  console.log('== 模拟账户 ==')
  console.log(`初始资金: ${capital.toLocaleString()} 元    当前现金: ${Math.round(cash).toLocaleString()} 元`)
  const hist = (acc.equityHistory ?? []).slice(-40)
  if (hist.length >= 2) {
    const values = hist.map((h) => h.equity)
    console.log(`资产曲线(最近 ${hist.length} 次操作): ${sparkline(values)}  ${values[0].toFixed(0)} → ${values[values.length - 1].toFixed(0)} 元`)
  }
  let equity = cash
  if (positions.length === 0) {
    console.log('持仓: 空仓')
  } else {
    console.log('')
    console.log('  代码      名称      持仓(股)   成本价    现价      市值        浮动盈亏')
    for (const p of positions) {
      const q = await ctx.marketData.quote(p.symbol)
      const value = p.shares * q.price
      const profit = value - p.avgCost * p.shares
      const profitPct = (q.price / p.avgCost - 1) * 100
      equity += value
      console.log(
        `  ${p.symbol}  ${p.name}  ${String(p.shares).padStart(8)} ${p.avgCost.toFixed(2).padStart(8)}`
        + ` ${q.price.toFixed(2).padStart(8)} ${Math.round(value).toLocaleString().padStart(10)} ${profit.toFixed(2).padStart(10)} (${profitPct.toFixed(2)}%)`,
      )
    }
  }
  const totalProfit = equity - capital
  const totalPct = capital > 0 ? (totalProfit / capital) * 100 : 0
  console.log(`\n总资产(含持仓市值): ${Math.round(equity).toLocaleString()} 元    总盈亏: ${totalProfit.toFixed(2)} 元 (${totalPct.toFixed(2)}%)`)
  if (trades.length > 0) {
    console.log(`\n最近交易（共 ${trades.length} 笔）:`)
    console.log('  日期        动作  代码      价格      股数      金额(元)')
    for (const t of trades.slice(-10)) {
      console.log(
        `  ${t.date}  ${t.side}  ${t.symbol}  ${t.price.toFixed(2).padStart(8)}`
        + ` ${String(t.shares).padStart(7)} ${Math.round(t.amount).toLocaleString().padStart(10)}`,
      )
    }
  }
  console.log(`\n账户文件: ${accountFilePath()}`)
}

/** 买入（与 Web 同一套逻辑：按预算过风控 → 成交） */
async function paperBuyCmd(ctx: Context, symbol: string, amount?: number) {
  const r = await paperOps.buy(ctx, symbol, amount)
  console.log(r.message)
  if (r.ok) {
    const cash = await ctx.broker.cash()
    console.log(`剩余现金: ${Math.round(cash).toLocaleString()} 元`)
  }
}

async function paperSellCmd(ctx: Context, symbol: string, shares?: number) {
  const q = await ctx.marketData.quote(symbol)
  const fill = await ctx.broker.sell({ symbol, name: q.name, price: q.price, shares })
  const profitTxt = fill.profit != null ? `，实现盈亏 ${fill.profit.toFixed(2)} 元` : ''
  console.log(`已卖出 ${q.name}(${symbol}) ${fill.shares} 股 @ ${q.price.toFixed(2)}${profitTxt}`)
  const cash = await ctx.broker.cash()
  console.log(`当前现金: ${Math.round(cash).toLocaleString()} 元`)
}

/** 按信号自动操作（与 Web 同一套 ops：预算买入 + 止损） */
async function paperApplyCmd(ctx: Context, symbol: string, strategy?: string) {
  const r = await paperOps.apply(ctx, symbol, strategy)
  if (r.signal) console.log(`信号(${symbol}): ${r.signal.kind}  ${r.signal.reason}`)
  console.log(r.message)
}

// ================= 实盘记录（与 Web 实盘页同一份数据） =================

const SIDE_TEXT = { BUY: '买入', SELL: '卖出' } as const

/** 终端显示宽度：CJK/全角字符按 2 个英文宽计（padStart 只数字符数，中文混排会歪） */
function dispW(s: string): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1
  return w
}

/** 按显示宽度补空格（l=左对齐补右边，r=右对齐补左边） */
function pad(s: string, width: number, align: 'l' | 'r' = 'l'): string {
  const gap = Math.max(width - dispW(s), 0)
  return align === 'r' ? ' '.repeat(gap) + s : s + ' '.repeat(gap)
}

/** 表格化打印：动态列宽（取各列最宽单元格），首行为表头 */
function printTable(head: string[], rows: string[][], aligns: Array<'l' | 'r'>): void {
  const widths = head.map((h, i) => Math.max(dispW(h), ...rows.map((r) => dispW(r[i] ?? ''))))
  const line = (cells: string[]) =>
    '  ' + cells.map((c, i) => pad(c ?? '', widths[i], aligns[i])).join('  ').trimEnd()
  console.log(line(head))
  for (const r of rows) console.log(line(r))
}

/** 命令5：实盘记录（持仓估值表 + 赛马建议 + 成交明细表） */
async function realAndShow(ctx: Context) {
  const trades = await loadJournal()
  if (trades.length === 0) {
    console.log('实盘记录还是空的。去网页"实盘记录"页手工录入成交（数据存 .data/real-journal.json）')
    return
  }
  const valued = await valuePositions({
    quote: (code) => ctx.marketData.quote(code),
    daily: (code, days) => ctx.marketData.daily(code, { days }),
    evaluate: (klines, strategy) => ctx.signal.evaluate(klines, strategy),
    stopLossRatio: ctx.risk.config.stopLossRatio,
  }, trades)

  console.log('')
  console.log('== 实盘持仓（移动加权，成本含手续费） ==')
  if (valued.length === 0) {
    console.log('  当前空仓（历史成交只留明细）')
  } else {
    printTable(
      ['代码', '名称', '股数', '成本价', '现价', '市值', '浮动盈亏', '浮动%'],
      valued.map((p) => {
        const nan = Number.isNaN(p.currentPrice)
        return [
          p.code,
          p.name ?? '--',
          String(p.shares),
          p.avgCost.toFixed(2),
          nan ? '--' : p.currentPrice.toFixed(2),
          nan ? '--' : Math.round(p.marketValue).toLocaleString(),
          nan ? '--' : `${p.profit >= 0 ? '+' : ''}${p.profit.toFixed(2)}`,
          nan ? '--' : `${p.profitPercent >= 0 ? '+' : ''}${p.profitPercent.toFixed(2)}%`,
        ]
      }),
      ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r'],
    )
    console.log('')
    console.log('  ── 卖出参考 ──')
    for (const p of valued) {
      const g = p.sellGuide
      if (!g?.available) {
        console.log(`  ${p.code} ${p.name ?? ''} → --（${g?.reason ?? '行情异常，无法计算'}）`)
        continue
      }
      const fmt = (v: number) => v.toFixed(g.tick === 0.001 ? 3 : 2)
      const risk = g.riskTriggered ? '已跌破防守线' : `距防守 ${g.distanceToStopPercent.toFixed(1)}%`
      console.log(`  ${p.code} ${p.name ?? ''} → 防守 ${fmt(g.effectiveStopPrice)}（风控 ${fmt(g.stopLossPrice)} / 技术 ${fmt(g.protectionPrice)}）`)
      console.log(`      止盈 ${fmt(g.targets[0].price)} / ${fmt(g.targets[1].price)} · ${g.trendLabel} · ${risk}`)
      console.log(`      ${g.advice}`)
    }
    console.log('')
    console.log('  ── 赛马建议 ──')
    for (const p of valued) {
      if (!p.signal) {
        console.log(`  ${p.code} ${p.name ?? ''} → --（日K不足或行情异常，不给建议）`)
        continue
      }
      const action = p.signal.kind === 'BUY' ? '建议买入' : p.signal.kind === 'SELL' ? '建议卖出' : '继续持有'
      console.log(`  ${p.code} ${p.name ?? ''} → ${action}`)
      for (const line of p.signal.reason.split('\n')) console.log(`      ${line}`)
    }
  }

  const sorted = [...trades].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)))
  console.log('')
  console.log(`== 成交明细（共 ${trades.length} 笔，最近 ${Math.min(10, trades.length)} 笔） ==`)
  printTable(
    ['日期', '动作', '代码', '名称', '成交价', '股数', '手续费'],
    sorted.slice(-10).map((t) => [
      t.date,
      SIDE_TEXT[t.side],
      t.code,
      t.name ?? '--',
      t.price.toFixed(2),
      String(t.shares),
      t.fee != null ? t.fee.toFixed(2) : '--',
    ]),
    ['l', 'l', 'l', 'l', 'r', 'r', 'r'],
  )
}

async function runPaper(ctx: Context, args: string[], strategy?: string) {
  const action = args[0] || 'status'
  const capitalIdx = args.indexOf('--capital')
  const capital = capitalIdx >= 0 && args[capitalIdx + 1] ? Number(args[capitalIdx + 1]) || 100_000 : 100_000
  const symbol = args[1]

  if (action === 'init') {
    const existing = await loadAccount()
    if (existing && !args.includes('--force')) {
      console.log(`账户已存在（现金 ${Math.round(existing.cash).toLocaleString()} 元）。要重置请加 --force。`)
      return
    }
    await saveAccount(createAccount(capital))
    console.log(`模拟账户已创建: 初始资金 ${capital.toLocaleString()} 元（文件: ${accountFilePath()}）`)
    return
  }

  const existing = await loadAccount()
  if (!existing) {
    console.log('还没有模拟账户，先运行: paper init [--capital C]')
    return
  }

  if (action === 'status') {
    await paperStatus(ctx, existing)
  } else if (action === 'buy') {
    if (!symbol) { console.log('用法: paper buy <股票代码> [--amount 金额]'); return }
    const ai = args.indexOf('--amount')
    const amount = ai >= 0 && args[ai + 1] ? Number(args[ai + 1]) || undefined : undefined
    await paperBuyCmd(ctx, symbol, amount)
  } else if (action === 'sell') {
    if (!symbol) { console.log('用法: paper sell <股票代码> [--shares N]'); return }
    let shares: number | undefined
    const si = args.indexOf('--shares')
    if (si >= 0 && args[si + 1]) shares = Number(args[si + 1]) || undefined
    await paperSellCmd(ctx, symbol, shares)
  } else if (action === 'deposit') {
    const di = args.indexOf('--amount')
    const amount = di >= 0 && args[di + 1] ? Number(args[di + 1]) : Number(symbol)
    if (!amount || amount <= 0) { console.log('用法: paper deposit <金额>（如 paper deposit 50000）'); return }
    const r = await paperOps.addDeposit(amount)
    console.log(r.message)
  } else if (action === 'apply') {
    if (!symbol) { console.log('用法: paper apply <股票代码>'); return }
    await paperApplyCmd(ctx, symbol, strategy)
  } else {
    console.log(`未知操作: ${action}（可用 init / status / buy / sell / deposit / apply）`)
  }
}

// ================= 入口 =================

async function main() {
  const args = process.argv.slice(2)
  const ctx = new Context()
  await ctx.plugin(ConsoleLogger)
  await ctx.plugin(MarketData)
  await ctx.plugin(SignalService)
  await ctx.plugin(BrokerService)
  await ctx.plugin(RiskService, await loadRiskConfig())
  ctx.marketData.registerProvider(new EastmoneyProvider())
  ctx.marketData.registerProvider(new TencentProvider())
  ctx.signal.registerProvider(new MaCrossProvider())
  ctx.signal.registerProvider(new RsiProvider())
  ctx.signal.registerProvider(new MacdProvider())
  ctx.signal.registerProvider(new DonchianProvider())
  ctx.signal.registerProvider(new BollingerProvider())
  ctx.signal.registerProvider(new CompositeProvider())
  ctx.broker.registerProvider(new PaperBrokerProvider())

  // 全局 --strategy 参数（signal / backtest / paper apply 共用）
  const strategyIdx = args.indexOf('--strategy')
  const strategy = strategyIdx >= 0 && args[strategyIdx + 1] ? args[strategyIdx + 1] : undefined

  try {
    if (args[0] === 'paper') {
      await runPaper(ctx, args.slice(1), strategy)
      return
    }
    if (args[0] === 'real') {
      await realAndShow(ctx)
      return
    }
    const command = args[0]
    const isSignal = command === 'signal'
    const isBacktest = command === 'backtest'
    const symbol = isSignal || isBacktest ? args[1] : args[0]
    if (!symbol) {
      usage()
      return
    }
    let days = isBacktest ? 250 : isSignal ? 60 : 120
    const di = args.indexOf('--days')
    if (di >= 0 && args[di + 1]) days = Number(args[di + 1]) || days
    let capital = 100_000
    const ci = args.indexOf('--capital')
    if (ci >= 0 && args[ci + 1]) capital = Number(args[ci + 1]) || 100_000

    if (isBacktest) await backtestAndShow(ctx, symbol, days, capital, strategy)
    else if (isSignal) await signalAndShow(ctx, symbol, days, strategy)
    else await fetchAndShow(ctx, symbol, days)
  } catch (err) {
    console.error('执行失败:', err)
    process.exitCode = 1
  } finally {
    await ctx.fiber.dispose()
  }
}

main()
