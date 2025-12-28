'use client';

/**
 * Onboarding Page
 * 
 * First-time user setup flow
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { useCrypto } from '@/hooks/use-crypto';
import { getOrCreateDeviceName } from '@/lib/utils/device';
import { loadUserProfile, getOrCreateUserProfile } from '@/lib/utils/user-profile';
import { logger } from '@/lib/utils/logger';

export default function OnboardingPage() {
  const router = useRouter();
  const { identityKeyPair, isInitialized, error: cryptoError } = useCrypto();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isInitialized) {
      return; // Wait for crypto to initialize
    }

    if (cryptoError) {
      logger.error('Crypto initialization failed', cryptoError);
      setIsLoading(false);
      return;
    }

    if (!identityKeyPair) {
      logger.error('No identity keypair available');
      setIsLoading(false);
      return;
    }

    // Check if user has already completed onboarding
    const profile = loadUserProfile();
    if (profile && profile.userId === identityKeyPair.publicKeyHex && profile.onboardingCompleted) {
      // Already completed, redirect to dashboard
      router.push('/');
      return;
    }

    setIsLoading(false);
  }, [isInitialized, identityKeyPair, cryptoError, router]);

  const handleComplete = () => {
    router.push('/');
  };

  if (isLoading || !isInitialized || !identityKeyPair) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground">Initializing...</p>
        </div>
      </div>
    );
  }

  if (cryptoError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-md">
          <h1 className="text-2xl font-bold">Initialization Error</h1>
          <p className="text-muted-foreground">{cryptoError.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md"
          >
            Reload Page
          </button>
        </div>
      </div>
    );
  }

  const deviceName = getOrCreateDeviceName();
  const [profile, setProfile] = useState<ReturnType<typeof loadUserProfile>>(null);

  useEffect(() => {
    if (isInitialized && identityKeyPair) {
      getOrCreateUserProfile(identityKeyPair).then(setProfile).catch((error) => {
        logger.error('Failed to load user profile', error);
      });
    }
  }, [isInitialized, identityKeyPair]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-muted/30">
      <OnboardingFlow
        userId={identityKeyPair.publicKeyHex}
        currentDeviceName={deviceName}
        onComplete={handleComplete}
      />
    </div>
  );
}

