"use client"

/**
 * Cryptographic key generation and management - Phase 1
 * 
 * Uses Ed25519 for identity keys (via @noble/ed25519 polyfill)
 * Web Crypto API doesn't natively support Ed25519
 */

import * as nacl from 'tweetnacl';
import { STORAGE_KEYS } from '@/lib/constants';
import type { Ed25519KeyPair } from '@/types';

// Using tweetnacl exclusively to avoid SHA-512 noble initialization complexity

// Cache for shared encryption key (derived from identity keypair)
let cachedSharedKey: { publicKeyHex: string; key: CryptoKey } | null = null;

// Pending derivation promise to prevent race conditions
// If two calls happen concurrently, the second one awaits the first instead of deriving separately
let pendingDerivation: { publicKeyHex: string; promise: Promise<CryptoKey> } | null = null;

/**
 * Clear the cached shared encryption key
 * Call this when the identity keypair changes (e.g., after pairing)
 */
export function clearCachedSharedKey(): void {
  cachedSharedKey = null;
  pendingDerivation = null;
}

/**
 * Generate an Ed25519 keypair for device identity
 * Uses @noble/ed25519 polyfill since Web Crypto API doesn't support Ed25519
 */
export async function generateIdentityKeyPair(): Promise<Ed25519KeyPair> {
  console.log('[generateIdentityKeyPair] Generating new Ed25519 keypair (tweetnacl)...');
  const seed = nacl.randomBytes(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const publicKeyHex = Array.from(kp.publicKey)
    .map((b: number) => (b as number).toString(16).padStart(2, '0'))
    .join('');
  const privateKeyHex = Array.from(seed)
    .map((b: number) => (b as number).toString(16).padStart(2, '0'))
    .join('');
  console.log('[generateIdentityKeyPair] Keypair generated successfully (tweetnacl):', {
    publicKeyHex: publicKeyHex.substring(0, 16) + '...',
    privateKeyLength: seed.length,
    publicKeyLength: kp.publicKey.length,
  });
  return {
    publicKey: kp.publicKey,
    privateKey: seed,
    publicKeyHex,
    privateKeyHex,
  };
}

/**
 * Sign data with Ed25519 private key
 */
export async function signEd25519(
  privateKey: Uint8Array,
  data: Uint8Array | string
): Promise<Uint8Array> {
  const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const kp = nacl.sign.keyPair.fromSeed(privateKey);
  return nacl.sign.detached(dataBytes, kp.secretKey);
}

/**
 * Verify Ed25519 signature
 */
export async function verifyEd25519(
  signature: Uint8Array,
  data: Uint8Array | string,
  publicKey: Uint8Array
): Promise<boolean> {
  const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return nacl.sign.detached.verify(dataBytes, signature, publicKey);
}

/**
 * Save identity keypair to localStorage
 */
export function saveIdentityKeyPair(keyPair: Ed25519KeyPair): void {
  if (typeof window === 'undefined') {
    console.error('[saveIdentityKeyPair] Cannot save: window is undefined');
    return;
  }

  console.log('[saveIdentityKeyPair] Saving keypair to localStorage', {
    publicKeyPrefix: keyPair.publicKeyHex?.substring(0, 16) + '...',
    hasPrivateKey: !!keyPair.privateKeyHex,
  });

  const keyData = {
    publicKeyHex: keyPair.publicKeyHex,
    privateKeyHex: keyPair.privateKeyHex,
  };

  localStorage.setItem(STORAGE_KEYS.IDENTITY_KEYPAIR, JSON.stringify(keyData));

  // Clear cached shared key since identity changed
  clearCachedSharedKey();

  // CRITICAL: Clear the shared-key module's cache SYNCHRONOUSLY
  // Previously this was async (dynamic import) which caused a race condition:
  // Code could call getSharedEncryptionKey() before the cache was cleared,
  // returning a stale key that couldn't decrypt events from the new identity
  try {
    // Use require-style pattern that's synchronous in webpack/next.js bundles
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharedKeyModule = require('./shared-key');
    sharedKeyModule.clearSharedKeyCache();
    console.log('[saveIdentityKeyPair] Cleared shared key caches synchronously');
  } catch (err) {
    // Fallback to async import if synchronous require fails
    console.warn('[saveIdentityKeyPair] Sync require failed, trying async import:', err);
    import('./shared-key').then(({ clearSharedKeyCache }) => {
      clearSharedKeyCache();
      console.log('[saveIdentityKeyPair] Cleared shared key caches (async fallback)');
    }).catch(importErr => {
      console.error('[saveIdentityKeyPair] Could not clear shared-key cache:', importErr);
    });
  }

  // CRITICAL: Reset event queue and sequence counters SYNCHRONOUSLY when identity changes
  // This prevents "Device sequence not monotonic" errors after pairing
  // We do this synchronously because page may reload immediately after pairing
  try {
    localStorage.removeItem('pocketbridge_device_seq');
    localStorage.removeItem('pocketbridge_last_ack_seq');
    console.log('[saveIdentityKeyPair] Reset event queue counters synchronously for new identity');
  } catch (err) {
    console.warn('[saveIdentityKeyPair] Could not reset event queue counters:', err);
  }

  // CRITICAL: Clear IndexedDB events from old identity
  // These events are encrypted with the OLD key and cannot be decrypted with the NEW key
  // We do this asynchronously but fire-and-forget since the key change is already saved
  import('@/lib/sync/db').then(async ({ deleteOrphanedEvents, clearDatabase }) => {
    try {
      // Delete events that don't belong to the new identity
      const deletedCount = await deleteOrphanedEvents(keyPair.publicKeyHex);
      console.log('[saveIdentityKeyPair] Deleted orphaned events from old identity:', deletedCount);

      // Also clear the entire database if there were orphaned events
      // This ensures a clean slate for the new identity
      if (deletedCount > 0) {
        console.log('[saveIdentityKeyPair] Clearing remaining IndexedDB data for clean start');
        await clearDatabase();
        console.log('[saveIdentityKeyPair] IndexedDB cleared successfully');
      }
    } catch (dbErr) {
      console.error('[saveIdentityKeyPair] Failed to clean up IndexedDB:', dbErr);
    }
  }).catch(importErr => {
    console.error('[saveIdentityKeyPair] Could not import db module for cleanup:', importErr);
  });

  // Verify save succeeded
  const saved = localStorage.getItem(STORAGE_KEYS.IDENTITY_KEYPAIR);
  if (saved) {
    const parsed = JSON.parse(saved);
    console.log('[saveIdentityKeyPair] Verified save succeeded', {
      savedPublicKeyPrefix: parsed.publicKeyHex?.substring(0, 16) + '...',
    });
  } else {
    console.error('[saveIdentityKeyPair] FAILED: Key not found after save!');
  }
}

/**
 * Load identity keypair from localStorage
 */
export async function loadIdentityKeyPair(): Promise<Ed25519KeyPair | null> {
  if (typeof window === 'undefined') return null;

  const keyDataStr = localStorage.getItem(STORAGE_KEYS.IDENTITY_KEYPAIR);
  if (!keyDataStr) return null;

  try {
    const keyData = JSON.parse(keyDataStr);
    
    const publicKey = new Uint8Array(
      keyData.publicKeyHex.match(/.{1,2}/g)?.map((byte: string) => parseInt(byte, 16)) || []
    );
    const privateKey = new Uint8Array(
      keyData.privateKeyHex.match(/.{1,2}/g)?.map((byte: string) => parseInt(byte, 16)) || []
    );

    // DEBUG: Log loaded keypair info for troubleshooting
    const pkFingerprint = Array.from(privateKey.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
    console.log('[loadIdentityKeyPair] Loaded keypair:', {
      publicKeyPrefix: keyData.publicKeyHex.substring(0, 16) + '...',
      privateKeyLength: privateKey.length,
      privateKeyFingerprint: pkFingerprint + '...',
    });

    return {
      publicKey,
      privateKey,
      publicKeyHex: keyData.publicKeyHex,
      privateKeyHex: keyData.privateKeyHex,
    };
  } catch (error) {
    console.error('[Phase1] Failed to load identity keypair:', error);
    return null;
  }
}

/**
 * Generate an AES-256-GCM symmetric key for event encryption
 * NOTE: In Phase 1, we use session keys derived from handshake, not a single symmetric key
 * This is kept for backward compatibility during migration
 */
export async function generateSymmetricKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true, // extractable
    ['encrypt', 'decrypt']
  );
}

