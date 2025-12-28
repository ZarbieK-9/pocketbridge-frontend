"use client"

/**
 * React hook for WebSocket connection - Phase 1
 * Manages connection lifecycle and provides status
 * Handles full handshake protocol
 */

import { useState, useEffect, useCallback } from 'react';
import { getWebSocketClient } from '@/lib/ws';
import { useCrypto } from '@/hooks/use-crypto';
import type { ConnectionStatus, EncryptedEvent, SessionKeys } from '@/types';

interface UseWebSocketOptions {
  url: string;
  deviceId: string;
  autoConnect?: boolean;
  waitForCrypto?: boolean; // If true, waits for crypto initialization before connecting
}

export function useWebSocket({ 
  url, 
  deviceId, 
  autoConnect = true,
  waitForCrypto = true, // Default to true for safety
}: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<EncryptedEvent | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sessionKeys, setSessionKeys] = useState<SessionKeys | null>(null);
  
  // Get crypto initialization state if we need to wait for it
  const { isInitialized: cryptoInitialized, error: cryptoError } = useCrypto();

  const connect = useCallback(async () => {
    // If we need to wait for crypto and it's not initialized, wait or throw
    if (waitForCrypto && !cryptoInitialized) {
      if (cryptoError) {
        throw new Error(`Crypto initialization failed: ${cryptoError.message}`);
      }
      // Wait a bit for crypto to initialize (with timeout)
      const maxWait = 5000; // 5 seconds
      const startTime = Date.now();
      while (!cryptoInitialized && (Date.now() - startTime) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if (!cryptoInitialized) {
        throw new Error('Crypto initialization timeout. Please ensure crypto is initialized before connecting.');
      }
    }
    
    const client = getWebSocketClient(url, deviceId);
    await client.connect();
  }, [url, deviceId, waitForCrypto, cryptoInitialized, cryptoError]);

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

    // Auto-connect if enabled and crypto is ready (if waitForCrypto is true)
    if (autoConnect) {
      if (waitForCrypto && !cryptoInitialized) {
        // Don't connect yet, wait for crypto to initialize
        // The effect will re-run when cryptoInitialized changes
      } else {
        connect();
      }
    }

    return () => {
      unsubStatus();
      unsubEvent();
      unsubError();
    };
  }, [url, deviceId, autoConnect, connect, waitForCrypto, cryptoInitialized]);

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
