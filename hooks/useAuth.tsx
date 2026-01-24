/**
 * useAuth - React hook for client-side authentication state management
 * Provides auth status, login/logout functionality, and session monitoring
 */

'use client';

import { useEffect, useState, useCallback, ReactElement, JSXElementConstructor } from 'react';

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

interface UseAuthReturn extends AuthState {
  completeOnboarding: () => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

/**
 * Hook to manage authentication state
 * Monitors onboarding status and provides auth methods
 */
export function useAuth(): UseAuthReturn {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: true,
    error: null,
  });

  // Check if onboarding is complete on mount
  useEffect(() => {
    checkAuthStatus();
  }, []);

  /**
   * Check if user is authenticated by looking for onboarding cookie
   */
  const checkAuthStatus = useCallback(async () => {
    try {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));

      // Check if onboardingCompleted cookie exists
      // This is a simple check - in production, validate with backend
      const cookies = document.cookie.split(';');
      const hasOnboarding = cookies.some(
        (cookie) => cookie.trim().startsWith('onboardingCompleted=true')
      );

      setState({
        isAuthenticated: hasOnboarding,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Auth check failed';
      setState({
        isAuthenticated: false,
        isLoading: false,
        error,
      });
    }
  }, []);

  /**
   * Complete onboarding process
   */
  const completeOnboarding = useCallback(async () => {
    try {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));

      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to complete onboarding');
      }

      // Update auth state after successful completion
      setState({
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Onboarding failed';
      setState({
        isAuthenticated: false,
        isLoading: false,
        error,
      });
      throw err;
    }
  }, []);

  /**
   * Clear auth state and logout
   */
  const logout = useCallback(async () => {
    try {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));

      // In production, call a logout endpoint to clear session
      // document.cookie = 'onboardingCompleted=; Max-Age=0; Path=/';
      
      setState({
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Logout failed';
      setState({
        isAuthenticated: false,
        isLoading: false,
        error,
      });
      throw error;
    }
  }, []);

  /**
   * Refresh auth status from server
   */
  const refreshAuth = useCallback(async () => {
    await checkAuthStatus();
  }, [checkAuthStatus]);

  return {
    ...state,
    completeOnboarding,
    logout,
    refreshAuth,
  };
}

/**
 * Higher-order component to protect routes requiring authentication
 */
export function withAuthRequired<T extends object>(
  Component: React.ComponentType<T>
): React.ComponentType<T> {
  return function AuthProtectedComponent(props: T): React.ReactElement | null {
    const { isAuthenticated, isLoading, error } = useAuth();

    if (isLoading) {
      return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
    }

    if (!isAuthenticated) {
      // Redirect will be handled by middleware
      return null;
    }

    if (error) {
      return <div className="flex items-center justify-center min-h-screen text-red-500">Auth error: {error}</div>;
    }

    return <Component {...props} />;
  };
}
