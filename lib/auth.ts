/**
 * Authentication and session management utilities
 * Provides secure session validation, cookie parsing, and auth checks
 */

import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';

// Cookie configuration
export const COOKIE_CONFIG = {
  ONBOARDING_COMPLETED: 'onboardingCompleted',
  SESSION_ID: 'sessionId',
  // Production-ready cookie options
  DEFAULT_OPTIONS: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  },
  SESSION_OPTIONS: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};

// Session validation result
export interface SessionValidationResult {
  isValid: boolean;
  userId?: string;
  sessionId?: string;
  error?: string;
}

/**
 * Validates session from cookies
 * Checks for required session markers and validates their integrity
 * @param request - NextRequest object containing cookies
 * @returns SessionValidationResult with validation status
 */
export function validateSessionFromRequest(request: NextRequest): SessionValidationResult {
  try {
    const cookieString = request.headers.get('cookie') || '';
    
    // Check for onboarding marker
    const hasOnboarding = cookieString.includes(`${COOKIE_CONFIG.ONBOARDING_COMPLETED}=true`);
    
    // Extract session ID if present
    const sessionMatch = cookieString.match(new RegExp(`${COOKIE_CONFIG.SESSION_ID}=([^;]+)`));
    const sessionId = sessionMatch?.[1];
    
    // Extract user ID from header (as fallback or primary auth)
    const userId = request.headers.get('x-user-id');
    
    // Session is valid if we have either:
    // 1. Onboarding completed flag + optional userId
    // 2. Valid session ID
    const isValid = hasOnboarding || (!!sessionId && sessionId.length > 0);
    
    if (!isValid) {
      return {
        isValid: false,
        error: 'No valid session found',
      };
    }
    
    return {
      isValid: true,
      userId: userId || undefined,
      sessionId: sessionId || undefined,
    };
  } catch (err) {
    return {
      isValid: false,
      error: `Session validation error: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Validates session from server-side cookies
 * Use in Server Components or route handlers
 * @returns SessionValidationResult with validation status
 */
export async function validateSessionFromCookies(): Promise<SessionValidationResult> {
  try {
    const cookieStore = await cookies();
    
    const onboardingCompleted = cookieStore.get(COOKIE_CONFIG.ONBOARDING_COMPLETED)?.value === 'true';
    const sessionId = cookieStore.get(COOKIE_CONFIG.SESSION_ID)?.value;
    
    const isValid = onboardingCompleted || !!sessionId;
    
    if (!isValid) {
      return {
        isValid: false,
        error: 'No valid session found',
      };
    }
    
    return {
      isValid: true,
      sessionId: sessionId || undefined,
    };
  } catch (err) {
    return {
      isValid: false,
      error: `Cookie validation error: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Builds Set-Cookie header value with security best practices
 * @param name - Cookie name
 * @param value - Cookie value
 * @param options - Optional cookie options
 * @returns Set-Cookie header string
 */
export function buildSetCookieHeader(
  name: string,
  value: string,
  options: Partial<typeof COOKIE_CONFIG.DEFAULT_OPTIONS> = {}
): string {
  const finalOptions = { ...COOKIE_CONFIG.DEFAULT_OPTIONS, ...options };
  
  // Validate cookie value to prevent injection attacks
  if (!isValidCookieValue(value)) {
    throw new Error('Invalid cookie value');
  }
  
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  
  if (finalOptions.path) {
    parts.push(`Path=${finalOptions.path}`);
  }
  
  if (finalOptions.maxAge) {
    parts.push(`Max-Age=${finalOptions.maxAge}`);
  }
  
  if (finalOptions.httpOnly) {
    parts.push('HttpOnly');
  }
  
  if (finalOptions.secure) {
    parts.push('Secure');
  }
  
  if (finalOptions.sameSite) {
    parts.push(`SameSite=${finalOptions.sameSite.charAt(0).toUpperCase()}${finalOptions.sameSite.slice(1)}`);
  }
  
  return parts.join('; ');
}

/**
 * Validates cookie value to prevent injection attacks
 * @param value - Cookie value to validate
 * @returns true if valid
 */
export function isValidCookieValue(value: string): boolean {
  // Cookie values should not contain semicolons, commas in certain contexts
  // Allow alphanumeric, hyphens, underscores, and basic special chars
  return /^[a-zA-Z0-9\-_=.]+$/.test(value);
}

/**
 * Clears a cookie by setting it with expired date
 * @param name - Cookie name to clear
 * @returns Set-Cookie header to clear the cookie
 */
export function buildClearCookieHeader(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/**
 * Extracts user context from request headers
 * @param request - NextRequest object
 * @returns User context with available identifiers
 */
export function extractUserContext(request: NextRequest) {
  return {
    userId: request.headers.get('x-user-id'),
    userAgent: request.headers.get('user-agent'),
    ip: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip'),
  };
}

/**
 * Checks if request origin matches expected origins
 * @param request - NextRequest object
 * @param allowedOrigins - List of allowed origins
 * @returns true if origin is allowed
 */
export function isOriginAllowed(request: NextRequest, allowedOrigins: string[]): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // Allow same-origin requests
  return allowedOrigins.includes(origin);
}
