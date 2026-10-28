import type { ReactNode } from 'react'

export default function PageHeader({ title, description, actions }: {
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}