/**
 * Import AES key from raw bytes
 */
export async function importAESKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  // Create a new ArrayBuffer to avoid SharedArrayBuffer issues
  const buffer = new Uint8Array(keyBytes).buffer;
  return await crypto.subtle.importKey(
    'raw',
    buffer,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Export AES key to raw bytes
 */
export async function exportAESKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

/**
 * Backup current identity keypair before pairing
 * This allows restoring the original identity if the device is revoked
 */
export function backupIdentityKeyPair(): boolean {
  if (typeof window === 'undefined') {
    console.error('[backupIdentityKeyPair] Cannot backup: window is undefined');
    return false;
  }

  const currentKeyData = localStorage.getItem(STORAGE_KEYS.IDENTITY_KEYPAIR);
  if (!currentKeyData) {
    console.log('[backupIdentityKeyPair] No identity to backup');
    return false;
  }

  // Don't overwrite existing backup (preserve the original identity)
  const existingBackup = localStorage.getItem(STORAGE_KEYS.IDENTITY_KEYPAIR_BACKUP);
  if (existingBackup) {
    console.log('[backupIdentityKeyPair] Backup already exists, preserving original');
    return true;
  }

  localStorage.setItem(STORAGE_KEYS.IDENTITY_KEYPAIR_BACKUP, currentKeyData);
  console.log('[backupIdentityKeyPair] Identity backed up successfully');
  return true;
}

/**
 * Restore the backed-up identity keypair (or generate new one)
 * Used when device is revoked to return to unpaired state
 */
export async function restoreOrGenerateIdentity(): Promise<Ed25519KeyPair> {
  if (typeof window === 'undefined') {
    throw new Error('Cannot restore identity: window is undefined');
  }

  const backupData = localStorage.getItem(STORAGE_KEYS.IDENTITY_KEYPAIR_BACKUP);

  if (backupData) {
    try {
      const keyData = JSON.parse(backupData);
      const publicKey = new Uint8Array(
        keyData.publicKeyHex.match(/.{1,2}/g)?.map((byte: string) => parseInt(byte, 16)) || []
      );
      const privateKey = new Uint8Array(
        keyData.privateKeyHex.match(/.{1,2}/g)?.map((byte: string) => parseInt(byte, 16)) || []
      );

      const restoredKeyPair: Ed25519KeyPair = {
        publicKey,
        privateKey,
        publicKeyHex: keyData.publicKeyHex,
        privateKeyHex: keyData.privateKeyHex,
      };

      // Save as current identity
      saveIdentityKeyPair(restoredKeyPair);

      // Clear the backup since we've restored it
      localStorage.removeItem(STORAGE_KEYS.IDENTITY_KEYPAIR_BACKUP);

      console.log('[restoreOrGenerateIdentity] Restored backed-up identity', {
        publicKeyPrefix: keyData.publicKeyHex.substring(0, 16) + '...',
      });

      return restoredKeyPair;
    } catch (error) {
      console.error('[restoreOrGenerateIdentity] Failed to parse backup, generating new identity:', error);
    }
  }

  // No backup found or failed to parse, generate new identity
  console.log('[restoreOrGenerateIdentity] No backup found, generating new identity');
  const newKeyPair = await generateIdentityKeyPair();
  saveIdentityKeyPair(newKeyPair);
  return newKeyPair;
}

/**
 * Clear the identity backup (call after successful pairing if desired)
 */
export function clearIdentityBackup(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEYS.IDENTITY_KEYPAIR_BACKUP);
  console.log('[clearIdentityBackup] Identity backup cleared');
}

