"use client"

import { createContext, useContext, useState, useEffect, useCallback } from "react"

const STORAGE_KEY = "pocketbridge_sidebar_collapsed"

interface SidebarContextValue {
  isCollapsed: boolean
  toggle: () => void
  setCollapsed: (collapsed: boolean) => void
}

const SidebarContext = createContext<SidebarContextValue>({
  isCollapsed: false,
  toggle: () => {},
  setCollapsed: () => {},
})

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Load persisted state on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === "true") setIsCollapsed(true)
    } catch {}
  }, [])

  const setCollapsed = useCallback((collapsed: boolean) => {
    setIsCollapsed(collapsed)
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed))
    } catch {}
  }, [])

  const toggle = useCallback(() => {
    setCollapsed(!isCollapsed)
  }, [isCollapsed, setCollapsed])

  return (
    <SidebarContext.Provider value={{ isCollapsed, toggle, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  return useContext(SidebarContext)
}
