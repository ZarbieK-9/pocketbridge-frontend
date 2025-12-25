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
