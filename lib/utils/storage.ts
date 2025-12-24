/**
 * Storage utilities for PocketBridge web app
 */

export function setWsUrl(url: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('pocketbridge_ws_url', url);
  }
}

export function getWsUrl(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('pocketbridge_ws_url');
  }
  return null;
}

