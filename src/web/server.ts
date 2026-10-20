// BullRider Web 服务（阶段6）
// 复用命令行同一套后端服务（marketData/signal/broker/risk），对外提供 REST API，
// 并托管 web/dist 里的前端页面。启动：pnpm web  ->  http://127.0.0.1:3080
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ConsoleLogger from '@deepseek-ai/cordis-plugin-logger-console'
import MarketData from '../market-data/service'
import { EastmoneyProvider } from '../market-data/eastmoney'
import { TencentProvider } from '../market-data/tencent'
import SignalService from '../signal/service'
import { MaCrossProvider } from '../signal/ma-cross'
import { RsiProvider } from '../signal/rsi'
import { MacdProvider } from '../signal/macd'
import { DonchianProvider } from '../signal/donchian'
import { BollingerProvider } from '../signal/bollinger'
import { CompositeProvider } from '../signal/composite'
import BrokerService from '../broker/service'
import { PaperBrokerProvider } from '../broker/paper'
import RiskService from '../risk/service'
import { runBacktest } from '../backtest/engine'
import * as paper from '../paper/ops'
import * as prefsStore from '../prefs/store'
import * as realJournal from '../real/journal'
import { valuePositions } from '../real/positions'
import { computePriceGuide } from '../price-guide/compute'
import * as screener from '../screener/screener'
import * as track from '../track/tracker'
import type { RiskConfig } from '../risk/types'
import { normalizeLlmBaseUrl, requiresNewKeyForEndpointChange, resolveLlmConfig, type LlmConfig } from './llm-config'

const PORT = Number(process.env.PORT) || 3080
const DIST = resolve(process.cwd(), 'web', 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

/** 读取可选风控配置 .data/risk.json */
async function loadRiskConfig(): Promise<Partial<RiskConfig>> {
  try {
    const raw = await readFile(resolve(process.cwd(), '.data', 'risk.json'), 'utf-8')
    return JSON.parse(raw) as Partial<RiskConfig>
  } catch {
    return {}
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function parseUrl(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url, 'http://localhost')
  return { path: u.pathname, query: u.searchParams }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function num(v: string | null, fallback: number): number {
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 调用 OpenAI 兼容的 /chat/completions 端点，返回回复文本 */
async function callOpenAICompatible(cfg: LlmConfig, messages: Array<{ role: string; content: string }>): Promise<string> {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, stream: false }),
      signal: ctrl.signal,
    })
    const data = (await r.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>
      error?: { message?: string }
    } | null
    if (!r.ok) throw new Error(data?.error?.message || `端点返回 HTTP ${r.status}`)
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content) throw new Error('端点响应里没有回复内容')
    return content
  } finally {
    clearTimeout(timer)
  }
}

