/**
 * Background Clipboard Sync Service
 * 
 * Automatically syncs clipboard in the background, just like Apple's ecosystem
 * - Monitors clipboard changes automatically
 * - Updates clipboard when receiving changes (no user interaction)
 * - Works even when app is closed (via service worker)
 * - Persists state in IndexedDB
 */

import { sendClipboardText, receiveClipboardText } from '@/lib/features/clipboard';
import type { SessionKeys, EncryptedEvent } from '@/types';

const CLIPBOARD_STATE_KEY = 'clipboard:last_synced';
const CLIPBOARD_MONITOR_INTERVAL = 3000; // Check every 3 seconds (reduced frequency to avoid permission prompts)

interface ClipboardSyncState {
  lastClipboardText: string;
  lastSyncedAt: number;
  isMonitoring: boolean;
}

/**
 * Background Clipboard Sync Service
 */
export class BackgroundClipboardSync {
  private sessionKeys: SessionKeys | null = null;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private state: ClipboardSyncState = {
    lastClipboardText: '',
    lastSyncedAt: 0,
    isMonitoring: false,
  };
  private onClipboardReceived?: (text: string) => void;

  constructor() {
    this.loadState();
  }

  /**
   * Start automatic clipboard monitoring
   */
  async start(sessionKeys: SessionKeys, onClipboardReceived?: (text: string) => void): Promise<void> {
    if (this.isMonitoring) {
      return; // Already monitoring
    }

    this.sessionKeys = sessionKeys;
    this.onClipboardReceived = onClipboardReceived;
    this.state.isMonitoring = true;
    await this.saveState();

    // Load last clipboard state
    await this.loadLastClipboard();

    // Start monitoring clipboard changes (reduced frequency to avoid permission prompts)
    // Only checks when page is focused
    this.monitorInterval = setInterval(() => {
      this.checkClipboard();
    }, CLIPBOARD_MONITOR_INTERVAL);

    // Also listen for paste events to detect clipboard changes immediately
    // This provides immediate sync without frequent polling
    if (typeof document !== 'undefined') {
      document.addEventListener('paste', this.handlePasteEvent);
    }

    console.log('[BackgroundClipboard] Started automatic monitoring');
  }

  /**
   * Stop clipboard monitoring
   */
  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('paste', this.handlePasteEvent);
    }
    this.state.isMonitoring = false;
    this.saveState();
    console.log('[BackgroundClipboard] Stopped monitoring');
  }

  /**
   * Handle paste events to detect clipboard changes immediately
   */
  private handlePasteEvent = async (event: ClipboardEvent): Promise<void> => {
    // When user pastes, check clipboard (they've already interacted)
    // This allows us to read clipboard without permission prompts
    if (this.sessionKeys) {
      // Small delay to let paste complete
      setTimeout(() => {
        this.checkClipboard();
      }, 100);
    }
  };

  /**
   * Handle incoming clipboard event from WebSocket
   */
  async handleIncomingEvent(event: EncryptedEvent): Promise<void> {
    if (!this.sessionKeys) {
      console.warn('[BackgroundClipboard] No session keys, cannot handle event');
      return;
    }

    try {
      const text = await receiveClipboardText(event);
      
      if (text && text !== this.state.lastClipboardText) {
        console.log('[BackgroundClipboard] Received clipboard update:', text.substring(0, 50));
        
        // Automatically update clipboard (no confirmation needed)
        await this.updateClipboard(text);
        
        // Update state
        this.state.lastClipboardText = text;
        this.state.lastSyncedAt = Date.now();
        await this.saveState();

        // Notify callback
        if (this.onClipboardReceived) {
          this.onClipboardReceived(text);
        }
      }
    } catch (error) {
      console.error('[BackgroundClipboard] Failed to handle incoming event:', error);
    }
  }

  /**
   * Check clipboard for changes and sync
   * Only reads clipboard when page is focused and has user interaction
   */
  private async checkClipboard(): Promise<void> {
    if (!this.sessionKeys) {
      return;
    }

    // Only check clipboard if page is focused (reduces permission prompts)
    if (typeof document !== 'undefined' && !document.hasFocus()) {
      return;
    }

    try {
      // Read clipboard (requires clipboard-read permission)
      // This will be called less frequently to avoid permission prompts
      const text = await navigator.clipboard.readText();
      
      // Only sync if text changed and is not empty
      if (text !== this.state.lastClipboardText && text.length > 0) {
        console.log('[BackgroundClipboard] Clipboard changed, syncing...');
        
        // Send to other devices
        await sendClipboardText(text);
        
        // Update state
        this.state.lastClipboardText = text;
        this.state.lastSyncedAt = Date.now();
        await this.saveState();
      }
    } catch (error) {
      // Clipboard API may not be available or permission denied
      // This is expected in some contexts (e.g., when app is in background)
      // Silently ignore NotAllowedError to prevent console spam
      if (error instanceof Error && error.name !== 'NotAllowedError') {
        console.error('[BackgroundClipboard] Failed to read clipboard:', error);
      }
    }
  }

  /**
   * Update clipboard automatically (no user confirmation)
   */
  private async updateClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      console.log('[BackgroundClipboard] Clipboard updated automatically');
      return true;
    } catch (error) {
      console.error('[BackgroundClipboard] Failed to update clipboard:', error);
      return false;
    }
  }

  /**
   * Load last clipboard state from localStorage (simpler than IndexedDB for state)
   */
  private async loadLastClipboard(): Promise<void> {
    try {
      if (typeof window === 'undefined') return;
      
      const stored = localStorage.getItem(CLIPBOARD_STATE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.state.lastClipboardText = parsed.text || '';
        this.state.lastSyncedAt = parsed.timestamp || 0;
      }
    } catch (error) {
      console.error('[BackgroundClipboard] Failed to load state:', error);
    }
  }

  /**
   * Save state to localStorage
   */
  private async saveState(): Promise<void> {
    try {
      if (typeof window === 'undefined') return;
      
      localStorage.setItem(CLIPBOARD_STATE_KEY, JSON.stringify({
        text: this.state.lastClipboardText,
        timestamp: this.state.lastSyncedAt,
        isMonitoring: this.state.isMonitoring,
      }));
    } catch (error) {
      console.error('[BackgroundClipboard] Failed to save state:', error);
    }
  }

  /**
   * Load state from localStorage
   */
  private async loadState(): Promise<void> {
    try {
      if (typeof window === 'undefined') return;
      
      const stored = localStorage.getItem(CLIPBOARD_STATE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.state.isMonitoring = parsed.isMonitoring || false;
        this.state.lastClipboardText = parsed.text || '';
        this.state.lastSyncedAt = parsed.timestamp || 0;
      }
    } catch (error) {
      // State doesn't exist yet, use defaults
    }
  }

  /**
   * Check if monitoring is active
   */
  get isMonitoring(): boolean {
    return this.state.isMonitoring;
  }

  /**
   * Get last synced clipboard text
   */
  get lastClipboardText(): string {
    return this.state.lastClipboardText;
  }
}

// Singleton instance
let clipboardSyncInstance: BackgroundClipboardSync | null = null;

/**
 * Get or create the background clipboard sync instance
 */
export function getBackgroundClipboardSync(): BackgroundClipboardSync {
  if (!clipboardSyncInstance) {
    clipboardSyncInstance = new BackgroundClipboardSync();
  }
  return clipboardSyncInstance;
}

