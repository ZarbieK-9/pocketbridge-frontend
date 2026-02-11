/**
 * Fetch interceptor to add ngrok-skip-browser-warning header
 *
 * ngrok free tier returns an HTML interstitial page for browser requests
 * unless this header is present. This patches global fetch so all API
 * calls automatically include it.
 */

if (typeof window !== 'undefined') {
  const originalFetch = window.fetch;

  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // Only add header for requests to ngrok domains
    if (url.includes('.ngrok-free.dev') || url.includes('.ngrok.io')) {
      const headers = new Headers(init?.headers);
      headers.set('ngrok-skip-browser-warning', 'true');
      init = { ...init, headers };
    }

    return originalFetch.call(window, input, init);
  };
}
