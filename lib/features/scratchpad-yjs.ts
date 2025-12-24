/**
 * Live Scratchpad Feature - Phase 1 (Yjs Implementation)
 * 
 * CRDT-based collaborative text editor using Yjs
 * - Offline edits converge
 * - Real-time synchronization
 * - Battle-tested CRDT library
 * 
 * CRDT Choice: Yjs
 * - Mature, battle-tested
 * - Efficient binary format
 * - Good offline support
 * - Text editing optimized
 * - Used by many production apps
 */

// Dynamic import to avoid SSR issues
let Y: typeof import('yjs') | null = null;

async function getYjs() {
  if (!Y) {
    Y = await import('yjs');
  }
  return Y;
}
import { createEvent } from '@/lib/sync/event-builder';
import { decryptPayload } from '@/lib/crypto/encryption';
import { getEventsByStream } from '@/lib/sync/db';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import type { EncryptedEvent, ScratchpadUpdatePayload } from '@/types';

const SCRATCHPAD_STREAM_ID = 'scratchpad:main';

/**
 * Yjs document for scratchpad
 */
let yjsDoc: any = null;
let yjsText: any = null;

/**
 * Initialize Yjs document
 */
export async function initYjsDoc(): Promise<any> {
  if (!yjsDoc) {
    const Yjs = await getYjs();
    yjsDoc = new Yjs.Doc();
    yjsText = yjsDoc.getText('content');
  }
  return yjsDoc;
}

/**
 * Get Yjs text object
 */
export async function getYjsText(): Promise<any> {
  if (!yjsText) {
    await initYjsDoc();
  }
  return yjsText!;
}

/**
 * Convert Yjs update to base64 for transmission
 */
export function encodeYjsUpdate(update: Uint8Array): string {
  return btoa(String.fromCharCode(...update));
}

/**
 * Decode base64 to Yjs update
 */
export function decodeYjsUpdate(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return new Uint8Array(binary.split('').map(c => c.charCodeAt(0)));
}

/**
 * Send Yjs update as event
 */
export async function sendYjsUpdate(
  update: Uint8Array,
): Promise<EncryptedEvent> {
  const deviceId = getOrCreateDeviceId();
  
  const payload: ScratchpadUpdatePayload = {
    update: encodeYjsUpdate(update),
    type: 'yjs_update',
  };

  return await createEvent(
    SCRATCHPAD_STREAM_ID,
    deviceId,
    'scratchpad:op',
    payload,
  );
}

/**
 * Receive Yjs update from event
 */
export async function receiveYjsUpdate(
  event: EncryptedEvent,
): Promise<Uint8Array | null> {
  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[Scratchpad] Shared encryption key not available');
      return null;
    }

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as ScratchpadUpdatePayload;

    if (payload.type !== 'yjs_update') {
      return null;
    }

    return decodeYjsUpdate(payload.update);
  } catch (error) {
    console.error('[Scratchpad] Failed to decrypt Yjs update:', error);
    return null;
  }
}

/**
 * Apply Yjs update to document
 */
export async function applyYjsUpdate(update: Uint8Array): Promise<void> {
  if (!yjsDoc) {
    await initYjsDoc();
  }
  const Yjs = await getYjs();
  Yjs.applyUpdate(yjsDoc!, update);
}

/**
 * Get current text from Yjs document
 */
export async function getYjsTextContent(): Promise<string> {
  const text = await getYjsText();
  return text.toString();
}

/**
 * Set text in Yjs document (replaces all)
 */
export async function setYjsTextContent(content: string): Promise<void> {
  const text = await getYjsText();
  const current = text.toString();
  
  if (current === content) {
    return; // No change
  }

  // Delete all and insert new content
  text.delete(0, current.length);
  text.insert(0, content);
}

/**
 * Rebuild Yjs document from all events
 */
export async function rebuildYjsFromEvents(): Promise<string> {
  try {
    const events = await getEventsByStream(SCRATCHPAD_STREAM_ID);
    events.sort((a, b) => a.stream_seq - b.stream_seq);

    // Initialize fresh document
    const Yjs = await getYjs();
    const doc = new Yjs.Doc();
    const text = doc.getText('content');

    // Apply all updates in order
    for (const event of events) {
      const update = await receiveYjsUpdate(event);
      if (update) {
        Yjs.applyUpdate(doc, update);
      }
    }

    // Store document
    yjsDoc = doc;
    yjsText = text;

    return text.toString();
  } catch (error) {
    console.error('[Scratchpad] Failed to rebuild Yjs document:', error);
    return '';
  }
}

/**
 * Listen for Yjs updates and send them
 */
export async function onYjsUpdate(
  callback: (update: Uint8Array) => void
): Promise<() => void> {
  if (!yjsDoc) {
    await initYjsDoc();
  }

  const handler = (update: Uint8Array, origin: any) => {
    // Don't send updates that originated from remote (to avoid loops)
    if (origin !== 'local') {
      return;
    }
    callback(update);
  };

  yjsDoc!.on('update', handler);

  // Return unsubscribe function
  return () => {
    yjsDoc?.off('update', handler);
  };
}

