/**
 * Status badge component for connection and sync indicators
 */

import { cn } from "@/lib/utils"

interface StatusBadgeProps {
  status: "online" | "offline" | "syncing" | "error" | "ready"
  showDot?: boolean
  className?: string
}

export function StatusBadge({ status, showDot = true, className }: StatusBadgeProps) {
  const variants = {
    online: "bg-green-100 text-green-800 border-green-200",
    offline: "bg-gray-100 text-gray-600 border-gray-200",
    syncing: "bg-secondary/20 text-secondary-foreground border-secondary/30",
    error: "bg-red-100 text-red-800 border-red-200",
    ready: "bg-secondary/20 text-secondary-foreground border-secondary/30",
  }

  const dotVariants = {
    online: "bg-green-500",
    offline: "bg-gray-400",
    syncing: "bg-secondary animate-pulse-dot",
    error: "bg-red-500 animate-pulse-dot",
    ready: "bg-secondary",
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium",
        variants[status],
        className,
      )}
    >
      {showDot && <div className={cn("h-2 w-2 rounded-full", dotVariants[status])} />}
      <span className="capitalize">{status === 'ready' ? 'Ready' : status}</span>
    </div>
  )
}
