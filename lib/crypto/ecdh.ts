/**
 * ECDH Key Exchange - Phase 1
 * 
 * Generates ephemeral ECDH keypairs (P-256) for session handshake
 * Derives shared secret and session keys via HKDF
 */

import { STORAGE_KEYS } from '@/lib/constants';

export interface ECDHKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyHex: string;
}

/**
 * Generate ephemeral ECDH keypair (P-256)
 */
export async function generateECDHKeyPair(): Promise<ECDHKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true, // extractable
    ['deriveKey', 'deriveBits']
  );

  // Export public key to hex
  const publicKeyBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicKeyArray = new Uint8Array(publicKeyBuffer);
  const publicKeyHex = Array.from(publicKeyArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyHex,
  };
}

/**
 * Compute shared secret from ECDH
 */
export async function computeECDHSecret(
  publicKeyHex: string,
  privateKey: CryptoKey
): Promise<ArrayBuffer> {
  // Import public key
  const publicKeyArray = new Uint8Array(
    publicKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );
  const publicKey = await crypto.subtle.importKey(
    'raw',
    publicKeyArray,
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false,
    []
  );

  // Derive shared secret
  return await crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: publicKey,
    },
    privateKey,
    256 // 256 bits = 32 bytes
  );
}

/**
 * Derive session keys using HKDF (RFC 5869)
 * 
 * HKDF(shared_secret, salt, info, length)
 * - salt: SHA256(client_ephemeral_pub || server_ephemeral_pub)
 * - info: "pocketbridge_session_v1"
 * - length: 32 bytes (AES-256)
 */
export async function deriveSessionKeys(
  sharedSecret: ArrayBuffer,
  clientEphemeralPub: string,
  serverEphemeralPub: string
): Promise<{ clientKey: CryptoKey; serverKey: CryptoKey; clientKeyHex: string; serverKeyHex: string }> {
  // Salt = SHA256(client_pub || server_pub)
  const clientPubArray = new Uint8Array(
    clientEphemeralPub.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );
  const serverPubArray = new Uint8Array(
    serverEphemeralPub.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );
  const combined = new Uint8Array(clientPubArray.length + serverPubArray.length);
  combined.set(clientPubArray, 0);
  combined.set(serverPubArray, clientPubArray.length);
  const saltBuffer = await crypto.subtle.digest('SHA-256', combined);

  // Info = protocol identifier
  const info = new TextEncoder().encode('pocketbridge_session_v1');

  // Import shared secret as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveBits']
  );

  // HKDF expand (32 bytes = AES-256 key)
  const sessionKeyBits = await crypto.subtle.deriveBits(
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
  const sessionKey = await crypto.subtle.importKey(
    'raw',
    sessionKeyBits,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );

  const sessionKeyArray = new Uint8Array(sessionKeyBits);
  const sessionKeyHex = Array.from(sessionKeyArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    clientKey: sessionKey,
    serverKey: sessionKey, // Same key for both directions (simplified)
    clientKeyHex: sessionKeyHex,
    serverKeyHex: sessionKeyHex,
  };
}

