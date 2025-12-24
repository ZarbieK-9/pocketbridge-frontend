/**
 * Helper to get shared encryption key
 * Caches the key to avoid repeated derivation
 */

import { loadIdentityKeyPair, deriveSharedEncryptionKey } from './keys';

let cachedKey: CryptoKey | null = null;

/**
 * Get the shared encryption key for the current user
 * This key is derived from the identity keypair and is the same
 * across all devices of the same user
 */
export async function getSharedEncryptionKey(): Promise<CryptoKey | null> {
  if (cachedKey) {
    return cachedKey;
  }

  const identityKeyPair = await loadIdentityKeyPair();
  if (!identityKeyPair) {
    return null;
  }

  cachedKey = await deriveSharedEncryptionKey(identityKeyPair);
  return cachedKey;
}

/**
 * Clear the cached key (useful for testing or key rotation)
 */
export function clearSharedKeyCache(): void {
  cachedKey = null;
}

