/**
 * Debug utilities for checking WebSocket configuration
 * These are safe to use in browser console
 */

/**
 * Get the WebSocket URL that the app is using
 * Safe to call from browser console
 */
export function getCurrentWebSocketUrl(): string {
  if (typeof window === 'undefined') {
    return 'Server-side (not available)';
  }

  // Check localStorage first (set via pairing)
  const storedUrl = localStorage.getItem('pocketbridge_ws_url');
  if (storedUrl) {
    return `localStorage: ${storedUrl}`;
  }

  // Check if env var is available (Next.js embeds it at build time)
  // Note: process.env is not available in browser, but Next.js replaces it
  // So we need to check the actual value being used
  const envUrl = (process as any).env?.NEXT_PUBLIC_WS_URL;
  if (envUrl) {
    return `env var: ${envUrl}`;
  }

  // Fallback default
  return 'default: wss://backend-production-7f7ab.up.railway.app/ws';
}

/**
 * Expose debug info to window for browser console access
 */
if (typeof window !== 'undefined') {
  (window as any).pocketbridgeDebug = {
    getWebSocketUrl: getCurrentWebSocketUrl,
    checkConnection: () => {
      const url = getCurrentWebSocketUrl().replace(/^(localStorage|env var|default):\s*/, '');
      console.log('Testing WebSocket connection to:', url);
      const ws = new WebSocket(url);
      ws.onopen = () => {
        console.log('✅ WebSocket connection successful!');
        ws.close();
      };
      ws.onerror = (e) => {
        console.error('❌ WebSocket connection failed:', e);
      };
      ws.onclose = (e) => {
        console.log('WebSocket closed:', e.code, e.reason || 'Normal closure');
      };
    },
    getLocalStorage: () => {
      return {
        wsUrl: localStorage.getItem('pocketbridge_ws_url'),
        deviceId: localStorage.getItem('pocketbridge_device_id'),
        userId: localStorage.getItem('pocketbridge_user_id'),
      };
    },
  };
}

