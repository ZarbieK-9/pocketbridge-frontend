"use client"

/**
 * Main sidebar navigation component
 * Supports expanded (w-64) and collapsed (w-16) modes
 */

import Link from "next/link"
import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { FileText, MessageSquare, FolderOpen, Settings, LayoutDashboard, KeyRound, Pin } from "lucide-react"
import { cn } from "@/lib/utils"
import { PocketBridgeIcon } from "@/components/ui/logo"
import { useWebSocket } from "@/hooks/use-websocket"
import { useCrypto } from "@/hooks/use-crypto"
import { getOrCreateDeviceId } from "@/lib/utils/device"
import { getWsUrl } from "@/lib/utils/storage"
import { config } from "@/lib/config"
import { useSidebar } from "./sidebar-context"

// Get WebSocket URL from storage/config helpers
function getWebSocketUrl(): string {
  return getWsUrl() || config.wsUrl;
}

function getBackendApiUrlFromWs(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const isSecure = u.protocol === 'wss:';
    const httpProtocol = isSecure ? 'https:' : 'http:';
    const basePath = u.pathname.replace(/\/?ws$/, '');
    return `${httpProtocol}//${u.host}${basePath}`;
  } catch {
    return config.apiUrl;
  }
}

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/scratchpad", label: "Scratchpad", icon: FileText },
  { href: "/messages", label: "Secret Chat", icon: MessageSquare },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/pair", label: "Pair Device", icon: KeyRound },
]

export function Sidebar() {
  const pathname = usePathname()
  const { isCollapsed, toggle } = useSidebar()
  const deviceId = getOrCreateDeviceId()
  const { isInitialized: cryptoInitialized, identityKeyPair } = useCrypto()
  const wsUrl = getWebSocketUrl()
  const { status, error } = useWebSocket({
    url: wsUrl,
    deviceId,
    autoConnect: cryptoInitialized,
  })

  const [connectedDevices, setConnectedDevices] = useState<number>(0);

  // Poll connected devices count
  useEffect(() => {
    let timer: number | undefined;
    const apiUrl = getBackendApiUrlFromWs(wsUrl);
    const userId = identityKeyPair?.publicKeyHex;
    const fetchDevices = async () => {
      if (!userId) {
        setConnectedDevices(0);
        return;
      }
      try {
        const res = await fetch(`${apiUrl}/api/devices`, {
          headers: { 'X-User-ID': userId },
        });
        if (!res.ok) throw new Error('Failed to fetch devices');
        const data = await res.json();
        const online = (data.devices || []).filter((d: any) => d.is_online);
        setConnectedDevices(online.length);
      } catch {
        setConnectedDevices(0);
      }
    };
    fetchDevices();
    timer = window.setInterval(fetchDevices, 10000);
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [wsUrl, identityKeyPair]);

  // Status dot color
  function getStatusDotColor() {
    switch (status) {
      case 'connected':
        return connectedDevices > 0 ? 'bg-emerald-500' : 'bg-blue-500';
      case 'connecting':
      case 'reconnecting':
        return 'bg-amber-500 animate-pulse';
      case 'error':
        return 'bg-red-500';
      default:
        return 'bg-gray-400';
    }
  }

  // Status label for expanded view
  function getStatusLabel() {
    switch (status) {
      case 'connected':
        return connectedDevices > 0 ? 'Connected' : 'Ready';
      case 'connecting':
        return 'Connecting...';
      case 'reconnecting':
        return 'Reconnecting...';
      case 'error':
        return 'Error';
      default:
        return 'Offline';
    }
  }

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 h-screen border-r border-border bg-sidebar transition-all duration-300 ease-in-out",
        isCollapsed ? "w-16" : "w-64"
      )}
    >
      <div className="flex h-full flex-col">
        {/* Logo/Brand + Pin toggle */}
        <div className={cn(
          "flex h-16 items-center border-b border-sidebar-border",
          isCollapsed ? "justify-center px-2" : "justify-between px-4"
        )}>
          {isCollapsed ? (
            <button
              onClick={toggle}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-linear-to-br from-blue-50 to-blue-100 dark:from-blue-950 dark:to-blue-900 hover:opacity-80 transition-opacity"
              title="Expand sidebar"
            >
              <PocketBridgeIcon size={22} />
            </button>
          ) : (
            <>
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-blue-50 to-blue-100 dark:from-blue-950 dark:to-blue-900">
                  <PocketBridgeIcon size={28} />
                </div>
                <div className="min-w-0">
                  <h1 className="text-lg font-semibold text-sidebar-foreground truncate">PocketBridge</h1>
                  <p className="text-xs text-muted-foreground">Secure sync</p>
                </div>
              </div>
              <button
                onClick={toggle}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                title="Collapse sidebar"
              >
                <Pin className="h-4 w-4 rotate-45" />
              </button>
            </>
          )}
        </div>

        {/* Connection Status */}
        <div className={cn(
          "border-b border-sidebar-border",
          isCollapsed ? "flex justify-center py-3" : "px-6 py-4"
        )}>
          {isCollapsed ? (
            <div
              className={cn("h-3 w-3 rounded-full", getStatusDotColor())}
              title={getStatusLabel()}
            />
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className={cn("h-2.5 w-2.5 rounded-full shrink-0", getStatusDotColor())} />
                <span className="text-sm font-medium text-sidebar-foreground">{getStatusLabel()}</span>
              </div>
              {status === 'error' && error && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400 truncate">
                  {error.message}
                </p>
              )}
            </>
          )}
        </div>

        {/* Navigation */}
        <nav className={cn(
          "flex-1 space-y-1 overflow-y-auto py-4",
          isCollapsed ? "px-2" : "px-3"
        )}>
          {navItems.map((item) => {
            const isActive = pathname === item.href
            const Icon = item.icon

            return (
              <Link
                key={item.href}
                href={item.href}
                title={isCollapsed ? item.label : undefined}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  "flex items-center rounded-lg text-sm font-medium transition-colors",
                  isCollapsed
                    ? "justify-center h-10 w-full"
                    : "gap-3 px-3 py-2",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                )}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                {!isCollapsed && <span className="truncate">{item.label}</span>}
              </Link>
            )
          })}
        </nav>

      </div>
    </aside>
  )
}
