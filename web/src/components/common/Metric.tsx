import type { ReactNode } from 'react'

export interface MetricItem {
  label: string
  value: string
  cls?: string
  note?: string
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="metric-grid">{children}</div>
}

export function Metric({ label, value, cls, note, variant }: MetricItem & { variant?: 'positive' | 'negative' }) {
  return (
    <div className={`metric${variant ? ` verdict ${variant}` : ''}`}>
      <div className="label">{label}</div>
      <div className={`value num ${cls ?? ''}`}>{value}</div>
      {note && <p>{note}</p>}
    </div>
  )
}
