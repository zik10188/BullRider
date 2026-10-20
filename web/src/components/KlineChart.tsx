// K线图组件：TradingView Lightweight Charts（v5），A股红涨绿跌 + MA5/MA10 叠加
import { useEffect, useRef } from 'react'
import { createChart, ColorType, CandlestickSeries, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import type { KLine } from '../api'
import { maSeries } from '../lib/ma'

type Series = ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>

export default function KlineChart({ klines }: { klines: KLine[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<Series[]>([])

  // 只创建一次图表
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b96a8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(35, 46, 71, 0.55)' },
        horzLines: { color: 'rgba(35, 46, 71, 0.55)' },
      },
      rightPriceScale: { borderColor: '#232e47' },
      timeScale: { borderColor: '#232e47' },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = []
    }
  }, [])

  // 数据变化时重建序列
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const s of seriesRef.current) chart.removeSeries(s)
    seriesRef.current = []

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#f0444e',
      downColor: '#2fa96f',
      wickUpColor: '#f0444e',
      wickDownColor: '#2fa96f',
      borderVisible: false,
    })
    candles.setData(klines.map((k) => ({ time: k.date, open: k.open, high: k.high, low: k.low, close: k.close })))

    const ma5 = chart.addSeries(LineSeries, { color: '#f5b942', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    ma5.setData(maSeries(klines, 5).map((p) => ({ time: p.time, value: p.value })))

    const ma10 = chart.addSeries(LineSeries, { color: '#60a5fa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    ma10.setData(maSeries(klines, 10).map((p) => ({ time: p.time, value: p.value })))

    seriesRef.current = [candles, ma5, ma10]
    chart.timeScale().fitContent()
  }, [klines])

  return <div ref={containerRef} className="chart-wrap" aria-label="K线图" />
}
