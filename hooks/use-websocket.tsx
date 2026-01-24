"use client"

/**
 * React hook for WebSocket connection - Phase 1
 * Manages connection lifecycle and provides status
 * Handles full handshake protocol
 */

import { useState, useEffect, useCallback } from 'react';
import { getWebSocketClient } from '@/lib/ws';
import { useCrypto } from '@/hooks/use-crypto';
import type { ConnectionStatus, EncryptedEvent, SessionKeys, SystemMessage } from '@/types';

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
  const logPrefix = '[useWebSocket]';
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<EncryptedEvent | null>(null);
  const [lastSystemMessage, setLastSystemMessage] = useState<SystemMessage | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sessionKeys, setSessionKeys] = useState<SessionKeys | null>(null);
  
  // Get crypto initialization state if we need to wait for it
  const { isInitialized: cryptoInitialized, error: cryptoError } = useCrypto();

  const connect = useCallback(async () => {
    // Guard: cannot connect without required parameters
    if (!url || !deviceId) {
      console.debug(logPrefix, 'connect aborted: missing params', { url, deviceId });
      return; // Gracefully no-op until params are available
    }

    // If we need to wait for crypto and it's not initialized, return early
    // The useEffect will re-trigger connect when cryptoInitialized changes
    // NOTE: We don't use a polling loop here because cryptoInitialized is captured
    // in the closure and won't update during the loop (stale closure bug)
    if (waitForCrypto && !cryptoInitialized) {
      if (cryptoError) {
        throw new Error(`Crypto initialization failed: ${cryptoError.message}`);
      }
      console.debug(logPrefix, 'connect deferred: waiting for crypto initialization');
      return; // Effect will re-run when cryptoInitialized becomes true
    }

    console.debug(logPrefix, 'connecting', { url, deviceId, waitForCrypto, cryptoInitialized });
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
    // If required params are missing, do not initialize the client
    if (!url || !deviceId) {
      console.debug(logPrefix, 'init aborted: missing params', { url, deviceId });
      setError(null);
      setStatus('disconnected');
      return;
    }

    const client = getWebSocketClient(url, deviceId);

    // Register handlers
    const unsubStatus = client.onStatus((newStatus) => {
      console.debug(logPrefix, 'status change', { newStatus });
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
    const unsubSystem = client.onSystem((message) => {
      setLastSystemMessage(message);
    });
    const unsubError = client.onError((err) => {
      console.error(logPrefix, 'client error', err);
      setError(err);
    });

    // Auto-connect if enabled and crypto is ready (if waitForCrypto is true)
    if (autoConnect) {
      if (waitForCrypto && !cryptoInitialized) {
        // Don't connect yet, wait for crypto to initialize
        // The effect will re-run when cryptoInitialized changes
      } else {
        console.debug(logPrefix, 'autoConnect -> connect()');
        connect();
      }
    }

    return () => {
      unsubStatus();
      unsubEvent();
      unsubSystem();
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
    lastSystemMessage,
  };
}
