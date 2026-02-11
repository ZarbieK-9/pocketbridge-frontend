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
  console.log('[ScratchpadSync:SEND] sendYjsUpdate called, update size:', update.length);

  const sharedKey = await getSharedEncryptionKey();
  if (!sharedKey) {
    console.error('[ScratchpadSync:SEND] No shared encryption key!');
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

  console.log('[ScratchpadSync:SEND] Sending scratchpad_sync via WS, deviceId:', deviceId);

  // Send directly over WebSocket — server just relays, no storage
  wsClient.sendDirect({
    type: 'scratchpad_sync',
    payload: {
      encrypted_payload: encryptedPayload,
      device_id: deviceId,
    },
  });

  console.log('[ScratchpadSync:SEND] Message sent successfully');
}

/**
 * Receive Yjs update from event (works for both old events and new direct sync)
 */
export async function receiveYjsUpdate(
  event: EncryptedEvent,
): Promise<Uint8Array | null> {
  console.log('[ScratchpadSync:RECV] receiveYjsUpdate called, event type:', event.type, 'device_id:', event.device_id);

  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[ScratchpadSync:RECV] No shared encryption key!');
      return null;
    }

    console.log('[ScratchpadSync:RECV] Decrypting payload...');
    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as ScratchpadUpdatePayload;

    console.log('[ScratchpadSync:RECV] Decrypted OK, payload type:', payload.type);

    if (payload.type !== 'yjs_update') {
      console.warn('[ScratchpadSync:RECV] Unexpected payload type:', payload.type);
      return null;
    }

    const update = decodeYjsUpdate(payload.update);
    console.log('[ScratchpadSync:RECV] Decoded Yjs update, size:', update.length);
    return update;
  } catch (error) {
    console.error('[ScratchpadSync:RECV] Failed to decrypt Yjs update:', error);
    return null;
  }
}

/**
 * Apply Yjs update to document (from remote) and persist
 */
export async function applyYjsUpdate(update: Uint8Array): Promise<void> {
  console.log('[ScratchpadSync:APPLY] applyYjsUpdate called, update size:', update.length);
  if (!yjsDoc) {
    await initYjsDoc();
  }
  const Yjs = await getYjs();
  const textBefore = yjsText?.toString() || '';
  // Apply with 'remote' origin to avoid triggering onYjsUpdate send loop
  Yjs.applyUpdate(yjsDoc!, update, 'remote');
  const textAfter = yjsText?.toString() || '';
  console.log('[ScratchpadSync:APPLY] Text changed:', textBefore !== textAfter, '| before length:', textBefore.length, '| after length:', textAfter.length);

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

  // Compute minimal diff to avoid deleting+reinserting the entire document
  // This produces smaller Yjs updates and preserves CRDT history correctly
  yjsDoc!.transact(() => {
    // Find common prefix
    let prefixLen = 0;
    while (prefixLen < current.length && prefixLen < content.length && current[prefixLen] === content[prefixLen]) {
      prefixLen++;
    }

    // Find common suffix (after prefix)
    let suffixLen = 0;
    while (
      suffixLen < (current.length - prefixLen) &&
      suffixLen < (content.length - prefixLen) &&
      current[current.length - 1 - suffixLen] === content[content.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    // Delete the changed middle section
    const deleteLen = current.length - prefixLen - suffixLen;
    if (deleteLen > 0) {
      text.delete(prefixLen, deleteLen);
    }

    // Insert the new middle section
    const insertStr = content.slice(prefixLen, content.length - suffixLen);
    if (insertStr.length > 0) {
      text.insert(prefixLen, insertStr);
    }
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
  console.log('[ScratchpadSync:FULL] sendFullState called, yjsDoc exists:', !!yjsDoc);
  if (!yjsDoc) return;
  const Yjs = await getYjs();
  const state = Yjs.encodeStateAsUpdate(yjsDoc);
  console.log('[ScratchpadSync:FULL] Full state size:', state.length);
  if (state.length > 0) {
    await sendYjsUpdate(state);
    console.log('[ScratchpadSync:FULL] Full state sent');
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
    console.log('[ScratchpadSync:YJS] Yjs update event, origin:', origin, 'size:', update.length);
    // Don't send updates that originated from remote (to avoid loops)
    if (origin !== 'local') {
      console.log('[ScratchpadSync:YJS] Skipping non-local update');
      return;
    }
    console.log('[ScratchpadSync:YJS] Calling send callback for local update');
    // Call the (possibly async) callback — errors handled by caller's try/catch
    callback(update);
  };

  yjsDoc!.on('update', handler);

  // Return unsubscribe function
  return () => {
    yjsDoc?.off('update', handler);
  };
}
