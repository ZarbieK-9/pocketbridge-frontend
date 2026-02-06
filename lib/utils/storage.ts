/**
 * Storage utilities for PocketBridge web app
 */

const STORAGE_KEYS = {
  WS_URL: 'pocketbridge_ws_url',
  PAIRED_ACCOUNT: 'pocketbridge_paired_account',
};

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

export function setWsUrl(url: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEYS.WS_URL, url);
  }
}

export function getWsUrl(): string | null {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEYS.WS_URL);
    if (!stored) {
      return null;
    }
    if (isLocalhostUrl(stored)) {
      localStorage.removeItem(STORAGE_KEYS.WS_URL);
      return null;
    }
    return stored;
  }
  return null;
}

/**
 * Paired account info - persists across reloads
 */
export interface PairedAccountInfo {
  userId: string;           // The shared user_id (Ed25519 public key)
  displayName?: string;     // User's display name
  pairedAt: number;         // Timestamp when paired
  devices: PairedDeviceInfo[];
  deviceRole?: 'sharer' | 'receiver'; // Role of this device in the pairing
}

export interface PairedDeviceInfo {
  device_id: string;
  device_name?: string;
  device_type?: 'mobile' | 'desktop' | 'web';
  is_online: boolean;
  last_seen: number;
}

/**
 * Save paired account info to localStorage
 */
export function savePairedAccount(info: PairedAccountInfo): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEYS.PAIRED_ACCOUNT, JSON.stringify(info));
  }
}

/**
 * Load paired account info from localStorage
 */
export function loadPairedAccount(): PairedAccountInfo | null {
  if (typeof window === 'undefined') return null;

  const stored = localStorage.getItem(STORAGE_KEYS.PAIRED_ACCOUNT);
  if (!stored) return null;

  try {
    return JSON.parse(stored) as PairedAccountInfo;
  } catch {
    return null;
  }
}

/**
 * Update paired devices in the stored account info
 */
export function updatePairedDevices(devices: PairedDeviceInfo[], displayName?: string): void {
  if (typeof window === 'undefined') return;

  const existing = loadPairedAccount();
  if (existing) {
    existing.devices = devices;
    if (displayName) {
      existing.displayName = displayName;
    }
    savePairedAccount(existing);
  }
}

/**
 * Clear paired account info
 */
export function clearPairedAccount(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEYS.PAIRED_ACCOUNT);
  }
}

