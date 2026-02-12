'use client'

import type React from 'react'

interface HeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  /** Optional badges/metadata row below the title */
  badges?: React.ReactNode
}

export function Header({ title, description, action, badges }: HeaderProps) {
  return (
    <div className="border-b border-border bg-linear-to-b from-blue-50/60 to-card dark:from-blue-950/20 dark:to-card">
      <div className="flex items-start justify-between px-6 py-5">
        <div className="animate-in fade-in slide-in-from-bottom-1 duration-400">
          <h2 className="text-3xl font-bold tracking-tight text-foreground">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          {badges && <div className="mt-2 flex items-center gap-2">{badges}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  )
}
