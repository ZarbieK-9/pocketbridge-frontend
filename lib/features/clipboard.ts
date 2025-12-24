/**
 * Clipboard Sync Feature - Phase 1
 * 
 * Event-based clipboard synchronization
 * - Last-write-wins per stream
 * - Text only (Phase 1)
 * - Encrypted end-to-end
 */

import { createEvent } from '@/lib/sync/event-builder';
import { decryptPayload } from '@/lib/crypto/encryption';
import { getEventsByStream } from '@/lib/sync/db';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import type { EncryptedEvent, ClipboardTextPayload } from '@/types';

const CLIPBOARD_STREAM_ID = 'clipboard:main';

/**
 * Send clipboard text to other devices
 */
export async function sendClipboardText(
  text: string,
): Promise<EncryptedEvent> {
  const deviceId = getOrCreateDeviceId();
  
  const payload: ClipboardTextPayload = {
    text,
    source: 'browser',
  };

  return await createEvent(
    CLIPBOARD_STREAM_ID,
    deviceId,
    'clipboard:text',
    payload,
  );
}

/**
 * Receive clipboard text from event
 */
export async function receiveClipboardText(
  event: EncryptedEvent,
): Promise<string | null> {
  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[Clipboard] Shared encryption key not available');
      return null;
    }

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as ClipboardTextPayload;

    return payload.text;
  } catch (error) {
    console.error('[Clipboard] Failed to decrypt clipboard event:', error);
    return null;
  }
}

/**
 * Get latest clipboard text from stream
 */
export async function getLatestClipboardText(): Promise<string | null> {
  try {
    const events = await getEventsByStream(CLIPBOARD_STREAM_ID);
    
    if (events.length === 0) {
      return null;
    }

    // Sort by stream_seq (descending) to get latest
    events.sort((a, b) => b.stream_seq - a.stream_seq);
    const latestEvent = events[0];

    return await receiveClipboardText(latestEvent);
  } catch (error) {
    console.error('[Clipboard] Failed to get latest clipboard:', error);
    return null;
  }
}

/**
 * Monitor browser clipboard and sync changes
 */
export class ClipboardMonitor {
  private lastClipboardText: string = '';
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onClipboardChange?: (text: string) => void;

  /**
   * Start monitoring clipboard
   */
  start(onChange?: (text: string) => void): void {
    this.onClipboardChange = onChange;
    
    // Poll clipboard every 500ms
    this.intervalId = setInterval(async () => {
      await this.checkClipboard();
    }, 500);
  }

  /**
   * Stop monitoring clipboard
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Check clipboard for changes
   */
  private async checkClipboard(): Promise<void> {
    try {
      // Read clipboard (requires clipboard-read permission)
      const text = await navigator.clipboard.readText();
      
      if (text !== this.lastClipboardText && text.length > 0) {
        this.lastClipboardText = text;
        
        // Send to other devices
        await sendClipboardText(text);
        
        // Notify handler
        if (this.onClipboardChange) {
          this.onClipboardChange(text);
        }
      }
    } catch (error) {
      // Clipboard API may not be available or permission denied
      // This is expected in some contexts
      if (error instanceof Error && error.name !== 'NotAllowedError') {
        console.error('[Clipboard] Failed to read clipboard:', error);
      }
    }
  }

  /**
   * Write text to clipboard (with user consent)
   */
  async writeToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      this.lastClipboardText = text;
      return true;
    } catch (error) {
      console.error('[Clipboard] Failed to write to clipboard:', error);
      return false;
    }
  }
}







