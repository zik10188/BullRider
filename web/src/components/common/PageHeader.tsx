import type { ReactNode } from 'react'

export default function PageHeader({ title, description, status, actions }: {
  title: string
  description: string
  status?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <div className="page-title">
          <h2>{title}</h2>
          {status && <span className="page-status">{status}</span>}
        </div>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}
