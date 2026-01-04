/**
 * Client-Side Rate Limiting
 * 
 * Prevents spam, abuse, and DoS attacks
 * Throttles rapid actions
 */

interface RateLimitOptions {
  maxRequests: number;
  windowMs: number;
}

interface RateLimitState {
  requests: number[];
  blocked: boolean;
  blockedUntil: number | null;
}

class RateLimiter {
  private state: Map<string, RateLimitState> = new Map();

  /**
   * Check if request is allowed
   */
  check(key: string, options: RateLimitOptions): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const state = this.state.get(key) || {
      requests: [],
      blocked: false,
      blockedUntil: null,
    };

    // Check if still blocked
    if (state.blocked && state.blockedUntil && now < state.blockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: state.blockedUntil,
      };
    }

    // Clear block if expired
    if (state.blocked && state.blockedUntil && now >= state.blockedUntil) {
      state.blocked = false;
      state.blockedUntil = null;
    }

    // Remove old requests outside window
    const windowStart = now - options.windowMs;
    state.requests = state.requests.filter((timestamp) => timestamp > windowStart);

    // Check if limit exceeded
    if (state.requests.length >= options.maxRequests) {
      state.blocked = true;
      state.blockedUntil = now + options.windowMs;
      this.state.set(key, state);
      return {
        allowed: false,
        remaining: 0,
        resetAt: state.blockedUntil,
      };
    }

    // Add current request
    state.requests.push(now);
    this.state.set(key, state);

    return {
      allowed: true,
      remaining: options.maxRequests - state.requests.length,
      resetAt: now + options.windowMs,
    };
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): void {
    this.state.delete(key);
  }

  /**
   * Clear all rate limits
   */
  clear(): void {
    this.state.clear();
  }
}

// Singleton instance
const rateLimiter = new RateLimiter();

/**
 * Rate limit configuration presets
 */
export const rateLimitPresets = {
  // Message sending: 10 messages per minute
  messageSend: {
    maxRequests: 10,
    windowMs: 60 * 1000,
  },
  // File upload: 5 files per minute
  fileUpload: {
    maxRequests: 5,
    windowMs: 60 * 1000,
  },
  // API calls: 30 requests per minute
  apiCall: {
    maxRequests: 30,
    windowMs: 60 * 1000,
  },
  // Pairing code generation: 3 per hour
  pairingCode: {
    maxRequests: 3,
    windowMs: 60 * 60 * 1000,
  },
} as const;

/**
 * Check rate limit
 */
export function checkRateLimit(
  key: string,
  preset: keyof typeof rateLimitPresets
): { allowed: boolean; remaining: number; resetAt: number } {
  return rateLimiter.check(key, rateLimitPresets[preset]);
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };

    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttle function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;

  return function executedFunction(...args: Parameters<T>) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}



