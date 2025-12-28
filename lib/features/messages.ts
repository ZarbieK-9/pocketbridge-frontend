/**
 * Self-Destruct Messages Feature - Phase 1
 * 
 * One-time view messages with TTL
 * - TTL enforced via metadata
 * - Payload deletion handled client-side
 * - One-time view semantics
 */

import { createEvent } from '@/lib/sync/event-builder';
import { decryptPayload } from '@/lib/crypto/encryption';
import { getEventsByStream } from '@/lib/sync/db';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import type { EncryptedEvent, MessageSelfDestructPayload } from '@/types';

const MESSAGES_STREAM_ID = 'messages:main';

/**
 * Send self-destruct message
 */
export async function sendSelfDestructMessage(
  text: string,
  ttlSeconds: number,
): Promise<EncryptedEvent> {
  const deviceId = getOrCreateDeviceId();
  const expiresAt = Date.now() + ttlSeconds * 1000;
  
  const payload: MessageSelfDestructPayload = {
    text,
    expiresAt,
  };

  const event = await createEvent(
    MESSAGES_STREAM_ID,
    deviceId,
    'message:self_destruct',
    payload,
  );

  // Set TTL on event metadata
  return {
    ...event,
    ttl: expiresAt,
  };
}

/**
 * Receive self-destruct message
 */
export async function receiveSelfDestructMessage(
  event: EncryptedEvent,
): Promise<{ text: string; expiresAt: number } | null> {
  // Check TTL
  if (event.ttl && event.ttl < Date.now()) {
    console.log('[Messages] Message expired');
    return null;
  }

  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[Messages] Shared encryption key not available');
      return null;
    }

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as MessageSelfDestructPayload;

    // Check expiration
    if (payload.expiresAt < Date.now()) {
      return null;
    }

    return {
      text: payload.text,
      expiresAt: payload.expiresAt,
    };
  } catch (error) {
    console.error('[Messages] Failed to decrypt message:', error);
    return null;
  }
}

/**
 * Get all active messages (not expired)
 */
export async function getActiveMessages(): Promise<Array<{ eventId: string; text: string; expiresAt: number }>> {
  try {
    const events = await getEventsByStream(MESSAGES_STREAM_ID);
    const now = Date.now();
    
    const activeMessages = [];
    
    for (const event of events) {
      // Check TTL
      if (event.ttl && event.ttl < now) {
        continue;
      }

      // Skip deleted messages (check for payload_deleted flag or empty payload)
      if ((event as any).payload_deleted || !event.encrypted_payload || event.encrypted_payload === '') {
        continue;
      }

      const message = await receiveSelfDestructMessage(event);
      if (message) {
        activeMessages.push({
          eventId: event.event_id,
          text: message.text,
          expiresAt: message.expiresAt,
        });
      }
    }
    
    return activeMessages;
  } catch (error) {
    console.error('[Messages] Failed to get active messages:', error);
    return [];
  }
}

/**
 * Delete message payload (client-side)
 * Note: Event metadata remains, but payload is deleted
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
          // Mark payload as deleted by setting encrypted_payload to empty
          // Event metadata (event_id, device_seq, etc.) is preserved
          const updatedEvent = {
            ...event,
            encrypted_payload: '', // Clear payload
            payload_deleted: true, // Mark as deleted
            deleted_at: Date.now(), // Timestamp deletion
          };
          
          const updateRequest = store.put(updatedEvent);
          updateRequest.onsuccess = () => {
            console.log(`[Messages] Deleted payload for event ${eventId}`);
            resolve();
          };
          updateRequest.onerror = () => {
            reject(new Error('Failed to update event'));
          };
        } else {
          console.warn(`[Messages] Event ${eventId} not found`);
          resolve(); // Not an error if event doesn't exist
        }
      };
      
      request.onerror = () => {
        reject(new Error('Failed to get event'));
      };
    });
  } catch (error) {
    console.error(`[Messages] Failed to delete payload for event ${eventId}:`, error);
    throw error;
  }
}







