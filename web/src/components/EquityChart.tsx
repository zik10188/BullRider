// 资产曲线图：TradingView Lightweight Charts（面积图，牛金主色）
import { useEffect, useRef } from 'react'
import { createChart, ColorType, AreaSeries, type IChartApi } from 'lightweight-charts'

export default function EquityChart({ points }: { points: Array<{ date: string; equity: number }> }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ReturnType<IChartApi['addSeries']> | null>(null)

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
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(AreaSeries, {
      lineColor: '#f5b942',
      topColor: 'rgba(245, 185, 66, 0.35)',
      bottomColor: 'rgba(245, 185, 66, 0.02)',
      lineWidth: 2,
    })
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(points.map((p) => ({ time: p.date, value: p.equity })))
    chartRef.current?.timeScale().fitContent()
  }, [points])

  return <div ref={containerRef} className="chart-wrap" style={{ height: 260 }} aria-label="资产曲线" />
}
