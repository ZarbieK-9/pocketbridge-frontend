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
import { getOrCreateUserProfile } from '@/lib/utils/user-profile';
import { logger } from '@/lib/utils/logger';

export default function OnboardingPage() {
  // ALL HOOKS MUST BE CALLED UNCONDITIONALLY AT THE TOP
  const router = useRouter();
  const { identityKeyPair, isInitialized, error: cryptoError } = useCrypto();
  const [isLoading, setIsLoading] = useState(true);
  const [isMounted, setIsMounted] = useState(false);
  const [deviceName, setDeviceName] = useState<string>('');
  
  // Only call getOrCreateDeviceName on client to avoid hydration issues
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsMounted(true);
      setDeviceName(getOrCreateDeviceName());
    }
  }, []);

  // Check onboarding status and handle redirects
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

    let cancelled = false;
    const resolveProfile = async () => {
      try {
        const profile = await getOrCreateUserProfile(identityKeyPair);
        if (profile && profile.onboardingCompleted) {
          router.push('/');
          return;
        }
      } catch (error) {
        logger.warn('Failed to resolve onboarding status from server', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    resolveProfile();
    return () => {
      cancelled = true;
    };
  }, [isInitialized, identityKeyPair, cryptoError, router]);

  const handleComplete = () => {
    router.push('/');
  };

  // Prevent hydration mismatch by not rendering until mounted
  if (!isMounted || isLoading || !isInitialized || !identityKeyPair) {
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

