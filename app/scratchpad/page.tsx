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
  getYjsTextContent,
  setYjsTextContent,
  sendYjsUpdate,
  receiveYjsUpdate,
  rebuildYjsFromEvents,
  onYjsUpdate,
  applyYjsUpdate,
} from '@/lib/features/scratchpad-yjs';
import { getOrCreateDeviceId } from '@/lib/utils/device';
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
  const { isConnected, sessionKeys, lastEvent } = useWebSocket({
    url: WS_URL,
    deviceId,
    autoConnect: cryptoInitialized && !!deviceId,
  });

  const [text, setText] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'sending' | 'synced' | 'error'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const yjsInitializedRef = useRef(false);

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
    if (!cryptoInitialized || yjsInitializedRef.current) return;

    let yjsTextInstance: any = null;
    let cancelled = false;

    async function setup() {
      try {
        await initYjsDoc();
        yjsTextInstance = await getYjsText();

        if (cancelled) return;

        // Listen for Yjs changes and update React state
        const observer = () => {
          if (yjsTextInstance) {
            setText(yjsTextInstance.toString());
          }
        };
        yjsTextInstance.observe(observer);
        yjsInitializedRef.current = true;

        // Load existing content from local store (works offline - no sessionKeys needed)
        try {
          const loadedText = await rebuildYjsFromEvents();
          if (!cancelled) {
            setText(loadedText);
          }
        } catch (error) {
          logger.error('[Scratchpad] Failed to load from local store:', error);
        }

        if (!cancelled) {
          setIsLoading(false);
        }

        return () => {
          if (yjsTextInstance) {
            yjsTextInstance.unobserve(observer);
          }
        };
      } catch (error) {
        logger.error('[Scratchpad] Failed to initialize Yjs:', error);
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    const cleanupPromise = setup();

    return () => {
      cancelled = true;
      cleanupPromise.then(cleanupFn => cleanupFn?.());
    };
  }, [cryptoInitialized]);

  // Set up sync sending when WebSocket is connected
  useEffect(() => {
    if (!sessionKeys || !yjsInitializedRef.current) return;

    let unsubscribe: (() => void) | null = null;

    async function setupSync() {
      unsubscribe = await onYjsUpdate(async (update) => {
        try {
          setSyncStatus('sending');
          await sendYjsUpdate(update);
          setLastSaved(new Date());
          setSyncStatus('synced');
        } catch (error) {
          logger.error('[Scratchpad] Failed to send Yjs update:', error);
          setSyncStatus('error');
        }
      });
      unsubscribeRef.current = unsubscribe;
    }

    setupSync();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [sessionKeys]);

  // Handle incoming Yjs updates (skip self-originated events)
  useEffect(() => {
    // Skip events from this device to avoid processing our own updates
    if (lastEvent && lastEvent.type === 'scratchpad:op' && sessionKeys && lastEvent.device_id !== deviceId) {
      handleIncomingUpdate(lastEvent);
    }
  }, [lastEvent, sessionKeys, deviceId]);

  async function handleIncomingUpdate(event: any) {
    try {
      const update = await receiveYjsUpdate(event);
      if (update) {
        // Apply update to Yjs document
        await applyYjsUpdate(update);
        setSyncStatus('synced');
        // Text will update via Yjs observer
      }
    } catch (error) {
      logger.error('[Scratchpad] Failed to apply update:', error);
      setSyncStatus('error');
    }
  }

  async function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newText = e.target.value;
    await setYjsTextContent(newText);
    // Yjs will trigger observer, which updates state
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
