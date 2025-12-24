/**
 * Event builder utilities - Phase 1
 * 
 * Creates encrypted events with Phase 1 structure:
 * - event_id: UUIDv7 (time-ordered)
 * - user_id: Ed25519 public key (hex)
 * - device_id: UUIDv4
 * - device_seq: Monotonic per device
 * - stream_id: Feature-specific
 * - stream_seq: Server-assigned (set to 0 initially, server assigns)
 * - encrypted_payload: Base64-encoded AES-GCM ciphertext (includes nonce and tag)
 */

import { generateUUIDv7 } from '@/lib/utils/uuid';
import { encryptPayload } from '@/lib/crypto/encryption';
import { getEventQueue } from './queue';
import { loadIdentityKeyPair, deriveSharedEncryptionKey } from '@/lib/crypto/keys';
import type { EncryptedEvent, EventPayload, EventType } from '@/types';

/**
 * Build an encrypted event - Phase 1
 * 
 * Uses shared encryption key derived from identity keypair.
 * All devices with the same identity keypair can encrypt/decrypt each other's events.
 */
export async function buildEvent(
  streamId: string,
  deviceId: string,
  type: EventType,
  payload: EventPayload,
): Promise<EncryptedEvent> {
  const queue = getEventQueue();

  // Load identity keypair for user_id
  const identityKeyPair = await loadIdentityKeyPair();
  if (!identityKeyPair) {
    throw new Error('Identity keypair not found. Initialize crypto first.');
  }

  // Derive shared encryption key from identity keypair
  // All devices with the same identity keypair will derive the same key
  const sharedKey = await deriveSharedEncryptionKey(identityKeyPair);

  // Encrypt payload with shared key (AES-GCM)
  // encryptPayload returns { ciphertext, nonce }
  // We need to combine them into a single encrypted_payload
  const { ciphertext, nonce } = await encryptPayload(payload, sharedKey);

  // Combine nonce + ciphertext (AES-GCM includes auth tag at end)
  // Format: nonce (12 bytes) + ciphertext (includes 16-byte auth tag)
  // nonce is hex string, ciphertext is base64 string
  const nonceBytes = new Uint8Array(
    nonce.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );
  // Decode base64 ciphertext to bytes
  const ciphertextBytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const combined = new Uint8Array(nonceBytes.length + ciphertextBytes.length);
  combined.set(nonceBytes, 0);
  combined.set(ciphertextBytes, nonceBytes.length);
  
  // Base64 encode the combined payload
  const encryptedPayload = btoa(
    String.fromCharCode(...combined)
  );

  // Build event with Phase 1 structure
  const event: EncryptedEvent = {
    event_id: generateUUIDv7(),
    user_id: identityKeyPair.publicKeyHex,
    device_id: deviceId,
    device_seq: queue.getNextSeq(),
    stream_id: streamId,
    stream_seq: 0, // Server will assign this
    type,
    encrypted_payload: encryptedPayload,
    // ttl optional
  };

  return event;
}

/**
 * Create and enqueue an event
 */
export async function createEvent(
  streamId: string,
  deviceId: string,
  type: EventType,
  payload: EventPayload,
): Promise<EncryptedEvent> {
  const event = await buildEvent(streamId, deviceId, type, payload);
  const queue = getEventQueue();
  await queue.enqueue(event);
  return event;
}
