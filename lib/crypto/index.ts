"use client"

/**
 * Crypto module exports - Phase 1
 * Centralized access to all cryptographic utilities
 */

export {
  generateIdentityKeyPair,
  signEd25519,
  verifyEd25519,
  saveIdentityKeyPair,
  loadIdentityKeyPair,
  generateSymmetricKey,
  importAESKey,
  exportAESKey,
  deriveSharedEncryptionKey,
} from './keys';

export { encryptPayload, decryptPayload } from './encryption';

export { generateNonce, generateHandshakeNonce, NonceRegistry } from './nonce';

export { computeHMAC, verifyHMAC } from './hmac';

export {
  generateECDHKeyPair,
  computeECDHSecret,
  deriveSessionKeys,
} from './ecdh';

/**
 * Initialize crypto system for a device - Phase 1
 * Generates and stores Ed25519 identity keypair if not present
 * Session keys are derived from handshake, not stored
 */
export async function initializeCrypto(): Promise<{
  identityKeyPair: Awaited<ReturnType<typeof import('./keys').loadIdentityKeyPair>>;
}> {
  // Check if we're in a browser environment
  if (typeof window === 'undefined') {
    console.warn('[initializeCrypto] Running in SSR context, returning null');
    return { identityKeyPair: null };
  }

  // Check if localStorage is available
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage is not available. This app requires a browser environment.');
  }

  console.log('[initializeCrypto] Starting initialization...');
  
  try {
    const keysModule = await import('./keys');
    console.log('[initializeCrypto] Keys module imported successfully');

    const {
      generateIdentityKeyPair,
      saveIdentityKeyPair,
      loadIdentityKeyPair,
    } = keysModule;

    console.log('[initializeCrypto] Loading existing identity keypair...');
    // Load or generate identity keypair
    let identityKeyPair = await loadIdentityKeyPair();
    
    if (!identityKeyPair) {
      console.log('[initializeCrypto] No existing keypair found, generating new one...');
      identityKeyPair = await generateIdentityKeyPair();
      console.log('[initializeCrypto] Keypair generated, saving...');
      await saveIdentityKeyPair(identityKeyPair);
      console.log('[initializeCrypto] Keypair saved successfully');
    } else {
      console.log('[initializeCrypto] Existing keypair loaded');
    }

    console.log('[initializeCrypto] Initialization complete!');
    return { identityKeyPair };
  } catch (error) {
    console.error('[initializeCrypto] CRITICAL ERROR in initialization!', error);
    throw error;
  }
}