/** 组装 AI 教练的系统提示词（注入真实账户与最近查询的多只股票行情） */
async function buildCoachSystem(ctx: Context, symbols: string[], strategy?: string): Promise<string> {
  const lines: string[] = [
    '你是 BullRider 的 AI 股票教练，面向A股新手用户。职责：用通俗中文解读行情与策略信号、点评用户的操作、提示风险与仓位纪律。',
    '红线：你不能预测涨跌；所有内容仅供参考，不构成投资建议；用户问"该不该买"时要引导他自己决策，并把下方真实数据作为唯一事实依据。',
    '以下是当前真实数据：',
  ]
  try {
    const snap = await paper.snapshot(ctx)
    if (snap.exists) {
      lines.push(`- 模拟账户：现金 ${snap.cash.toFixed(0)} 元，总资产 ${snap.equity.toFixed(0)} 元，总盈亏 ${snap.totalProfitPercent.toFixed(2)}%`)
      for (const p of snap.positions) {
        lines.push(`- 持仓 ${p.symbol} ${p.name}：${p.shares} 股，成本 ${p.avgCost.toFixed(2)}，现价 ${p.price.toFixed(2)}，浮动盈亏 ${p.profitPercent.toFixed(2)}%`)
      }
    } else {
      lines.push('- 模拟账户：尚未创建')
    }
    // 最近查询过的股票（最多 5 只）：每只注入实时行情 + 策略信号
    for (const symbol of symbols.slice(0, 5)) {
      try {
        const klines = await ctx.marketData.daily(symbol, { days: 60 })
        const q = await ctx.marketData.quote(symbol)
        const signal = ctx.signal.evaluate(klines, strategy)
        lines.push(`- 标的 ${q.name}(${symbol})：现价 ${q.price.toFixed(2)}，今日涨跌 ${q.changePercent.toFixed(2)}%`)
        lines.push(`  策略信号(${signal.strategy})：${signal.kind} —— ${signal.reason}（指标 ${JSON.stringify(signal.indicators)}）`)
      } catch {
        lines.push(`- 标的 ${symbol}：行情获取失败`)
      }
    }
    // 最近一次回测：标的在查询列表里时注入
    if (lastBacktest && symbols.includes(lastBacktest.symbol)) {
      const r = lastBacktest.result
      lines.push(`- 最近回测 ${lastBacktest.name}(${lastBacktest.symbol})，策略 ${r.strategy}，区间 ${r.periodStart}~${r.periodEnd}（${r.barCount} 根日K）：策略收益 ${r.totalReturnPercent.toFixed(2)}%，买入持有 ${r.buyHoldReturnPercent.toFixed(2)}%，超额 ${r.excessReturnPercent.toFixed(2)}%，交易 ${r.tradeCount} 次胜率 ${r.winRate.toFixed(1)}%，最大回撤 ${r.maxDrawdownPercent.toFixed(2)}%`)
    }
    // 实盘记录（真实资金）：让 AI 知道你的真实仓位与最近操作，认知与实盘对齐
    try {
      const trades = await realJournal.loadJournal()
      if (trades.length > 0) {
        const positions = realJournal.derivePositions(trades)
        if (positions.length > 0) {
          lines.push('- 实盘持仓（真实资金，与模拟盘无关，点评时必须区分）:')
          for (const p of positions) {
            lines.push(`  · ${p.code} ${p.name ?? ''}：净持仓 ${p.shares} 股，成本约 ${p.avgCost.toFixed(2)}`)
          }
        }
        lines.push('- 实盘最近成交:')
        for (const t of trades.slice(-5)) {
          lines.push(`  · ${t.date} ${t.side === 'BUY' ? '买入' : '卖出'} ${t.code} ${t.name ?? ''}：${t.shares} 股 @ ${t.price.toFixed(2)}`)
        }
      } else {
        lines.push('- 实盘记录：暂无（用户尚未同步真实交易，请勿假设用户有真实持仓）')
      }
    } catch { /* 实盘记录读取失败不阻塞对话 */ }
    // 最近一次选股推荐扫描：让 AI 知道今天筛出了哪些候选
    try {
      const scan = await screener.loadScanReport()
      if (scan) {
        lines.push(`- 选股推荐（${scan.at.slice(0, 16).replace('T', ' ')} 扫描）：主板 ${scan.totalMarket} 只 → 过滤后 ${scan.passedFilter} 只 → 精算 ${scan.scanned} 只，触发买入信号 ${scan.buys.length} 只${scan.excludedHeld.length ? `（已排除实盘持仓 ${scan.excludedHeld.length} 只）` : ''}`)
        for (const b of scan.buys.slice(0, 5)) {
          lines.push(`  · 推荐 ${b.code} ${b.name}：现价 ${b.price.toFixed(2)}，买方权重 ${b.buyWeight.toFixed(1)}%`)
        }
        if (scan.buys.length === 0) lines.push('  · 本次扫描无买入信号（信号稀疏是策略的保守特性，勿硬凑推荐）')
      }
    } catch { /* 扫描结果读取失败不阻塞对话 */ }
  } catch {
    lines.push('- （行情/账户数据获取失败，回答时请说明拿不到实时数据）')
  }
  return lines.join('\n')
}

/** 最近一次回测结果（内存缓存，服务重启即清；供 AI 教练注入对话上下文） */
let lastBacktest: { symbol: string; name: string; at: number; result: ReturnType<typeof runBacktest> } | null = null

/** 扫描并发锁（内存级）：扫描期间拒绝新的扫描请求，防止页面切换重置按钮后并发双扫 */
let scanInFlight = false

