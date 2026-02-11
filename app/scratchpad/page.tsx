"use client"

/**
 * Live Scratchpad Page - Phase 1 (Yjs Implementation)
 *
 * CRDT-based collaborative text editor using Yjs
 * - Real-time synchronization
 * - Offline edit convergence
 */

import { useEffect, useState, useRef } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { useCrypto } from '@/hooks/use-crypto';
import { logger } from '@/lib/utils/logger';
import {
  initYjsDoc,
  getYjsText,
  setYjsTextContent,
  sendYjsUpdate,
  sendFullState,
  saveYjsState,
  receiveYjsUpdate,
  loadYjsState,
  rebuildYjsFromEvents,
  onYjsUpdate,
  applyYjsUpdate,
} from '@/lib/features/scratchpad-yjs';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getWebSocketClient } from '@/lib/ws';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/ui/status-badge';
import { Save } from 'lucide-react';
import { config } from '@/lib/config';
import { analytics } from '@/lib/utils/analytics';
import { SyncIndicator } from '@/components/sync-indicator';

const WS_URL = config.wsUrl;

export default function ScratchpadPage() {
  const [deviceId, setDeviceId] = useState<string>('');
  const { isInitialized: cryptoInitialized } = useCrypto();
  const { isConnected, sessionKeys } = useWebSocket({
    url: WS_URL,
    deviceId,
    autoConnect: cryptoInitialized && !!deviceId,
  });

  const [text, setText] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'sending' | 'synced' | 'error'>('idle');
  const [yjsInitialized, setYjsInitialized] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Initialize deviceId on client only (avoid SSR hydration mismatch)
  useEffect(() => {
    setDeviceId(getOrCreateDeviceId());
  }, []);

  // Track page view
  useEffect(() => {
    analytics.page('Scratchpad');
  }, []);

  // Initialize Yjs document and load from local store (works offline)
  useEffect(() => {
    if (!cryptoInitialized || yjsInitialized) return;

    let cancelled = false;

    async function setup() {
      try {
        await initYjsDoc();

        // Load existing content: try localStorage first, then fall back to IndexedDB events
        try {
          let loadedText = await loadYjsState();
          if (loadedText === null) {
            // No localStorage state — migrate from old IndexedDB events
            loadedText = await rebuildYjsFromEvents();
          }
          if (!cancelled) {
            setText(loadedText);
          }
        } catch (error) {
          logger.error('[Scratchpad] Failed to load from local store:', error);
        }

        if (!cancelled) {
          setYjsInitialized(true);
          setIsLoading(false);
        }
      } catch (error) {
        logger.error('[Scratchpad] Failed to initialize Yjs:', error);
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    setup();

    return () => {
      cancelled = true;
    };
  }, [cryptoInitialized, yjsInitialized]);

  // Observe Yjs text changes and update React state
  // Separate effect so the observer persists beyond initialization
  useEffect(() => {
    if (!yjsInitialized) return;

    let yjsTextInstance: any = null;
    let observer: (() => void) | null = null;
    let cancelled = false;

    async function attachObserver() {
      yjsTextInstance = await getYjsText();
      if (cancelled) return;

      observer = () => {
        if (yjsTextInstance) {
          console.log('[ScratchpadSync:OBSERVER] Yjs text changed, updating React state');
          setText(yjsTextInstance.toString());
        }
      };
      yjsTextInstance.observe(observer);
      console.log('[ScratchpadSync:OBSERVER] Observer attached');
    }

    attachObserver();

    return () => {
      cancelled = true;
      if (yjsTextInstance && observer) {
        yjsTextInstance.unobserve(observer);
        console.log('[ScratchpadSync:OBSERVER] Observer detached');
      }
    };
  }, [yjsInitialized]);

  // Set up sync sending when WebSocket is connected AND Yjs is ready
  // Both conditions must be true — using yjsInitialized (state, not ref)
  // ensures this effect re-runs when Yjs finishes async initialization
  useEffect(() => {
    console.log('[ScratchpadSync:PAGE] Send effect check — sessionKeys:', !!sessionKeys, 'yjsInitialized:', yjsInitialized);
    if (!sessionKeys || !yjsInitialized) return;

    let cancelled = false;

    async function setupSync() {
      console.log('[ScratchpadSync:PAGE] Setting up sync sending...');
      // Register the Yjs update listener
      const unsub = await onYjsUpdate(async (update) => {
        // Always persist locally, regardless of send outcome
        await saveYjsState();
        try {
          setSyncStatus('sending');
          console.log('[ScratchpadSync:PAGE] Sending Yjs update, size:', update.length);
          await sendYjsUpdate(update);
          setLastSaved(new Date());
          setSyncStatus('synced');
          console.log('[ScratchpadSync:PAGE] Update sent OK');
        } catch (error) {
          logger.error('[Scratchpad] Failed to send Yjs update:', error);
          console.error('[ScratchpadSync:PAGE] Send FAILED:', error);
          setSyncStatus('error');
        }
      });

      // Guard: if effect was cleaned up while we were awaiting, remove the listener immediately
      if (cancelled) {
        unsub();
        return;
      }
      unsubscribeRef.current = unsub;

      // Send the full Yjs document state so the other device gets all existing content
      try {
        console.log('[ScratchpadSync:PAGE] Sending full state on connect...');
        await sendFullState();
        console.log('[ScratchpadSync:PAGE] Full state sent OK');
      } catch (error) {
        // Non-fatal: incremental updates will still work
        console.warn('[ScratchpadSync:PAGE] Failed to send full state:', error);
        logger.warn('[Scratchpad] Failed to send full state on connect:', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    setupSync();

    return () => {
      cancelled = true;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [sessionKeys, yjsInitialized]);

  // Handle incoming Yjs updates via direct WS client handler
  // This avoids the lastEvent race where a non-scratchpad event can overwrite
  // lastEvent before React re-renders, causing scratchpad events to be lost
  useEffect(() => {
    console.log('[ScratchpadSync:PAGE] Receive effect check — sessionKeys:', !!sessionKeys, 'deviceId:', deviceId, 'yjsInitialized:', yjsInitialized);
    if (!sessionKeys || !deviceId || !yjsInitialized) return;

    console.log('[ScratchpadSync:PAGE] Registering incoming event handler, local deviceId:', deviceId);
    const client = getWebSocketClient();
    const unsubscribe = client.onEvent(async (event) => {
      if (event.type !== 'scratchpad:op') return;
      console.log('[ScratchpadSync:PAGE] Got scratchpad:op event, from device:', event.device_id, 'local device:', deviceId);
      if (event.device_id === deviceId) {
        console.log('[ScratchpadSync:PAGE] Skipping own event');
        return;
      }

      try {
        console.log('[ScratchpadSync:PAGE] Processing remote update...');
        const update = await receiveYjsUpdate(event);
        if (update) {
          await applyYjsUpdate(update);
          setSyncStatus('synced');
          console.log('[ScratchpadSync:PAGE] Remote update applied successfully');
        } else {
          console.warn('[ScratchpadSync:PAGE] receiveYjsUpdate returned null');
        }
      } catch (error) {
        logger.error('[Scratchpad] Failed to apply update:', error);
        console.error('[ScratchpadSync:PAGE] Failed to apply update:', error);
        setSyncStatus('error');
      }
    });

    return unsubscribe;
  }, [sessionKeys, deviceId, yjsInitialized]);

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newText = e.target.value;
    // Update React state immediately so the controlled textarea stays responsive
    setText(newText);
    // Then update Yjs (async) — Yjs observer will also call setText, but with the same value
    setYjsTextContent(newText);
  }

  if (!cryptoInitialized) {
    return (
      <div className="container mx-auto p-4 sm:p-6">
        <Card className="p-6">
          <p>Initializing cryptography...</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-3 sm:space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <h1 className="text-2xl sm:text-3xl font-bold">Live Scratchpad</h1>
        <div className="flex items-center gap-2 sm:gap-3">
          <SyncIndicator status={syncStatus} />
          <StatusBadge status={isConnected ? 'online' : 'offline'} />
          {lastSaved && (
            <span className="text-xs sm:text-sm text-muted-foreground flex items-center gap-1">
              <Save className="h-3 w-3 sm:h-4 sm:w-4" />
              {lastSaved.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      <Card className="border-none shadow-none">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center min-h-[50vh] text-muted-foreground">
              Loading scratchpad...
            </div>
          ) : (
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={handleTextChange}
              placeholder="Start typing... your notes sync in real-time across all devices"
              className="min-h-[calc(100vh-14rem)] sm:min-h-[calc(100vh-12rem)] resize-none border-0 focus-visible:ring-0 font-mono text-sm"
            />
          )}
        </CardContent>
      </Card>

      <div className="text-xs sm:text-sm text-muted-foreground">
        <p>
          {isConnected
            ? 'Connected. Changes sync automatically using Yjs CRDT.'
            : 'Offline. Changes will sync when reconnected.'}
        </p>
      </div>
    </div>
  );
}
