'use client';

/**
 * User Profile Restore Component
 * 
 * Restores user profile data when user returns to the app
 * Runs on app initialization
 */

import { useEffect, useState } from 'react';
import { useCrypto } from '@/hooks/use-crypto';
import { loadUserProfile, getOrCreateUserProfile, updateUserProfile } from '@/lib/utils/user-profile';
import { getOrCreateDeviceName, updateDeviceName } from '@/lib/utils/device';
import { logger } from '@/lib/utils/logger';

export function UserProfileRestore() {
  const { identityKeyPair, isInitialized } = useCrypto();
  const [isMounted, setIsMounted] = useState(false);

  // Ensure component only runs on client
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsMounted(true);
    }
  }, []);

  useEffect(() => {
    // Don't run on server or before mount
    if (!isMounted || typeof window === 'undefined') {
      return;
    }

    if (!isInitialized || !identityKeyPair) {
      return;
    }

    // Restore user profile (async - fetches from server)
    getOrCreateUserProfile(identityKeyPair).then((profile) => {
      if (profile && profile.userId === identityKeyPair.publicKeyHex) {
        logger.info('User profile restored', {
          userId: profile.userId.substring(0, 16) + '...',
          displayName: profile.displayName,
          onboardingCompleted: profile.onboardingCompleted,
        });

        // Note: lastSeen is updated automatically on the server when fetching profile
        // No need to send a separate update for lastSeen
      }
    }).catch((error) => {
      logger.error('Failed to restore user profile', error);
    });
  }, [isInitialized, identityKeyPair, isMounted]);

  return null; // This component doesn't render anything
}

