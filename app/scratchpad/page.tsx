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
import { useEffect } from 'react';

const WS_URL = config.wsUrl;

export default function ScratchpadPage() {
  const deviceId = getOrCreateDeviceId();
  const { isInitialized: cryptoInitialized } = useCrypto();
  const { isConnected, sessionKeys, lastEvent } = useWebSocket({
    url: WS_URL,
    deviceId,
    autoConnect: cryptoInitialized,
  });

  const [text, setText] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Track page view
  useEffect(() => {
    analytics.page('Scratchpad');
  }, []);

  // Initialize Yjs document
  useEffect(() => {
    let yjsTextInstance: any = null;
    let unsubscribe: (() => void) | null = null;

    async function setup() {
      await initYjsDoc();
      yjsTextInstance = await getYjsText();

      // Listen for Yjs changes and update React state
      const observer = () => {
        if (yjsTextInstance) {
          setText(yjsTextInstance.toString());
        }
      };
      yjsTextInstance.observe(observer);

      // Listen for Yjs updates to send
      if (sessionKeys) {
        unsubscribe = await onYjsUpdate(async (update) => {
          try {
            await sendYjsUpdate(update);
            setLastSaved(new Date());
          } catch (error) {
            console.error('[Scratchpad] Failed to send Yjs update:', error);
          }
        });
        unsubscribeRef.current = unsubscribe;
      }

      return () => {
        if (yjsTextInstance) {
          yjsTextInstance.unobserve(observer);
        }
        if (unsubscribe) {
          unsubscribe();
        }
      };
    }

    const cleanup = setup();

    return () => {
      cleanup.then(cleanupFn => cleanupFn?.());
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, [sessionKeys]);

  // Load scratchpad text on mount
  useEffect(() => {
    if (sessionKeys) {
      loadScratchpad();
    }
  }, [sessionKeys]);

  // Handle incoming Yjs updates
  useEffect(() => {
    if (lastEvent && lastEvent.type === 'scratchpad:op' && sessionKeys) {
      handleIncomingUpdate(lastEvent);
    }
  }, [lastEvent, sessionKeys]);

  async function loadScratchpad() {
    if (!sessionKeys) return;

    setIsLoading(true);
    try {
      const loadedText = await rebuildYjsFromEvents();
      setText(loadedText);
    } catch (error) {
      console.error('[Scratchpad] Failed to load:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleIncomingUpdate(event: any) {
    try {
      const update = await receiveYjsUpdate(event);
      if (update) {
        // Apply update to Yjs document
        await applyYjsUpdate(update);
        // Text will update via Yjs observer
      }
    } catch (error) {
      console.error('[Scratchpad] Failed to apply update:', error);
    }
  }

  async function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newText = e.target.value;
    await setYjsTextContent(newText);
    // Yjs will trigger observer, which updates state
  }

  if (!cryptoInitialized) {
    return (
      <div className="container mx-auto p-6">
        <Card className="p-6">
          <p>Initializing cryptography...</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Live Scratchpad</h1>
        <div className="flex items-center gap-2">
          <StatusBadge status={isConnected ? 'online' : 'offline'} />
          {lastSaved && (
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <Save className="h-4 w-4" />
              Saved {lastSaved.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      <Card className="border-none shadow-none">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">
              Loading scratchpad...
            </div>
          ) : (
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={handleTextChange}
              placeholder="Start typing... your notes sync in real-time across all devices"
              className="min-h-[calc(100vh-12rem)] resize-none border-0 focus-visible:ring-0 font-mono text-sm"
            />
          )}
        </CardContent>
      </Card>

      <div className="text-sm text-muted-foreground">
        <p>
          {isConnected
            ? '✓ Connected. Changes sync automatically using Yjs CRDT.'
            : '⚠ Disconnected. Changes will sync when reconnected.'}
        </p>
        <p className="mt-2">
          Offline edits converge automatically using Yjs CRDT.
        </p>
      </div>
    </div>
  );
}
