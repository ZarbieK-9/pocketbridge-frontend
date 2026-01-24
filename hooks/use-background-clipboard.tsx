/**
 * Hook for automatic background clipboard sync
 * 
 * Automatically starts monitoring and syncing clipboard when:
 * - WebSocket is connected
 * - Session keys are available
 * - User has granted clipboard permissions
 * 
 * Works in background, no user interaction needed
 */

import { useEffect, useRef } from 'react';
import { getBackgroundClipboardSync } from '@/lib/background/clipboard-sync';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import type { SessionKeys, EncryptedEvent } from '@/types';

interface UseBackgroundClipboardOptions {
  sessionKeys: SessionKeys | null;
  isConnected: boolean;
  lastEvent: EncryptedEvent | null;
  onClipboardReceived?: (text: string) => void;
}

/**
 * Hook for automatic background clipboard sync
 */
export function useBackgroundClipboard({
  sessionKeys,
  isConnected,
  lastEvent,
  onClipboardReceived,
}: UseBackgroundClipboardOptions): void {
  const syncRef = useRef(getBackgroundClipboardSync());
  const startedRef = useRef(false);

  // Start/stop monitoring based on connection state
  useEffect(() => {
    const sync = syncRef.current;
    let isMounted = true;

    if (isConnected && sessionKeys && !startedRef.current) {
      // Start automatic monitoring (wait for completion before marking started)
      sync.start(sessionKeys, onClipboardReceived)
        .then(() => {
          if (isMounted) {
            startedRef.current = true;
          }
        })
        .catch((error) => {
          console.error('[useBackgroundClipboard] Failed to start:', error);
        });
    } else if (!isConnected && startedRef.current) {
      // Stop monitoring when disconnected
      sync.stop();
      startedRef.current = false;
    }

    // Cleanup on unmount
    return () => {
      isMounted = false;
      if (startedRef.current) {
        sync.stop();
        startedRef.current = false;
      }
    };
  }, [isConnected, sessionKeys, onClipboardReceived]);

  // Handle incoming clipboard events (skip self-originated events)
  useEffect(() => {
    const deviceId = getOrCreateDeviceId();

    // Skip events from this device to avoid processing our own clipboard changes
    // Also check startedRef to ensure sync.start() has completed (sets sessionKeys internally)
    if (lastEvent && lastEvent.type === 'clipboard:text' && sessionKeys && startedRef.current && lastEvent.device_id !== deviceId) {
      syncRef.current.handleIncomingEvent(lastEvent).catch((error) => {
        console.error('[useBackgroundClipboard] Failed to handle event:', error);
      });
    }
  }, [lastEvent, sessionKeys]);
}

