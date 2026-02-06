/**
 * Secret Chat Messages Feature
 *
 * Real-time encrypted chat between paired devices.
 * Uses `message:text` events on the `messages:main` stream,
 * compatible with the mobile agent's chat implementation.
 *
 * Also supports legacy `message:self_destruct` events for
 * backward compatibility with previously sent messages.
 */

import { createEvent } from '@/lib/sync/event-builder';
import { decryptPayload } from '@/lib/crypto/encryption';
import { getEventsByStream } from '@/lib/sync/db';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import { getWebSocketClient } from '@/lib/ws';
import type {
  EncryptedEvent,
  MessageTextPayload,
  MessageSelfDestructPayload,
} from '@/types';

const MESSAGES_STREAM_ID = 'messages:main';

export interface ChatMessage {
  id: string;
  text: string;
  timestamp: number;
  deviceId: string;
  isLocal: boolean;
}

/**
 * Send a chat message
 */
export async function sendChatMessage(text: string): Promise<EncryptedEvent> {
  const deviceId = getOrCreateDeviceId();
  const wsClient = getWebSocketClient();
  const userId = wsClient.getUserId() || undefined;

  const payload: MessageTextPayload = { text };

  const event = await createEvent(
    MESSAGES_STREAM_ID,
    deviceId,
    'message:text',
    payload,
    userId,
  );

  await wsClient.syncPending();
  return event;
}

/**
 * Decrypt a single chat event into a ChatMessage
 */
export async function decryptChatEvent(
  event: EncryptedEvent,
): Promise<ChatMessage | null> {
  if (!event.encrypted_payload || event.encrypted_payload === '') return null;
  if ((event as any).payload_deleted) return null;

  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) return null;

    const localDeviceId = getOrCreateDeviceId();

    if (event.type === 'message:text') {
      const payload = (await decryptPayload(
        event.encrypted_payload,
        sharedKey,
      )) as MessageTextPayload;

      return {
        id: event.event_id,
        text: payload.text,
        timestamp: event.created_at || Date.now(),
        deviceId: event.device_id,
        isLocal: event.device_id === localDeviceId,
      };
    }

    // Legacy: support self-destruct messages as regular chat bubbles
    if (event.type === 'message:self_destruct') {
      const payload = (await decryptPayload(
        event.encrypted_payload,
        sharedKey,
      )) as MessageSelfDestructPayload;

      if (payload.expiresAt < Date.now()) return null;

      return {
        id: event.event_id,
        text: payload.text,
        timestamp: event.created_at || Date.now(),
        deviceId: event.device_id,
        isLocal: event.device_id === localDeviceId,
      };
    }

    return null;
  } catch (error) {
    console.error('[Chat] Failed to decrypt event:', error);
    return null;
  }
}

/**
 * Load all chat messages from IndexedDB
 */
export async function loadChatHistory(): Promise<ChatMessage[]> {
  try {
    const events = await getEventsByStream(MESSAGES_STREAM_ID);
    const now = Date.now();
    const messages: ChatMessage[] = [];

    for (const event of events) {
      if (event.ttl && event.ttl < now) continue;
      const msg = await decryptChatEvent(event);
      if (msg) messages.push(msg);
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);
    return messages;
  } catch (error) {
    console.error('[Chat] Failed to load history:', error);
    return [];
  }
}

/**
 * Delete a message payload (client-side only)
 */
export async function deleteMessagePayload(eventId: string): Promise<void> {
  try {
    const { getDatabase } = await import('@/lib/sync/db');
    const { STORE_EVENTS } = await import('@/lib/constants');
    const db = await getDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_EVENTS], 'readwrite');
      const store = transaction.objectStore(STORE_EVENTS);
      const request = store.get(eventId);

      request.onsuccess = () => {
        const event = request.result;
        if (event) {
          const updatedEvent = {
            ...event,
            encrypted_payload: '',
            payload_deleted: true,
            deleted_at: Date.now(),
          };

          const updateRequest = store.put(updatedEvent);
          updateRequest.onsuccess = () => resolve();
          updateRequest.onerror = () => reject(new Error('Failed to update event'));
        } else {
          resolve();
        }
      };

      request.onerror = () => reject(new Error('Failed to get event'));
    });
  } catch (error) {
    console.error(`[Chat] Failed to delete payload for event ${eventId}:`, error);
    throw error;
  }
}
