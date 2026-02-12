/**
 * Fetch interceptor to add ngrok-skip-browser-warning header
 *
 * ngrok free tier returns an HTML interstitial page for browser requests
 * unless this header is present. This patches global fetch so all API
 * calls automatically include it.
 */

import { config } from '@/lib/config';
import { logger } from '@/lib/utils/logger';

function shouldLogRequest(url: string): boolean {
  if (!url) return false;
  if (url.includes('.ngrok-free.dev') || url.includes('.ngrok.io')) return true;
  if (url.startsWith(config.apiUrl)) return true;
  return url.includes('/api/') || url.endsWith('/health');
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input !== 'string' && 'method' in input && input.method) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

if (typeof window !== 'undefined') {
  const originalFetch = window.fetch;

  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = getRequestMethod(input, init);
    const shouldLog = shouldLogRequest(url);
    const start = performance.now();

    // Only add header for requests to ngrok domains
    if (url.includes('.ngrok-free.dev') || url.includes('.ngrok.io')) {
      const headers = new Headers(init?.headers);
      headers.set('ngrok-skip-browser-warning', 'true');
      init = { ...init, headers };
    }

    if (shouldLog) {
      logger.info('[FETCH] Request', { method, url });
    }

    try {
      const response = await originalFetch.call(window, input, init);
      if (shouldLog) {
        const durationMs = Math.round(performance.now() - start);
        logger.info('[FETCH] Response', {
          method,
          url,
          status: response.status,
          ok: response.ok,
          durationMs,
        });
      }
      return response;
    } catch (error) {
      if (shouldLog) {
        const durationMs = Math.round(performance.now() - start);
        logger.error('[FETCH] Failed', error, { method, url, durationMs });
      }
      throw error;
    }
  };
}
