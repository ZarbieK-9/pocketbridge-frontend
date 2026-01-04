/**
 * AES-GCM encryption and decryption utilities - Phase 1
 * 
 * Phase 1 format: encrypted_payload is base64-encoded combination of:
 * - nonce (12 bytes / 96 bits for AES-GCM)
 * - ciphertext (includes 16-byte authentication tag at the end)
 * 
 * This matches the backend expectation.
 */

import { generateNonce } from './nonce';
import type { EventPayload } from '@/types';

/**
 * Encrypt a payload using AES-256-GCM
 * Returns combined nonce + ciphertext as base64 string
 */
export async function encryptPayload(
  payload: EventPayload,
  key: CryptoKey,
): Promise<{ ciphertext: string; nonce: string }> {
  // Serialize payload to JSON
  const payloadStr = JSON.stringify(payload);
  const payloadBuffer = new TextEncoder().encode(payloadStr);

  // Generate a unique nonce for this encryption (12 bytes = 96 bits)
  const nonce = generateNonce();
  const nonceBuffer = new Uint8Array(
    nonce.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );

  // Encrypt with AES-GCM (includes authentication tag)
  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonceBuffer,
      tagLength: 128, // 128-bit authentication tag
    },
    key,
    payloadBuffer,
  );

  // Convert to base64
  const ciphertextArray = new Uint8Array(ciphertextBuffer);
  const ciphertext = btoa(String.fromCharCode(...ciphertextArray));

  return { ciphertext, nonce };
}

/**
 * Decrypt a combined encrypted payload (nonce + ciphertext)
 * 
 * Phase 1 format: base64 string containing nonce (12 bytes) + ciphertext (with auth tag)
 */
export async function decryptPayload(
  encryptedPayload: string,
  key: CryptoKey,
): Promise<EventPayload> {
  // Decode base64
  const combined = Uint8Array.from(atob(encryptedPayload), c => c.charCodeAt(0));

  // Extract nonce (first 12 bytes)
  const nonceBuffer = combined.slice(0, 12);
  
  // Extract ciphertext (rest, includes 16-byte auth tag)
  const ciphertextBuffer = combined.slice(12);

  try {
    // Decrypt with AES-GCM
    const payloadBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonceBuffer,
        tagLength: 128,
      },
      key,
      ciphertextBuffer,
    );

    const payloadStr = new TextDecoder().decode(payloadBuffer);
    return JSON.parse(payloadStr) as EventPayload;
  } catch (error) {
    // Don't log decryption errors here - let the caller decide how to handle them
    // This prevents console spam when decrypting events from other sessions
    throw new Error('Failed to decrypt payload: invalid key or corrupted data');
  }
}

/**
 * Decrypt from separate nonce and ciphertext (legacy format support)
 */
export async function decryptPayloadLegacy(
  ciphertext: string,
  nonce: string,
  key: CryptoKey,
): Promise<EventPayload> {
  const ciphertextBuffer = new Uint8Array(
    ciphertext.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );
  const nonceBuffer = new Uint8Array(
    nonce.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );

  try {
    const payloadBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonceBuffer,
        tagLength: 128,
      },
      key,
      ciphertextBuffer,
    );

    const payloadStr = new TextDecoder().decode(payloadBuffer);
    return JSON.parse(payloadStr) as EventPayload;
  } catch (error) {
    // Don't log decryption errors here - let the caller decide how to handle them
    // This prevents console spam when decrypting events from other sessions
    throw new Error('Failed to decrypt payload: invalid key or corrupted data');
  }
}