/**
 * Check if device has a backed-up identity
 */
export function hasIdentityBackup(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEYS.IDENTITY_KEYPAIR_BACKUP) !== null;
}

/**
 * Derive a shared encryption key from identity keypair
 *
 * All devices with the same identity keypair will derive the same encryption key.
 * This allows cross-device event encryption/decryption.
 *
 * Uses HKDF with:
 * - Input: Identity private key (32 bytes)
 * - Salt: SHA256("pocketbridge_shared_key_v1" || publicKeyHex)
 * - Info: "pocketbridge_event_encryption_v1"
 * - Output: 32 bytes (AES-256 key)
 *
 * The key is cached per public key to avoid repeated derivation.
 */
export async function deriveSharedEncryptionKey(
  identityKeyPair: Ed25519KeyPair
): Promise<CryptoKey> {
  // Check cache first
  if (cachedSharedKey && cachedSharedKey.publicKeyHex === identityKeyPair.publicKeyHex) {
    return cachedSharedKey.key;
  }

  // Check if there's already a pending derivation for this key
  // This prevents race conditions where two concurrent calls both derive separately
  if (pendingDerivation && pendingDerivation.publicKeyHex === identityKeyPair.publicKeyHex) {
    return pendingDerivation.promise;
  }

  // Start derivation and store the promise so concurrent calls can await it
  const derivationPromise = (async () => {
    // Use private key as input material (all devices of same user have same private key)
    // Create a new Uint8Array to ensure we have a clean buffer
    const privateKeyBytes = new Uint8Array(identityKeyPair.privateKey);
    const privateKeyBuffer = privateKeyBytes.buffer;

    // DEBUG: Log private key fingerprint for troubleshooting key mismatch
    const pkFingerprint = Array.from(privateKeyBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
    console.log('[deriveSharedEncryptionKey] Using private key:', {
      length: privateKeyBytes.length,
      fingerprint: pkFingerprint + '...',
      publicKeyPrefix: identityKeyPair.publicKeyHex.substring(0, 16) + '...',
    });

    // Salt = SHA256("pocketbridge_shared_key_v1" || publicKeyHex)
    const saltPrefix = new TextEncoder().encode('pocketbridge_shared_key_v1');
    const publicKeyBytes = new Uint8Array(
      identityKeyPair.publicKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    );
    const saltInput = new Uint8Array(saltPrefix.length + publicKeyBytes.length);
    saltInput.set(saltPrefix, 0);
    saltInput.set(publicKeyBytes, saltPrefix.length);
    const saltBuffer = await crypto.subtle.digest('SHA-256', saltInput);

    // Info = protocol identifier
    const info = new TextEncoder().encode('pocketbridge_event_encryption_v1');

    // Import private key as key material for HKDF
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      privateKeyBuffer,
      'HKDF',
      false,
      ['deriveBits']
    );

    // HKDF expand (32 bytes = AES-256 key)
    const sharedKeyBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: saltBuffer,
        info: info,
      },
      keyMaterial,
      256 // 32 bytes
    );

    // Import as AES-GCM key
    const sharedKey = await crypto.subtle.importKey(
      'raw',
      sharedKeyBits,
      {
        name: 'AES-GCM',
        length: 256,
      },
      true, // extractable (for debugging if needed)
      ['encrypt', 'decrypt']
    );

    // Cache the key
    cachedSharedKey = {
      publicKeyHex: identityKeyPair.publicKeyHex,
      key: sharedKey,
    };

    // DEBUG: Log key derivation info for troubleshooting
    try {
      const exportedKey = await crypto.subtle.exportKey('raw', sharedKey);
      const keyBytes = new Uint8Array(exportedKey);
      const keyFingerprint = Array.from(keyBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
      console.log('[deriveSharedEncryptionKey] Key derived successfully', {
        publicKeyPrefix: identityKeyPair.publicKeyHex.substring(0, 16) + '...',
        privateKeyLength: identityKeyPair.privateKey.length,
        keyFingerprint: keyFingerprint + '...',
      });
    } catch (e) {
      console.log('[deriveSharedEncryptionKey] Key derived (could not export for debug)');
    }

    return sharedKey;
  })();

  // Store pending derivation so concurrent calls can await it
  pendingDerivation = {
    publicKeyHex: identityKeyPair.publicKeyHex,
    promise: derivationPromise,
  };

  try {
    const key = await derivationPromise;
    return key;
  } finally {
    // Clear pending derivation after completion
    if (pendingDerivation?.publicKeyHex === identityKeyPair.publicKeyHex) {
      pendingDerivation = null;
    }
  }
}
