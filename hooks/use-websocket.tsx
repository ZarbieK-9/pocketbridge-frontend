"use client"

/**
 * React hook for WebSocket connection - Phase 1
 * Manages connection lifecycle and provides status
 * Handles full handshake protocol
 */

import { useState, useEffect, useCallback } from 'react';
import { getWebSocketClient } from '@/lib/ws';
import type { ConnectionStatus, EncryptedEvent, SessionKeys } from '@/types';

interface UseWebSocketOptions {
  url: string;
  deviceId: string;
  autoConnect?: boolean;
}

export function useWebSocket({ url, deviceId, autoConnect = true }: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<EncryptedEvent | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sessionKeys, setSessionKeys] = useState<SessionKeys | null>(null);

  const connect = useCallback(async () => {
    const client = getWebSocketClient(url, deviceId);
    await client.connect();
  }, [url, deviceId]);

  const disconnect = useCallback(() => {
    const client = getWebSocketClient(url, deviceId);
    client.disconnect();
  }, [url, deviceId]);

  const sendEvent = useCallback(
    async (event: EncryptedEvent) => {
      const client = getWebSocketClient(url, deviceId);
      await client.sendEvent(event);
    },
    [url, deviceId],
  );

  const syncPending = useCallback(async () => {
    const client = getWebSocketClient(url, deviceId);
    await client.syncPending();
  }, [url, deviceId]);

  useEffect(() => {
    const client = getWebSocketClient(url, deviceId);

    // Register handlers
    const unsubStatus = client.onStatus((newStatus) => {
      setStatus(newStatus);
      // Update session keys when connected
      if (newStatus === 'connected') {
        const keys = client.getSessionKeys();
        setSessionKeys(keys);
      } else {
        setSessionKeys(null);
      }
    });
    const unsubEvent = client.onEvent((event) => {
      setLastEvent(event);
    });
    const unsubError = client.onError((err) => {
      setError(err);
    });

    // Auto-connect if enabled
    if (autoConnect) {
      connect();
    }

    return () => {
      unsubStatus();
      unsubEvent();
      unsubError();
    };
  }, [url, deviceId, autoConnect, connect]);

  return {
    status,
    lastEvent,
    error,
    sessionKeys,
    connect,
    disconnect,
    sendEvent,
    syncPending,
    isConnected: status === 'connected',
  };
}
