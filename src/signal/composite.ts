// 多策略动态权重（分数制）—— 这只股票契合哪个策略，用最近 60 天的真实回测收益说话（机制类似赛马：近期跑得好的拿更大话语权）
// 原理：三个子策略各在最近 WEIGHT_WINDOW 根K线上回测一遍 → 收益率转权重（负收益记 0，保底 FLOOR）
//       → 支持某方向的总权重 ≥ TRIGGER 才触发；全员亏损时权重平摊，自动退化为等权兜底
// 参数依据：2026-10 对 8 只不同风格股票的网格扫描（W∈30~90），W60 为平台峰最优且邻域稳定
import type { KLine } from '../market-data/types'
import type { Signal, SignalKind } from './types'
import type { SignalProvider } from './provider'
import { runBacktest } from '../backtest/engine'
import { MaCrossProvider } from './ma-cross'
import { RsiProvider } from './rsi'
import { MacdProvider } from './macd'
import { DonchianProvider } from './donchian'
import { BollingerProvider } from './bollinger'

const WEIGHT_WINDOW = 60 // 权重回测窗口：用最近 60 根日K评价各子策略
const TRIGGER = 0.5      // 触发线：支持某方向的总权重过半才动手
const FLOOR = 0.15       // 单策略保底权重：最近亏钱的策略也不清零，风格切换时新赢家才来得及接管

/** 最低K线数（对外导出：回测方据此设置 warmup，避免回放早期误抛错） */
export const MIN_BARS = WEIGHT_WINDOW

const KIND_TEXT: Record<SignalKind, string> = { BUY: '买入', SELL: '卖出', HOLD: '持有' }

/** 收益率 → 权重：负收益记 0 → 归一化 → 保底截断 → 再归一化 */
function retsToWeights(rets: number[]): number[] {
  const raw = rets.map((r) => Math.max(r, 0) + 1e-6)
  const sum = raw.reduce((a, b) => a + b, 0)
  const norm = raw.map((r) => r / sum)
  const clipped = norm.map((n) => Math.max(n, FLOOR))
  const s2 = clipped.reduce((a, b) => a + b, 0)
  return clipped.map((n) => n / s2)
}

/** 子策略在窗口内的回测收益%（复用回测引擎同一套账本，保证与回测页口径一致） */
function subBacktestReturn(window: KLine[], p: SignalProvider): number {
  try {
    return runBacktest('', p.name, window, (h) => p.evaluate(h).kind).totalReturnPercent
  } catch {
    return 0 // 窗口内算不动（数据/异常）→ 记 0，靠保底权重兜底
  }
}

export class CompositeProvider implements SignalProvider {
  readonly name = 'composite'
  readonly minBars = MIN_BARS

  /** 子策略可注入（测试用假策略），缺省 = 内置五策略（3池/5池扫描对比：5池收益略降但最差情况与回撤显著更优） */
  constructor(private subs: SignalProvider[] = [new MaCrossProvider(), new RsiProvider(), new MacdProvider(), new DonchianProvider(), new BollingerProvider()]) {}

  evaluate(klines: KLine[]): Signal {
    if (klines.length < MIN_BARS) {
      throw new Error(`数据不足：策略赛马至少需要 ${MIN_BARS} 根K线（权重窗口）`)
    }

    // 1) 每个子策略：最近窗口的回测收益 + 对当前行情的意见
    const results = this.subs.map((p) => {
      const s = p.evaluate(klines)
      return { name: p.name, ret: subBacktestReturn(klines.slice(-WEIGHT_WINDOW), p), kind: s.kind, reason: s.reason, indicators: s.indicators }
    })

    // 2) 收益转权重，加权计票
    const weights = retsToWeights(results.map((r) => r.ret))
    const buyW = results.reduce((acc, r, i) => acc + (r.kind === 'BUY' ? weights[i] : 0), 0)
    const sellW = results.reduce((acc, r, i) => acc + (r.kind === 'SELL' ? weights[i] : 0), 0)
    let kind: SignalKind = 'HOLD'
    if (buyW >= TRIGGER && buyW > sellW) kind = 'BUY'
    else if (sellW >= TRIGGER && sellW > buyW) kind = 'SELL'

    // 3) 人话理由：三段式多行 —— 第一行结论（动作由消费方的徽章/标题表达，这里不重复），
    //    第二行权重依据，其后每匹马一条。换行分条，Web 端以 pre-line 渲染。
    const wText = results.map((r, i) => `${r.name} ${weights[i] * 100 > 0.05 ? `${(weights[i] * 100).toFixed(1)}%` : '<0.1%'}`).join(' / ')
    const head = kind === 'HOLD'
      ? `动态权重不过半（买方 ${(buyW * 100).toFixed(1)}% / 卖方 ${(sellW * 100).toFixed(1)}%），观望为宜`
      : `${KIND_TEXT[kind]}方权重 ${(Math.max(buyW, sellW) * 100).toFixed(1)}% 过半`
    const wLine = `各策略近 ${WEIGHT_WINDOW} 天回测收益定权重：${wText}`
    const detail = results.map((r) => `· ${r.name} ${KIND_TEXT[r.kind]}：${r.reason}`).join('\n')
    const reason = `${head}\n${wLine}\n${detail}`

    // 4) 合并子指标（ma5/ma10 供前端行情卡）+ 权重快照；键名冲突（如两个策略都有 upper/lower）时用策略名做前缀
    const indicators: Record<string, number> = {}
    for (const r of results) {
      for (const [k, v] of Object.entries(r.indicators)) {
        indicators[k in indicators ? `${r.name}.${k}` : k] = v
      }
    }
    results.forEach((r, i) => { indicators[`w_${r.name}`] = weights[i] })
    indicators.buyWeight = buyW
    indicators.sellWeight = sellW

    const last = klines[klines.length - 1]
    return { kind, date: last.date, price: last.close, strategy: this.name, reason, indicators }
  }
}
