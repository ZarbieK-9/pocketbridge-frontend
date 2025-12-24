/**
 * Cryptographic key generation and management - Phase 1
 * 
 * Uses Ed25519 for identity keys (via @noble/ed25519 polyfill)
 * Web Crypto API doesn't natively support Ed25519
 */

import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { STORAGE_KEYS } from '@/lib/constants';
import type { Ed25519KeyPair } from '@/types';

// Re-export for convenience
const { getPublicKey, sign, verify, utils } = ed25519;

// Track initialization state
let sha512Initialized = false;
let provider: 'noble' | 'nacl' = 'noble';

// Initialize @noble/ed25519 with SHA-512 for browser environments
// This is required for @noble/ed25519 v2+ in browsers
function initializeSHA512() {
  if (typeof window === 'undefined') {
    return; // Server-side, no need to initialize
  }
  
  if (sha512Initialized) {
    return; // Already initialized
  }
  
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Web Crypto API not available. This app requires a modern browser.');
  }
  
  // Check if imports are available
  if (typeof sha512 === 'undefined' || typeof concatBytes === 'undefined') {
    console.error('[Crypto] SHA-512 imports not available:', {
      sha512: typeof sha512,
      concatBytes: typeof concatBytes,
    });
    throw new Error('SHA-512 imports not available. Make sure @noble/hashes is installed and imported correctly.');
  }
  
  try {
    // Create the SHA-512 functions
    const sha512SyncFn = (...m: Uint8Array[]) => {
      if (!sha512 || !concatBytes) {
        throw new Error('SHA-512 functions not available');
      }
      return sha512(concatBytes(...m));
    };
    
    const sha512AsyncFn = (...m: Uint8Array[]) => {
      if (!sha512 || !concatBytes) {
        throw new Error('SHA-512 functions not available');
      }
      return Promise.resolve(sha512(concatBytes(...m)));
    };
    
    // Set up SHA-512 for @noble/ed25519 (v2+ / v3)
    // The library reads from etc.sha512Sync/Async in browser builds
    // @ts-ignore - these properties may not exist in types but are required at runtime
    const ed25519Any = ed25519 as any;
    
    // PRIMARY: Set on etc (this is what the library checks)
    if (ed25519Any.etc) {
      ed25519Any.etc.sha512Sync = sha512SyncFn;
      ed25519Any.etc.sha512Async = sha512AsyncFn;
      console.log('[Crypto] Set SHA-512 on ed25519.etc');

      // Also set on nested hashes bag if present (some versions expect etc.hashes.sha512)
      if (ed25519Any.etc.hashes) {
        ed25519Any.etc.hashes.sha512 = sha512SyncFn;
        console.log('[Crypto] Set SHA-512 on ed25519.etc.hashes');
      } else {
        // Create hashes bag to satisfy checks in newer builds
        ed25519Any.etc.hashes = { sha512: sha512SyncFn };
        console.log('[Crypto] Created ed25519.etc.hashes with sha512');
      }
    } else {
      throw new Error('ed25519.etc not found - cannot set SHA-512');
    }
    
    // Also set on utils (for compatibility)
    // @ts-ignore
    utils.sha512Sync = sha512SyncFn;
    // @ts-ignore
    utils.sha512Async = sha512AsyncFn;
    
    // Verify it was set on etc (the primary location)
    if (!ed25519Any.etc?.sha512Sync && !ed25519Any.etc?.hashes?.sha512) {
      throw new Error('Failed to set etc.sha512Sync');
    }
    
    sha512Initialized = true;
    console.log('[Crypto] SHA-512 initialized for @noble/ed25519', {
      hasEtcSha512Sync: !!ed25519Any.etc?.sha512Sync,
      hasUtilsSha512Sync: !!(utils as any).sha512Sync,
      etcKeys: ed25519Any.etc ? Object.keys(ed25519Any.etc) : [],
    });
    provider = 'noble';
  } catch (error) {
    console.error('[Crypto] Failed to initialize SHA-512:', error);
    console.error('[Crypto] Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Fallback: use tweetnacl provider in browser
    provider = 'nacl';
    throw new Error(`Failed to initialize SHA-512: ${error instanceof Error ? error.message : String(error)}. Falling back to tweetnacl.`);
  }
}

// Initialize immediately when module loads (for static imports)
if (typeof window !== 'undefined') {
  try {
    initializeSHA512();
  } catch (error) {
    console.warn('[Crypto] Failed to initialize SHA-512 at module load (will retry on use):', error);
  }
}

// Export initialization function for dynamic imports
export function ensureSHA512Initialized() {
  if (typeof window !== 'undefined') {
    const ed25519Any = ed25519 as any;
    // Check if etc.sha512Sync is set (the primary location)
    // @ts-ignore
    if (!sha512Initialized || !ed25519Any.etc?.sha512Sync) {
      console.log('[Crypto] SHA-512 not initialized, initializing now...');
      sha512Initialized = false; // Reset flag to allow retry
      try {
        initializeSHA512();
        // Verify it was set on etc (the primary location)
        if (!ed25519Any.etc?.sha512Sync && !ed25519Any.etc?.hashes?.sha512) {
          throw new Error('SHA-512 initialization completed but etc.sha512Sync/hash is still not set');
        }
        console.log('[Crypto] SHA-512 initialization successful');
      } catch (error) {
        console.error('[Crypto] Failed to initialize SHA-512 in ensureSHA512Initialized:', error);
        provider = 'nacl';
        throw error;
      }
    } else {
      console.log('[Crypto] SHA-512 already initialized');
    }
  }
}

