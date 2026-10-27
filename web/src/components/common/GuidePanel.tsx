import type { ReactNode } from 'react'

export default function GuidePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="guide-panel">
      <h3>{title}</h3>
      {children}
    </div>
  )
}