async function handleApi(ctx: Context, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  // 路由：/api/xxx 拆成段
  const seg = path.split('/').filter(Boolean) // e.g. ['api','quote','600519']

  // GET /api/quote/:symbol
  if (seg[1] === 'quote' && seg[2]) {
    const q = await ctx.marketData.quote(seg[2])
    json(res, 200, q)
    return
  }

  // GET /api/daily/:symbol
  if (seg[1] === 'daily' && seg[2]) {
    const klines = await ctx.marketData.daily(seg[2], { days: num(query.get('days'), 250) })
    json(res, 200, { symbol: seg[2], klines })
    return
  }

  // GET /api/signal/:symbol
  if (seg[1] === 'signal' && seg[2]) {
    const klines = await ctx.marketData.daily(seg[2], { days: num(query.get('days'), 60) })
    const quote = await ctx.marketData.quote(seg[2])
    const signal = ctx.signal.evaluate(klines, query.get('strategy') ?? undefined)
    json(res, 200, { symbol: seg[2], name: quote.name, klines, signal })
    return
  }

  // GET /api/price-guide/:code：挂价参考（ATR 三档限价建议）；日K走磁盘缓存，实际仅 quote 一个真请求
  if (seg[1] === 'price-guide' && seg[2] && req.method === 'GET') {
    const code = seg[2]
    try {
      const q = await ctx.marketData.quote(code)
      const klines = await ctx.marketData.daily(code, { days: 60 })
      json(res, 200, computePriceGuide(code, q.price, klines))
    } catch (err) {
      // 行情拉不到等异常：不报 5xx，给人话原因让前端展示
      json(res, 200, { available: false, reason: (err as Error).message || '行情获取失败' })
    }
    return
  }

  // GET /api/backtest/:symbol
  if (seg[1] === 'backtest' && seg[2]) {
    const days = num(query.get('days'), 250)
    const capital = num(query.get('capital'), 100_000)
    const strategy = query.get('strategy') ?? undefined
    const klines = await ctx.marketData.daily(seg[2], { days })
    // 按策略最低数据量校验（次新股/长期停牌股历史K线可能不足）
    const minBars = ctx.signal.getMinBars(strategy)
    if (klines.length < minBars) {
      json(res, 400, { ok: false, message: `${seg[2]} 历史K线仅 ${klines.length} 根，不足策略要求的 ${minBars} 根（次新股或长期停牌），无法回测` })
      return
    }
    const quote = await ctx.marketData.quote(seg[2])
    // warmup 按策略最低数据量适配：否则回放早期会触发"数据不足"炸掉整个回测
    const result = runBacktest(seg[2], strategy ?? 'ma-cross', klines, (history) => ctx.signal.evaluate(history, strategy).kind, { capital, warmup: minBars - 1 })
    lastBacktest = { symbol: seg[2], name: quote.name, at: Date.now(), result }
    json(res, 200, { ...result, name: quote.name })
    return
  }

  // GET /api/paper（账户快照）
  if (seg[1] === 'paper' && seg.length === 2 && req.method === 'GET') {
    json(res, 200, await paper.snapshot(ctx))
    return
  }

  // POST /api/paper/init|buy|sell|apply
  if (seg[1] === 'paper' && seg[2] && req.method === 'POST') {
    const body = await readBody(req)
    const symbol = String(body.symbol ?? '')
    let result
    switch (seg[2]) {
      case 'init':
        result = await paper.initAccount(num(String(body.capital ?? ''), 100_000), Boolean(body.force))
        break
      case 'buy':
        if (!symbol) { json(res, 400, { ok: false, message: '缺少 symbol' }); return }
        result = await paper.buy(ctx, symbol, body.amount != null ? Number(body.amount) || undefined : undefined)
        break
      case 'sell':
        if (!symbol) { json(res, 400, { ok: false, message: '缺少 symbol' }); return }
        result = await paper.sell(ctx, symbol, body.shares ? Number(body.shares) : undefined)
        break
      case 'deposit':
        result = await paper.addDeposit(Number(body.amount) || 0)
        break
      case 'apply':
        if (!symbol) { json(res, 400, { ok: false, message: '缺少 symbol' }); return }
        result = await paper.apply(ctx, symbol, typeof body.strategy === 'string' && body.strategy ? body.strategy : undefined)
        break
      default:
        json(res, 404, { ok: false, message: `未知操作 ${seg[2]}` })
        return
    }
    json(res, result.ok ? 200 : 400, result)
    return
  }

  // GET /api/prefs：用户偏好（收藏/对话历史/模型设置）。Key 只回掩码，永不明文。
  if (seg[1] === 'prefs' && seg.length === 2 && req.method === 'GET') {
    const p = await prefsStore.loadPrefs()
    let llm: Record<string, unknown> | undefined
    if (p.llm) {
      const key = p.llm.encApiKey ? await prefsStore.decryptSecret(p.llm.encApiKey) : null
      llm = {
        baseUrl: p.llm.baseUrl ?? '',
        model: p.llm.model ?? '',
        contextWindow: p.llm.contextWindow ?? 32000,
        hasKey: Boolean(key),
        keyMask: prefsStore.maskKey(key ?? undefined),
      }
    }
    json(res, 200, { favorites: p.favorites ?? [], chat: p.chat ?? [], llm, lastSymbol: p.lastSymbol ?? '', queryHistory: p.queryHistory ?? [] })
    return
  }

  // PUT /api/prefs：按字段合并保存。llm.apiKey 有值才重新加密存储。
  if (seg[1] === 'prefs' && seg.length === 2 && req.method === 'PUT') {
    const body = await readBody(req)
    const cur = await prefsStore.loadPrefs()
    const next: prefsStore.Prefs = { ...cur }
    if (Array.isArray(body.favorites)) next.favorites = body.favorites.slice(0, 30)
    if (Array.isArray(body.chat)) next.chat = body.chat.slice(-200)
    if (typeof body.lastSymbol === 'string' && /^\d{6}$/.test(body.lastSymbol)) next.lastSymbol = body.lastSymbol
    if (Array.isArray(body.queryHistory)) {
      next.queryHistory = body.queryHistory
        .filter((f: unknown) => f && typeof f === 'object' && /^\d{6}$/.test((f as { code?: unknown }).code as string))
        .map((f: { code: string; name?: string }) => ({ code: f.code as string, name: typeof f.name === 'string' ? f.name : undefined }))
        .slice(0, 10)
    }
    if (body.llm && typeof body.llm === 'object') {
      const l = body.llm as { baseUrl?: unknown; model?: unknown; contextWindow?: unknown; apiKey?: unknown }
      const llm: prefsStore.LlmPrefs = { ...cur.llm }
      const newApiKey = typeof l.apiKey === 'string' ? l.apiKey.trim() : ''
      if (typeof l.baseUrl === 'string') {
        const rawBaseUrl = l.baseUrl.trim()
        if (!rawBaseUrl) {
          llm.baseUrl = ''
          delete llm.encApiKey
        } else {
          const baseUrl = normalizeLlmBaseUrl(rawBaseUrl)
          if (!baseUrl) {
            json(res, 400, { ok: false, message: '模型端点只支持不含账号密码的 HTTP/HTTPS 地址' })
            return
          }
          if (requiresNewKeyForEndpointChange({
            currentBaseUrl: cur.llm?.baseUrl,
            nextBaseUrl: baseUrl,
            hasStoredKey: Boolean(cur.llm?.encApiKey),
            hasNewKey: Boolean(newApiKey),
          })) {
            json(res, 400, { ok: false, message: '切换模型端点前请重新填写 API Key；服务端不会把已保存 Key 自动发往新地址' })
            return
          }
          llm.baseUrl = baseUrl
        }
      }
      if (typeof l.model === 'string') llm.model = l.model
      if (typeof l.contextWindow === 'number' && l.contextWindow > 0) llm.contextWindow = Math.floor(l.contextWindow)
      if (newApiKey) llm.encApiKey = await prefsStore.encryptSecret(newApiKey)
      next.llm = llm
    }
    await prefsStore.savePrefs(next)
    // 返回保存后的模型设置视图（Key 掩码），前端据此更新状态
    let llmView: Record<string, unknown> | undefined
    if (next.llm) {
      const key = next.llm.encApiKey ? await prefsStore.decryptSecret(next.llm.encApiKey) : null
      llmView = {
        baseUrl: next.llm.baseUrl ?? '',
        model: next.llm.model ?? '',
        contextWindow: next.llm.contextWindow ?? 32000,
        hasKey: Boolean(key),
        keyMask: prefsStore.maskKey(key ?? undefined),
      }
    }
    json(res, 200, { ok: true, llm: llmView })
    return
  }

  // GET /api/real：实盘记录（明细 + 持仓估值 + 每只持仓的策略赛马建议，失败不阻塞）
  if (seg[1] === 'real' && seg.length === 2 && req.method === 'GET') {
    const trades = await realJournal.loadJournal()
    const positions = await valuePositions({
      quote: (code) => ctx.marketData.quote(code),
      daily: (code, days) => ctx.marketData.daily(code, { days }),
      evaluate: (klines, strategy) => ctx.signal.evaluate(klines, strategy),
    }, trades)
    json(res, 200, { trades, positions })
    return
  }

  // POST /api/real：手工记一笔真实成交
  if (seg[1] === 'real' && seg.length === 2 && req.method === 'POST') {
    const body = await readBody(req)
    const t = {
      code: String(body.code ?? ''),
      name: typeof body.name === 'string' ? body.name : undefined,
      date: String(body.date ?? ''),
      side: body.side === 'SELL' ? 'SELL' as const : 'BUY' as const,
      price: Number(body.price),
      shares: Number(body.shares),
      fee: Number.isFinite(Number(body.fee)) && Number(body.fee) >= 0 ? Number(body.fee) : undefined,
    }
    if (!/^\d{6}$/.test(t.code) || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !Number.isFinite(t.price) || t.price <= 0 || !Number.isInteger(t.shares) || t.shares <= 0) {
      json(res, 400, { ok: false, message: '字段不合法：代码需6位数字、日期 YYYY-MM-DD、价格>0、股数为正整数' })
      return
    }
    const trades = await realJournal.loadJournal()
    const rec = { ...t, id: realJournal.newId() }
    trades.push(rec)
    await realJournal.saveJournal(trades)
    json(res, 200, { ok: true, trade: rec })
    return
  }

  // DELETE /api/real/:id：删掉记错的一笔，持仓自动重算
  if (seg[1] === 'real' && seg[2] && req.method === 'DELETE') {
    const trades = await realJournal.loadJournal()
    const next = trades.filter((t) => t.id !== seg[2])
    if (next.length === trades.length) {
      json(res, 404, { ok: false, message: `没有 id 为 ${seg[2]} 的记录` })
      return
    }
    await realJournal.saveJournal(next)
    json(res, 200, { ok: true })
    return
  }

  // GET /api/scan：最近一次选股推荐结果
  if (seg[1] === 'scan' && seg.length === 2 && req.method === 'GET') {
    const report = await screener.loadScanReport()
    json(res, 200, { report })
    return
  }

  // POST /api/scan：执行一次全市场漏斗扫描（同步返回，默认 100 只约 30~60 秒）
  if (seg[1] === 'scan' && seg.length === 2 && req.method === 'POST') {
    // 并发锁：切换页面会重置前端的扫描按钮，但服务端扫描不会被中断——用内存锁防止并发双扫叠加请求量（60 秒节流有窗口：扫描进行中时报告还是旧的，挡不住）
    if (scanInFlight) {
      json(res, 429, { ok: false, message: '上一次扫描还在进行中（切换页面不会中断它），请等它完成后再试' })
      return
    }
    // 节流：60 秒内只允许扫一次，别把免费数据源惹毛了
    const last = await screener.loadScanReport()
    if (last && Date.now() - new Date(last.at).getTime() < 60_000) {
      json(res, 429, { ok: false, message: `刚刚（${new Date(last.at).toLocaleTimeString()}）扫描过，60 秒内请勿重复扫描` })
      return
    }
    const body = await readBody(req)
    const opts = screener.normalizeScanOptions(body)
    scanInFlight = true
    try {
      const report = await screener.runScan(opts, (symbol, days) => ctx.marketData.daily(symbol, { days }), (m) => console.log(`[扫描] ${m}`))
      await screener.saveScanReport(report)
      // 信号质量追踪：对推荐股补历史样本 + 对全部在途回合做结算检查（失败不阻塞扫描结果返回）
      try {
        const deps: track.TrackDeps = {
          daily: (symbol, days) => ctx.marketData.daily(symbol, { days }),
          evaluate: (kl) => ctx.signal.evaluate(kl, 'composite').kind,
          log: (m) => console.log(`[追踪] ${m}`),
        }
        for (const b of report.buys) {
          await track.replayStock(b.code, b.name, deps)
          await new Promise((r) => setTimeout(r, 150)) // 每只之间限速，保护免费接口
        }
        const st = await track.settleCheck(deps)
        console.log(`[追踪] 结算检查完成：在途 ${st.checked} 组，本次结算 ${st.settled} 组`)
      } catch (err) {
        console.log(`[追踪] 失败（不影响扫描结果）: ${(err as Error).message}`)
      }
      json(res, 200, { report })
    } finally {
      scanInFlight = false // 无论成败（含客户端中途断开）都释放锁
    }
    return
  }

  // GET /api/track/stats：信号质量追踪统计（回合/信号两层口径 + 在途回合实时浮盈）
  if (seg[1] === 'track' && seg[2] === 'stats' && req.method === 'GET') {
    const stats = await track.trackStats((s) => ctx.marketData.quote(s))
    json(res, 200, stats)
    return
  }

  // DELETE /api/track/:code：删除某只股票的全部追踪记录（含已结算样本与补历史标记）
  if (seg[1] === 'track' && seg[2] && req.method === 'DELETE') {
    const code = seg[2]
    if (!/^\d{6}$/.test(code)) {
      json(res, 400, { ok: false, message: '代码需为 6 位数字' })
      return
    }
    const removed = await track.deleteStock(code)
    json(res, 200, { ok: true, removed })
    return
  }

  // POST /api/chat：AI 教练对话（代理用户配置的 OpenAI 兼容端点）
  if (seg[1] === 'chat' && seg.length === 2 && req.method === 'POST') {
    const body = await readBody(req)
    const cfg = (body.config ?? {}) as Partial<LlmConfig>
    const rawMessages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string; content?: string }> : []
    const messages = rawMessages
      .filter((m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role as string, content: m.content as string }))
    // 最近查询过的股票（去重、最多 5 只）：AI 一次能看一篮子
    const symbols = Array.isArray(body.symbols)
      ? (body.symbols as unknown[]).filter((s): s is string => typeof s === 'string' && /^\d{6}$/.test(s)).slice(0, 5)
      : []
    const strategy = typeof body.strategy === 'string' && body.strategy ? body.strategy : undefined
    const requested = {
      baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
      apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
      model: typeof cfg.model === 'string' ? cfg.model : '',
    }
    // 请求未显式携带 Key 时，端点、模型和 Key 必须全部使用服务端保存的那一组。
    // 防止请求方让已保存 Key 跟随任意 baseUrl 发往第三方地址。
    let stored: { baseUrl?: string; model?: string; apiKey?: string } = {}
    if (!requested.apiKey.trim()) {
      const p = await prefsStore.loadPrefs()
      stored = {
        baseUrl: p.llm?.baseUrl,
        model: p.llm?.model,
        apiKey: p.llm?.encApiKey ? (await prefsStore.decryptSecret(p.llm.encApiKey)) ?? '' : '',
      }
    }
    const resolved = resolveLlmConfig(requested, stored)
    if (!resolved.ok) {
      json(res, 400, { ok: false, message: resolved.reason })
      return
    }
    if (messages.length === 0) {
      json(res, 400, { ok: false, message: '消息内容为空' })
      return
    }
    try {
      const system = await buildCoachSystem(ctx, symbols, strategy)
      const reply = await callOpenAICompatible(resolved.config, [{ role: 'system', content: system }, ...messages])
      json(res, 200, { ok: true, reply })
    } catch (err) {
      const text = (err as Error).name === 'AbortError' ? '大模型响应超时（60秒）' : (err as Error).message
      json(res, 502, { ok: false, message: `调用大模型失败: ${text}` })
    }
    return
  }

  json(res, 404, { ok: false, message: '接口不存在' })
}

/** 托管前端静态文件（web/dist） */
async function serveStatic(res: ServerResponse, path: string): Promise<boolean> {
  const target = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
  const file = join(DIST, target)
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    const data = await readFile(file)
    const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime })
    res.end(data)
    return true
  } catch {
    return false
  }
}

async function main() {
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

  const server = createServer(async (req, res) => {
    const { path, query } = parseUrl(req.url ?? '/')
    try {
      if (path.startsWith('/api/')) {
        await handleApi(ctx, req, res, path, query)
        return
      }
      const served = await serveStatic(res, path)
      if (!served) {
        // SPA 兜底：未命中的非 /api 路径回退到 index.html
        const servedIndex = await serveStatic(res, '/')
        if (!servedIndex) json(res, 404, { ok: false, message: '未构建前端，请先在 web/ 下 pnpm build' })
      }
    } catch (err) {
      json(res, 500, { ok: false, message: (err as Error).message })
    }
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`BullRider web: http://127.0.0.1:${PORT}`)
  })

  // 优雅退出：Ctrl+C
  const shutdown = async () => {
    server.close()
    await ctx.fiber.dispose()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
