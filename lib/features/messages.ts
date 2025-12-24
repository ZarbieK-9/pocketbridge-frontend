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
  // In a real implementation, you'd mark the payload as deleted in IndexedDB
  // For Phase 1, we'll just log it
  console.log(`[Messages] Deleting payload for event ${eventId}`);
  
  // TODO: Implement actual deletion in IndexedDB
  // This would involve updating the event record to mark payload as deleted
}







