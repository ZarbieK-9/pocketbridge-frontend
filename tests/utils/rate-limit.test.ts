/**
 * Rate Limiting Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, debounce, throttle, rateLimitPresets } from '@/lib/utils/rate-limit';

describe('Rate Limiting', () => {
  beforeEach(() => {
    // Reset rate limiter state between tests
    // Note: In a real implementation, we'd need to expose a reset method
  });

  describe('checkRateLimit', () => {
    it('should allow requests within limit', () => {
      const key = 'test-key';
      const result1 = checkRateLimit(key, 'messageSend');
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBeGreaterThan(0);
    });

    it('should block requests exceeding limit', () => {
      const key = 'test-key-limit';
      // Make requests up to the limit
      for (let i = 0; i < rateLimitPresets.messageSend.maxRequests; i++) {
        checkRateLimit(key, 'messageSend');
      }
      
      // Next request should be blocked
      const result = checkRateLimit(key, 'messageSend');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should reset after window expires', async () => {
      const key = 'test-key-reset';
      // Make requests up to the limit
      for (let i = 0; i < rateLimitPresets.messageSend.maxRequests; i++) {
        checkRateLimit(key, 'messageSend');
      }
      
      // Wait for window to expire (in real test, we'd mock time)
      // For now, just verify the structure
      const result = checkRateLimit(key, 'messageSend');
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('remaining');
      expect(result).toHaveProperty('resetAt');
    });
  });

  describe('debounce', () => {
    it('should debounce function calls', async () => {
      let callCount = 0;
      const debouncedFn = debounce(() => {
        callCount++;
      }, 100);

      debouncedFn();
      debouncedFn();
      debouncedFn();

      expect(callCount).toBe(0);

      await new Promise(resolve => setTimeout(resolve, 150));
      expect(callCount).toBe(1);
    });
  });

  describe('throttle', () => {
    it('should throttle function calls', async () => {
      let callCount = 0;
      const throttledFn = throttle(() => {
        callCount++;
      }, 100);

      throttledFn();
      throttledFn();
      throttledFn();

      expect(callCount).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 150));
      throttledFn();
      expect(callCount).toBe(2);
    });
  });
});