// Cache for shared encryption key (derived from identity keypair)
let cachedSharedKey: { publicKeyHex: string; key: CryptoKey } | null = null;

/**
 * Generate an Ed25519 keypair for device identity
 * Uses @noble/ed25519 polyfill since Web Crypto API doesn't support Ed25519
 */
export async function generateIdentityKeyPair(): Promise<Ed25519KeyPair> {
  console.log('[generateIdentityKeyPair] Generating new Ed25519 keypair...');
  
  // Ensure SHA-512 is initialized before use
  try {
    ensureSHA512Initialized();
  } catch (error) {
    console.error('[generateIdentityKeyPair] Failed to initialize SHA-512:', error);
    console.warn('[generateIdentityKeyPair] Falling back to tweetnacl for key generation');
  }
  
  // Double-check initialization
  if (typeof window !== 'undefined') {
    // @ts-ignore
    if (provider === 'noble' && !utils.sha512Sync) {
      console.warn('[generateIdentityKeyPair] SHA-512 not visible on utils, switching to tweetnacl');
      provider = 'nacl';
    }
    if (provider === 'noble') {
      console.log('[generateIdentityKeyPair] SHA-512 verified, proceeding with key generation (noble)');
    } else {
      console.log('[generateIdentityKeyPair] Proceeding with key generation (tweetnacl)');
    }
  }
  
  try {
    let privateKey: Uint8Array;
    let publicKey: Uint8Array;

    if (provider === 'noble') {
      // Generate private key (32 random bytes)
      privateKey = utils.randomSecretKey();
      console.log('[generateIdentityKeyPair] Private key generated (noble)');
      // Derive public key from private key
      console.log('[generateIdentityKeyPair] Deriving public key (noble)...');
      publicKey = await getPublicKey(privateKey);
      console.log('[generateIdentityKeyPair] Public key derived (noble)');
    } else {
      // Fallback to tweetnacl (fromSeed) for Ed25519
      const nacl = await import('tweetnacl');
      const seed = nacl.randomBytes(32);
      const kp = nacl.sign.keyPair.fromSeed(seed);
      privateKey = seed;
      publicKey = kp.publicKey;
      console.log('[generateIdentityKeyPair] Keypair generated (tweetnacl)');
    }
    
    // Convert to hex for storage/transmission
    const publicKeyHex = Array.from(publicKey)
      .map((b: number) => (b as number).toString(16).padStart(2, '0'))
      .join('');
    const privateKeyHex = Array.from(privateKey)
      .map((b: number) => (b as number).toString(16).padStart(2, '0'))
      .join('');
    
    console.log('[generateIdentityKeyPair] Keypair generated successfully:', {
      publicKeyHex: publicKeyHex.substring(0, 16) + '...',
      privateKeyLength: privateKey.length,
      publicKeyLength: publicKey.length,
    });
    
    return {
      publicKey,
      privateKey,
      publicKeyHex,
      privateKeyHex,
    };
  } catch (error) {
    console.error('[generateIdentityKeyPair] Error generating keypair:', error);
    throw error;
  }
}

/**
 * Sign data with Ed25519 private key
 */
export async function signEd25519(
  privateKey: Uint8Array,
  data: Uint8Array | string
): Promise<Uint8Array> {
  const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (provider === 'nacl') {
    const nacl = await import('tweetnacl');
    // tweetnacl requires 64-byte secret key; derive from seed
    const kp = nacl.sign.keyPair.fromSeed(privateKey);
    return nacl.sign.detached(dataBytes, kp.secretKey);
  } else {
    ensureSHA512Initialized();
    return await sign(dataBytes, privateKey);
  }
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
  if (provider === 'nacl') {
    const nacl = await import('tweetnacl');
    return nacl.sign.detached.verify(dataBytes, signature, publicKey);
  } else {
    ensureSHA512Initialized();
    return await verify(signature, dataBytes, publicKey);
  }
}

/**
 * Save identity keypair to localStorage
 */
export function saveIdentityKeyPair(keyPair: Ed25519KeyPair): void {
  if (typeof window === 'undefined') return;

  const keyData = {
    publicKeyHex: keyPair.publicKeyHex,
    privateKeyHex: keyPair.privateKeyHex,
  };

  localStorage.setItem(STORAGE_KEYS.IDENTITY_KEYPAIR, JSON.stringify(keyData));
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
  // Use private key as input material (all devices of same user have same private key)
  // Create a new Uint8Array to ensure we have a clean buffer
  const privateKeyBytes = new Uint8Array(identityKeyPair.privateKey);
  const privateKeyBuffer = privateKeyBytes.buffer;

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

  return sharedKey;
}
