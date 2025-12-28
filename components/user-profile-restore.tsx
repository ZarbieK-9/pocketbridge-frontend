'use client';

/**
 * User Profile Restore Component
 * 
 * Restores user profile data when user returns to the app
 * Runs on app initialization
 */

import { useEffect } from 'react';
import { useCrypto } from '@/hooks/use-crypto';
import { loadUserProfile, getOrCreateUserProfile, updateUserProfile } from '@/lib/utils/user-profile';
import { getOrCreateDeviceName, updateDeviceName } from '@/lib/utils/device';
import { logger } from '@/lib/utils/logger';

export function UserProfileRestore() {
  const { identityKeyPair, isInitialized } = useCrypto();

  useEffect(() => {
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

        // Update last seen (non-blocking)
        updateUserProfile({ lastSeen: Date.now() }, identityKeyPair.publicKeyHex).catch((error) => {
          logger.error('Failed to update last seen', error);
        });
      }
    }).catch((error) => {
      logger.error('Failed to restore user profile', error);
    });
  }, [isInitialized, identityKeyPair]);

  return null; // This component doesn't render anything
}

