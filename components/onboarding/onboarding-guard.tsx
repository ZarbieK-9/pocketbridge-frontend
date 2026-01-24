'use client';

/**
 * Onboarding Guard Component
 * 
 * Checks if user has completed onboarding and redirects if needed
 * Should be used in protected routes
 */

import { useEffect, useState, useLayoutEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useCrypto } from '@/hooks/use-crypto';
import { getOrCreateUserProfile } from '@/lib/utils/user-profile';
import { logger } from '@/lib/utils/logger';

interface OnboardingGuardProps {
  children: React.ReactNode;
}

export function OnboardingGuard({ children }: OnboardingGuardProps) {
  // All hooks must be called unconditionally and in the same order
  const [isClient, setIsClient] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const cryptoState = useCrypto(); // Always call useCrypto, even if we don't use it during SSR
  const [isChecking, setIsChecking] = useState(true);
  const [hasRedirected, setHasRedirected] = useState(false);

  // Routes that don't require onboarding
  const publicRoutes = ['/onboarding', '/pair'];

  // Use useLayoutEffect to set client flag synchronously before paint
  // This ensures we don't render different content on SSR vs client
  useLayoutEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    // Don't run on server or before client mount
    if (!isClient || typeof window === 'undefined') {
      return;
    }

    const { identityKeyPair, isInitialized } = cryptoState;
    // Don't check on public routes
    if (publicRoutes.includes(pathname)) {
      setIsChecking(false);
      return;
    }

    // Wait for crypto to initialize
    if (!isInitialized) {
      return;
    }

    // If no identity keypair, allow access (they'll need to pair/onboard)
    if (!identityKeyPair) {
      setIsChecking(false);
      return;
    }

    let cancelled = false;

    const verifyOnboarding = async () => {
      try {
        const profile = await getOrCreateUserProfile(identityKeyPair);
        
        // If user hasn't completed onboarding, redirect to onboarding
        if (!profile.onboardingCompleted) {
          if (!hasRedirected) {
            logger.info('Onboarding not completed, redirecting to onboarding page');
            setHasRedirected(true);
            setIsChecking(false);
            router.push('/onboarding');
          }
          return;
        }

        // If onboarding is complete, allow access to all routes
        logger.info('User profile loaded - onboarding complete', {
          userId: profile.userId.substring(0, 16) + '...',
          displayName: profile.displayName,
          onboardingCompleted: profile.onboardingCompleted,
        });
      } catch (error) {
        logger.warn('Failed to resolve onboarding status', {
          error: error instanceof Error ? error.message : String(error),
        });
        // On error, redirect to onboarding to be safe
        if (!hasRedirected) {
          setHasRedirected(true);
          router.push('/onboarding');
        }
      } finally {
        if (!cancelled) {
          setIsChecking(false);
        }
      }
    };

    verifyOnboarding();
    return () => {
      cancelled = true;
    };
  }, [cryptoState, pathname, router, hasRedirected, isClient]);

  // CRITICAL: Always render children on first render (SSR and initial client render)
  // This prevents hydration mismatches. Only show loading/redirect after client-side effects run.
  // Use suppressHydrationWarning to prevent React from complaining about the initial render difference
  if (!isClient) {
    return <div suppressHydrationWarning>{children}</div>;
  }

  // Show loading state while checking (only after client mount)
  if (isChecking && !publicRoutes.includes(pathname)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

