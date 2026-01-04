'use client';

/**
 * Offline Indicator Component
 * 
 * Shows network status and offline mode messaging
 */

import { useEffect, useState } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { Wifi, WifiOff } from 'lucide-react';
import { useWebSocket } from '@/hooks/use-websocket';
import { config } from '@/lib/config';
import { getOrCreateDeviceId } from '@/lib/utils/device';

export function OfflineIndicator() {
  const [isOnline, setIsOnline] = useState(true);
  const deviceId = getOrCreateDeviceId();
  const { isConnected } = useWebSocket({
    url: config.wsUrl,
    deviceId,
    autoConnect: true,
  });

  useEffect(() => {
    // Check initial online status
    setIsOnline(navigator.onLine);

    // Listen for online/offline events
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Don't show if online and connected
  if (isOnline && isConnected) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className="flex items-center gap-2 bg-background border rounded-lg shadow-lg p-3">
        {isOnline ? (
          <>
            <Wifi className="h-4 w-4 text-muted-foreground" />
            <StatusBadge status="syncing" />
            <span className="text-sm text-muted-foreground">
              Connecting...
            </span>
          </>
        ) : (
          <>
            <WifiOff className="h-4 w-4 text-destructive" />
            <StatusBadge status="offline" />
            <span className="text-sm text-muted-foreground">
              Offline - Changes will sync when online
            </span>
          </>
        )}
      </div>
    </div>
  );
}



