"use client"

/**
 * React hook for accessing crypto utilities - Phase 1
 * Manages Ed25519 identity keypair initialization
 * Session keys come from handshake, not stored here
 */

import { useState, useEffect } from 'react';
import { initializeCrypto } from '@/lib/crypto';
import type { Ed25519KeyPair } from '@/types';

interface CryptoState {
  identityKeyPair: Ed25519KeyPair | null;
  isInitialized: boolean;
  error: Error | null;
}

export function useCrypto() {
  const [state, setState] = useState<CryptoState>({
    identityKeyPair: null,
    isInitialized: false,
    error: null,
  });

  useEffect(() => {
    let mounted = true;
    let isInitializing = false;

    async function initialize() {
      // Prevent multiple simultaneous initializations
      if (isInitializing) {
        console.log('[useCrypto] Initialization already in progress, skipping...');
        return;
      }

      isInitializing = true;
      console.log('[useCrypto] Hook mounted, starting initialization...');
      
      try {
        console.log('[useCrypto] Calling initializeCrypto()...');
        
        const startTime = Date.now();
        const { identityKeyPair } = await initializeCrypto();
        const duration = Date.now() - startTime;
        
        console.log('[useCrypto] Crypto initialization successful!', {
          hasIdentityKeyPair: !!identityKeyPair,
          publicKeyHex: identityKeyPair?.publicKeyHex?.substring(0, 16) + '...',
          duration: `${duration}ms`,
        });

        if (mounted) {
          setState({
            identityKeyPair,
            isInitialized: true,
            error: null,
          });
          console.log('[useCrypto] State updated, isInitialized = true');
        }
      } catch (error) {
        console.error('[useCrypto] CRITICAL: Crypto initialization failed!', error);
        console.error('[useCrypto] Error details:', {
          name: error instanceof Error ? error.name : 'Unknown',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        if (mounted) {
          setState({
            identityKeyPair: null,
            isInitialized: false,
            error: error instanceof Error ? error : new Error('Failed to initialize crypto'),
          });
        }
      } finally {
        isInitializing = false;
      }
    }

    // Initialize immediately (no delay)
    initialize();

    return () => {
      mounted = false;
    };
  }, []);

  return state;
}
