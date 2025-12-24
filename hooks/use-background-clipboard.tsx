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

    if (isConnected && sessionKeys && !startedRef.current) {
      // Start automatic monitoring
      sync.start(sessionKeys, onClipboardReceived).catch((error) => {
        console.error('[useBackgroundClipboard] Failed to start:', error);
      });
      startedRef.current = true;
    } else if (!isConnected && startedRef.current) {
      // Stop monitoring when disconnected
      sync.stop();
      startedRef.current = false;
    }

    // Cleanup on unmount
    return () => {
      if (startedRef.current) {
        sync.stop();
        startedRef.current = false;
      }
    };
  }, [isConnected, sessionKeys, onClipboardReceived]);

  // Handle incoming clipboard events
  useEffect(() => {
    if (lastEvent && lastEvent.type === 'clipboard:text' && sessionKeys) {
      syncRef.current.handleIncomingEvent(lastEvent).catch((error) => {
        console.error('[useBackgroundClipboard] Failed to handle event:', error);
      });
    }
  }, [lastEvent, sessionKeys]);
}

