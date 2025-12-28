"use client"

/**
 * Clipboard Sync Page - Phase 1
 * 
 * Displays and manages clipboard synchronization
 * - Shows current clipboard content
 * - Syncs changes across devices
 * - Last-write-wins semantics
 */

import { useEffect, useState, useRef } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { useCrypto } from '@/hooks/use-crypto';
import { SyncIndicator } from '@/components/sync-indicator';
import { toast } from '@/components/ui/toast';
import { useBackgroundClipboard } from '@/hooks/use-background-clipboard';
import { getBackgroundClipboardSync } from '@/lib/background/clipboard-sync';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/ui/status-badge';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001/ws';

export default function ClipboardPage() {
  const deviceId = getOrCreateDeviceId();
  const { isInitialized: cryptoInitialized, identityKeyPair } = useCrypto();
  const { isConnected, sessionKeys, lastEvent, sendEvent } = useWebSocket({
    url: WS_URL,
    deviceId,
    autoConnect: cryptoInitialized,
  });

  const [clipboardText, setClipboardText] = useState<string>('');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'sending' | 'synced' | 'error'>('idle');
  const syncRef = useRef(getBackgroundClipboardSync());

  // Use automatic background clipboard sync (Apple-like)
  useBackgroundClipboard({
    sessionKeys,
    isConnected,
    lastEvent,
    onClipboardReceived: (text) => {
      setClipboardText(text);
      setSyncStatus('synced');
      toast('Clipboard synced across all devices', 'success');
    },
  });

  // Track sync status when clipboard changes
  useEffect(() => {
    if (lastEvent && lastEvent.type === 'clipboard:text') {
      setSyncStatus('synced');
    }
  }, [lastEvent]);

  // Update UI with current clipboard state
  useEffect(() => {
    const sync = syncRef.current;
    setClipboardText(sync.lastClipboardText);
    
    // Poll for updates every 2 seconds
    const interval = setInterval(() => {
      setClipboardText(sync.lastClipboardText);
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  async function handleManualPaste() {
    try {
      const text = await navigator.clipboard.readText();
      setClipboardText(text);
    } catch (error) {
      console.error('Failed to read clipboard:', error);
      alert('Clipboard access denied. Please grant clipboard-read permission.');
    }
  }

  async function handleCopy() {
    if (!clipboardText) return;
    
    try {
      await navigator.clipboard.writeText(clipboardText);
    } catch (error) {
      console.error('Failed to write clipboard:', error);
    }
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
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Clipboard Sync</h1>
        <div className="flex items-center gap-2">
          <StatusBadge status={isConnected ? 'online' : 'offline'} />
          <div className="text-sm text-muted-foreground">
            {syncRef.current.isMonitoring ? '✓ Auto-syncing' : 'Waiting for connection...'}
          </div>
        </div>
      </div>

      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Current Clipboard</h2>
          <div className="flex items-center gap-3">
            <SyncIndicator status={syncStatus} />
            <div className="flex gap-2">
              <Button onClick={handleManualPaste} variant="outline">
                Read Clipboard
              </Button>
              <Button onClick={handleCopy} disabled={!clipboardText}>
                Copy to Clipboard
              </Button>
            </div>
          </div>
        </div>

        <Textarea
          value={clipboardText}
          onChange={(e) => setClipboardText(e.target.value)}
          placeholder="Clipboard content will appear here..."
          className="min-h-[200px] font-mono"
        />

        <div className="text-sm text-muted-foreground">
          <p>
            {syncRef.current.isMonitoring
              ? '✓ Automatic sync active. Copy on laptop → paste on phone automatically!'
              : 'Waiting for connection...'}
          </p>
          <p className="mt-2">
            Works in background - no need to keep app open. Just like Apple's ecosystem!
          </p>
        </div>
      </Card>
    </div>
  );
}
