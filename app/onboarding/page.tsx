'use client';

/**
 * Onboarding Page
 * 
 * First-time user setup flow
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { PocketBridgeLogo } from '@/components/ui/logo';
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
    try {
      // Set onboarding cookie for proxy to read on subsequent requests
      const isProd = process.env.NODE_ENV === 'production';
      const maxAge = 60 * 60 * 24 * 365; // 1 year
      const cookieAttrs = [`path=/`, `max-age=${maxAge}`, `samesite=lax`];
      if (isProd) cookieAttrs.push('secure');
      // Note: httpOnly cannot be set from client JS
      document.cookie = `onboardingCompleted=true; ${cookieAttrs.join('; ')}`;
    } catch (err) {
      // Non-fatal: continue to redirect even if cookie set fails
      console.warn('Failed to set onboarding cookie', err);
    }
    router.push('/');
  };

  // Prevent hydration mismatch by not rendering until mounted
  if (!isMounted || isLoading || !isInitialized || !identityKeyPair) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-linear-to-b from-background to-blue-50/50 dark:to-blue-950/20">
        <div className="text-center space-y-5 animate-in fade-in duration-500">
          <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-950/40">
            <PocketBridgeLogo size={64} />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-foreground">PocketBridge</h2>
            <div className="flex items-center justify-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse [animation-delay:200ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse [animation-delay:400ms]" />
            </div>
          </div>
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
    <div className="min-h-screen flex items-center justify-center p-6 bg-linear-to-b from-background to-blue-50/50 dark:to-blue-950/20">
      <div className="w-full max-w-3xl space-y-4">
        <div className="flex items-start gap-3 p-4 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/20">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/40">
            <PocketBridgeLogo size={20} />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-emerald-900 dark:text-emerald-100">Mobile app is available</h3>
            <p className="text-sm text-emerald-800 dark:text-emerald-200 mt-1">
              Download the Android APK for your phone.{" "}
              <a
                href="https://expo.dev/accounts/zarbiek-9/projects/mobile-agent/builds/6f51f580-daf3-401a-b536-5792c5c1e5db"
                target="_blank"
                rel="noreferrer"
                className="font-semibold underline hover:opacity-80"
              >
                Get the latest build
              </a>
            </p>
          </div>
        </div>
        <OnboardingFlow
          userId={identityKeyPair.publicKeyHex}
          currentDeviceName={deviceName}
          onComplete={handleComplete}
        />
      </div>
    </div>
  );
}

