/**
 * Background Sync Component
 * 
 * Automatically starts background clipboard sync when app loads
 * Works globally, not just on clipboard page
 */

'use client';

import { useEffect } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { useCrypto } from '@/hooks/use-crypto';
import { useBackgroundClipboard } from '@/hooks/use-background-clipboard';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getWsUrl } from '@/lib/utils/storage';
import { config } from '@/lib/config';

// Get WebSocket URL from storage/config helpers
function getWebSocketUrl(): string {
  return getWsUrl() || config.wsUrl;
}

export function BackgroundSync() {
  const deviceId = getOrCreateDeviceId();
  const wsUrl = getWebSocketUrl();
  // useWebSocket now handles waiting for crypto internally (waitForCrypto defaults to true)
  const { isConnected, sessionKeys, lastEvent } = useWebSocket({
    url: wsUrl,
    deviceId,
    autoConnect: true, // Hook will wait for crypto automatically
  });

  // Automatically start background clipboard sync
  useBackgroundClipboard({
    sessionKeys,
    isConnected,
    lastEvent,
  });

  // Request clipboard permissions on mount
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'clipboard' in navigator) {
      // Try to read clipboard to trigger permission request
      navigator.clipboard.readText().catch(() => {
        // Permission denied is expected - user will be prompted when needed
      });
    }
  }, []);

  return null; // This component doesn't render anything
}

