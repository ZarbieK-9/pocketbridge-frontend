/**
 * Helper to get shared encryption key
 * Caches the key to avoid repeated derivation
 */

import { loadIdentityKeyPair, deriveSharedEncryptionKey } from './keys';

let cachedKey: { key: CryptoKey; publicKeyHex: string } | null = null;

/**
 * Get the shared encryption key for the current user
 * This key is derived from the identity keypair and is the same
 * across all devices of the same user
 *
 * IMPORTANT: Validates cached key against current identity to handle
 * keypair changes (e.g., after pairing)
 */
export async function getSharedEncryptionKey(): Promise<CryptoKey | null> {
  const identityKeyPair = await loadIdentityKeyPair();
  if (!identityKeyPair) {
    return null;
  }

  // Check if cached key matches current identity
  if (cachedKey && cachedKey.publicKeyHex === identityKeyPair.publicKeyHex) {
    return cachedKey.key;
  }

  // Derive new key for current identity
  console.log('[getSharedEncryptionKey] Deriving new key for identity:', {
    publicKeyPrefix: identityKeyPair.publicKeyHex.substring(0, 16) + '...',
  });
  const key = await deriveSharedEncryptionKey(identityKeyPair);
  cachedKey = { key, publicKeyHex: identityKeyPair.publicKeyHex };
  console.log('[getSharedEncryptionKey] Key derived and cached');
  return key;
}

/**
 * Clear the cached key (useful for testing or key rotation)
 */
export function clearSharedKeyCache(): void {
  cachedKey = null;
}

/**
 * Check if the cached key matches the given public key
 * Useful for debugging
 */
export function getCachedKeyInfo(): { publicKeyHex: string } | null {
  return cachedKey ? { publicKeyHex: cachedKey.publicKeyHex } : null;
}

