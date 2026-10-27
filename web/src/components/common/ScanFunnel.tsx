import { Fragment } from 'react'

interface FunnelItem {
  label: string
  value: number
}

export default function ScanFunnel({ market, filtered, scanned, etfScanned, buys }: {
  market: number
  filtered: number
  scanned: number
  etfScanned: number
  buys: number
}) {
  const steps: FunnelItem[] = [
    { label: '主板', value: market },
    { label: '条件过滤', value: filtered },
    { label: '股票精算', value: scanned },
    { label: 'ETF 白名单', value: etfScanned },
    { label: '买入信号', value: buys },
  ]

  return (
    <div className="scan-funnel" aria-label="扫描漏斗">
      {steps.map((step, i) => (
        <Fragment key={step.label}>
          {i > 0 && (
            <span className="funnel-arrow" aria-hidden="true">
              {i === 3 ? '+' : '→'}
            </span>
          )}
          <div className={i === steps.length - 1 ? 'result' : undefined}>
            <span>{step.label}</span>
            <b className="num">{step.value}</b>
          </div>
        </Fragment>
      ))}
    </div>
  )
}
