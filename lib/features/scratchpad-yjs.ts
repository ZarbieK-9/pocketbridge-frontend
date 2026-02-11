/**
 * Live Scratchpad Feature - Simplified Direct Sync
 *
 * CRDT-based collaborative text editor using Yjs
 * - Direct WebSocket relay (no event queue, no device_seq, no ACKs)
 * - localStorage persistence for Yjs CRDT state
 * - Yjs handles convergence natively
 */

// Dynamic import to avoid SSR issues
let Y: typeof import('yjs') | null = null;

async function getYjs() {
  if (!Y) {
    Y = await import('yjs');
  }
  return Y;
}
import { encryptPayload, decryptPayload, uint8ArrayToBase64 } from '@/lib/crypto/encryption';
import { getEventsByStream } from '@/lib/sync/db';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getWebSocketClient } from '@/lib/ws';
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import type { EncryptedEvent, ScratchpadUpdatePayload } from '@/types';

const SCRATCHPAD_STREAM_ID = 'scratchpad:main';
const YJS_STATE_KEY = 'pocketbridge_yjs_state';

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
  return uint8ArrayToBase64(update);
}

/**
 * Decode base64 to Yjs update
 */
export function decodeYjsUpdate(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return new Uint8Array(binary.split('').map(c => c.charCodeAt(0)));
}

/**
 * Save Yjs document state to localStorage
 */
export async function saveYjsState(): Promise<void> {
  if (!yjsDoc) return;
  try {
    const Yjs = await getYjs();
    const state = Yjs.encodeStateAsUpdate(yjsDoc);
    const base64 = uint8ArrayToBase64(state);
    localStorage.setItem(YJS_STATE_KEY, base64);
  } catch (error) {
    console.error('[Scratchpad] Failed to save Yjs state:', error);
  }
}

/**
 * Load Yjs document state from localStorage
 * Returns the text content, or null if no saved state
 */
export async function loadYjsState(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  try {
    const saved = localStorage.getItem(YJS_STATE_KEY);
    if (!saved) return null;

    if (!yjsDoc) {
      await initYjsDoc();
    }

    const Yjs = await getYjs();
    const state = decodeYjsUpdate(saved);
    Yjs.applyUpdate(yjsDoc!, state, 'remote');

    return yjsText!.toString();
  } catch (error) {
    console.error('[Scratchpad] Failed to load Yjs state:', error);
    return null;
  }
}

/**
 * Send Yjs update directly via WebSocket
 * Bypasses event queue — no device_seq, no IndexedDB, no ACKs
 *
 * Throws on failure so caller can distinguish success from failure.
 * Local persistence (saveYjsState) is handled separately by the caller
 * so state is saved even when the network send fails.
 */
export async function sendYjsUpdate(update: Uint8Array): Promise<void> {
  const sharedKey = await getSharedEncryptionKey();
  if (!sharedKey) {
    throw new Error('Shared encryption key not available');
  }

  const payload: ScratchpadUpdatePayload = {
    update: encodeYjsUpdate(update),
    type: 'yjs_update',
  };

  // Encrypt payload with shared key (E2E encryption)
  const { ciphertext, nonce } = await encryptPayload(payload, sharedKey);

  // Combine nonce + ciphertext into single base64 string (same format as regular events)
  const nonceBytes = new Uint8Array(
    nonce.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );
  const ciphertextBytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const combined = new Uint8Array(nonceBytes.length + ciphertextBytes.length);
  combined.set(nonceBytes, 0);
  combined.set(ciphertextBytes, nonceBytes.length);
  const encryptedPayload = uint8ArrayToBase64(combined);

  const deviceId = getOrCreateDeviceId();
  const wsClient = getWebSocketClient();

  // Send directly over WebSocket — server just relays, no storage
  wsClient.sendDirect({
    type: 'scratchpad_sync',
    payload: {
      encrypted_payload: encryptedPayload,
      device_id: deviceId,
    },
  });
}

/**
 * Receive Yjs update from event (works for both old events and new direct sync)
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
 * Apply Yjs update to document (from remote) and persist
 */
export async function applyYjsUpdate(update: Uint8Array): Promise<void> {
  if (!yjsDoc) {
    await initYjsDoc();
  }
  const Yjs = await getYjs();
  // Apply with 'remote' origin to avoid triggering onYjsUpdate send loop
  Yjs.applyUpdate(yjsDoc!, update, 'remote');

  // Persist state after receiving remote update
  await saveYjsState();
}

/**
 * Set text in Yjs document (replaces all)
 */
export async function setYjsTextContent(content: string): Promise<void> {
  if (!yjsDoc) {
    await initYjsDoc();
  }
  const text = await getYjsText();
  const current = text.toString();

  if (current === content) {
    return; // No change
  }

  // Wrap in transaction with 'local' origin so onYjsUpdate handler fires
  yjsDoc!.transact(() => {
    text.delete(0, current.length);
    text.insert(0, content);
  }, 'local');
}

/**
 * Rebuild Yjs document from stored events (migration fallback)
 * Used when no localStorage state exists but old events are in IndexedDB
 */
export async function rebuildYjsFromEvents(): Promise<string> {
  try {
    if (!yjsDoc) {
      await initYjsDoc();
    }

    const wsClient = getWebSocketClient();
    const userId = wsClient.getUserId();

    const events = await getEventsByStream(SCRATCHPAD_STREAM_ID, userId || undefined);
    events.sort((a, b) => a.stream_seq - b.stream_seq);

    const Yjs = await getYjs();

    for (const event of events) {
      const update = await receiveYjsUpdate(event);
      if (update) {
        Yjs.applyUpdate(yjsDoc!, update, 'remote');
      }
    }

    const content = yjsText!.toString();

    // Migrate: save to localStorage so we don't need events next time
    if (content) {
      await saveYjsState();
    }

    return content;
  } catch (error) {
    console.error('[Scratchpad] Failed to rebuild Yjs document:', error);
    return '';
  }
}

/**
 * Send the full Yjs document state to other devices.
 * Used on initial connection so the remote device gets all content,
 * not just incremental updates from new keystrokes.
 */
export async function sendFullState(): Promise<void> {
  if (!yjsDoc) return;
  const Yjs = await getYjs();
  const state = Yjs.encodeStateAsUpdate(yjsDoc);
  if (state.length > 0) {
    await sendYjsUpdate(state);
  }
}

/**
 * Listen for Yjs updates and send them
 */
export async function onYjsUpdate(
  callback: (update: Uint8Array) => Promise<void> | void
): Promise<() => void> {
  if (!yjsDoc) {
    await initYjsDoc();
  }

  const handler = (update: Uint8Array, origin: any) => {
    // Don't send updates that originated from remote (to avoid loops)
    if (origin !== 'local') {
      return;
    }
    // Call the (possibly async) callback — errors handled by caller's try/catch
    callback(update);
  };

  yjsDoc!.on('update', handler);

  // Return unsubscribe function
  return () => {
    yjsDoc?.off('update', handler);
  };
}
