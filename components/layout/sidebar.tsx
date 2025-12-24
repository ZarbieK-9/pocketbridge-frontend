"use client"

/**
 * Main sidebar navigation component
 */

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Clipboard, FileText, MessageSquare, FolderOpen, Settings, LayoutDashboard, KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"
import { StatusBadge } from "@/components/ui/status-badge"
import { useWebSocket } from "@/hooks/use-websocket"
import { useCrypto } from "@/hooks/use-crypto"
import { getOrCreateDeviceId } from "@/lib/utils/device"

// Get WebSocket URL from localStorage (set via QR pairing) or env var
function getWebSocketUrl(): string {
  if (typeof window !== 'undefined') {
    const storedUrl = localStorage.getItem('pocketbridge_ws_url');
    if (storedUrl) {
      return storedUrl;
    }
  }
  return process.env.NEXT_PUBLIC_WS_URL || 'wss://backend-production-7f7ab.up.railway.app/ws';
}

function getBackendApiUrlFromWs(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const isSecure = u.protocol === 'wss:';
    const httpProtocol = isSecure ? 'https:' : 'http:';
    // Remove trailing /ws if present
    const basePath = u.pathname.replace(/\/?ws$/, '');
    return `${httpProtocol}//${u.host}${basePath}`;
  } catch {
    return process.env.NEXT_PUBLIC_API_URL || 'https://backend-production-7f7ab.up.railway.app';
  }
}

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/clipboard", label: "Clipboard", icon: Clipboard },
  { href: "/scratchpad", label: "Scratchpad", icon: FileText },
  { href: "/messages", label: "Messages", icon: MessageSquare },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/pair", label: "Pair Device", icon: KeyRound },
]

export function Sidebar() {
  const pathname = usePathname()
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

  // Map ConnectionStatus to StatusBadge status
  let displayStatus: "online" | "offline" | "syncing" | "error" | "ready";
  let displayMessage: string;

  switch (status) {
    case 'connected':
      displayStatus = connectedDevices > 0 ? 'online' : 'ready';
      displayMessage = connectedDevices > 0 ? 'Connected to backend' : 'Ready — waiting for devices';
      break;
    case 'connecting':
    case 'reconnecting':
      displayStatus = 'syncing';
      displayMessage = status === 'reconnecting' ? 'Reconnecting to backend...' : 'Connecting to backend...';
      break;
    case 'disconnected':
      displayStatus = 'offline';
      displayMessage = 'Disconnected from backend';
      break;
    case 'error':
      displayStatus = 'error';
      displayMessage = error?.message || 'Connection error';
      break;
    default:
      displayStatus = 'offline';
      displayMessage = 'Unknown status';
  }

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 border-r border-border bg-sidebar">
      <div className="flex h-full flex-col">
        {/* Logo/Brand */}
        <div className="flex h-16 items-center border-b border-sidebar-border px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
              <span className="text-xl font-bold text-primary-foreground">P</span>
            </div>
            <div>
              <h1 className="text-lg font-semibold text-sidebar-foreground">PocketBridge</h1>
              <p className="text-xs text-muted-foreground">v1.0.0</p>
            </div>
          </div>
        </div>

        {/* Connection Status */}
        <div className="border-b border-sidebar-border px-6 py-4">
          <StatusBadge status={displayStatus} className="w-full justify-center" />
          <p className="mt-2 text-xs text-center text-muted-foreground">
            {displayMessage}
          </p>
          {status === 'error' && error && (
            <p className="mt-1 text-xs text-center text-red-600 dark:text-red-400">
              {error.message}
            </p>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {navItems.map((item) => {
            const isActive = pathname === item.href
            const Icon = item.icon

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                )}
              >
                <Icon className="h-5 w-5" />
                <span>{item.label}</span>
              </Link>
            )
          })}
        </nav>

        {/* Footer Info */}
        <div className="border-t border-sidebar-border p-4">
          <div className="text-xs text-muted-foreground">
            <div className="mb-1 font-medium">Device</div>
            <div className="truncate">Desktop - {new Date().toLocaleDateString()}</div>
          </div>
        </div>
      </div>
    </aside>
  )
}
