/**
 * Offline event queue management - Phase 1
 * 
 * Handles event queuing, dequeuing, and synchronization tracking
 * Uses lastAckDeviceSeq (single value) instead of per-device tracking
 */

import { STORAGE_KEYS } from '@/lib/constants';
import { addEvent, getPendingEvents, getDatabase, deleteAcknowledgedEvents, deleteOrphanedEvents } from './db';
import { STORE_EVENTS } from '@/lib/constants';
import type { EncryptedEvent, QueueStatus } from '@/types';
import { AtomicSequenceGenerator } from './atomic-sequence';

/**
 * Event queue manager for offline-first operation - Phase 1
 * 
 * Implements queue limits to prevent unbounded growth
 */
export class EventQueue {
  private lastAckDeviceSeq: number = 0; // Single value for this device
  private readonly MAX_QUEUE_SIZE = 10000; // Maximum events in queue
  private readonly MAX_QUEUE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB max
  private inFlightEvents = new Set<string>(); // Track events being sent (prevents duplicate sends)

  constructor() {
    this.loadLastAckDeviceSeq();
  }

  /**
   * Load last acknowledged device sequence from localStorage
   */
  private loadLastAckDeviceSeq(): void {
    if (typeof window === 'undefined') return;

    const stored = localStorage.getItem(STORAGE_KEYS.LAST_ACK_SEQ);
    if (stored) {
      try {
        // Phase 1: Single value, not per-device
        const parsed = JSON.parse(stored);
        this.lastAckDeviceSeq = typeof parsed === 'number' ? parsed : parsed[this.getDeviceId()] || 0;
      } catch (error) {
        console.error('[Phase1] Failed to load last ack device seq:', error);
        this.lastAckDeviceSeq = 0;
      }
    }
  }

  /**
   * Get device ID from localStorage
   */
  private getDeviceId(): string {
    if (typeof window === 'undefined') return 'unknown';
    return localStorage.getItem('pocketbridge_device_id') || 'unknown';
  }

  /**
   * Load device sequence number from localStorage (deprecated)
   * Now handled by AtomicSequenceGenerator
   */
  private loadDeviceSeq(): void {
    // No-op: sequence is now managed by AtomicSequenceGenerator
    // This method kept for backwards compatibility
  }

  /**
   * Save last acknowledged device sequence to localStorage
   */
  private saveLastAckDeviceSeq(): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEYS.LAST_ACK_SEQ, this.lastAckDeviceSeq.toString());
  }

  /**
   * Set last acknowledged sequence from server and sync device sequence
   * Used after session establishment to align local counters with server state
   *
   * IMPORTANT: Always trust the server's value. If server says 0 (e.g., after pairing reset),
   * we MUST update our local state even if our local value is higher.
   */
  async setLastAckFromServer(seq: number): Promise<void> {
    // Ensure seq is a number (defensive against string values from server)
    const numSeq = typeof seq === 'string' ? parseInt(seq, 10) : seq;
    if (isNaN(numSeq)) {
      console.warn('[Queue] Invalid seq value:', seq);
      return;
    }

    // ALWAYS trust the server's value - this is the authoritative state
    // Previously we only updated if numSeq > lastAckDeviceSeq, but this caused issues
    // when server resets to 0 (e.g., after pairing) and client has a higher local value
    if (numSeq !== this.lastAckDeviceSeq) {
      console.log(`[Queue] Server sync: updating lastAckDeviceSeq from ${this.lastAckDeviceSeq} to ${numSeq}`);
      this.lastAckDeviceSeq = numSeq;
      this.saveLastAckDeviceSeq();
    }
    // Keep device sequence ahead of lastAck
    await this.syncDeviceSeq(this.lastAckDeviceSeq);
  }

  /**
   * Save device sequence number to localStorage (deprecated)
   * Now handled by AtomicSequenceGenerator
   */
  private saveDeviceSeq(): void {
    // No-op: sequence is now managed by AtomicSequenceGenerator
  }

  /**
   * Get next device sequence number (monotonic, cross-tab safe)
   * Uses atomic sequence generator to prevent duplicate sequences across tabs
   */
  async getNextSeq(): Promise<number> {
    return await AtomicSequenceGenerator.getNextSeq();
  }

  /**
   * Sync device sequence to ensure it's at least lastAckDeviceSeq + 1
   * This prevents sending events with device_seq <= last_ack_device_seq
   */
  async syncDeviceSeq(lastAckDeviceSeq: number): Promise<void> {
    // Ensure the stored counter is at least lastAckDeviceSeq so that
    // getNextSeq() (which returns stored + 1) produces lastAckDeviceSeq + 1.
    const currentSeq = AtomicSequenceGenerator.getCurrentSeq();
    if (currentSeq < lastAckDeviceSeq) {
      await AtomicSequenceGenerator.setSeq(lastAckDeviceSeq);
      console.log(`[Phase1] Synced deviceSeq to ${lastAckDeviceSeq} (next event will be ${lastAckDeviceSeq + 1})`);
    }
  }

  /**
   * Enqueue an encrypted event
   * Enforces queue size limits and handles storage quota
   */
  async enqueue(event: EncryptedEvent): Promise<void> {
    try {
      // Check storage quota BEFORE adding (proactive)
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
        try {
          const estimate = await navigator.storage.estimate();
          const usage = (estimate.usage || 0) / (estimate.quota || 1);

          // If using > 90% of quota, evict aggressively
          if (usage > 0.9) {
            console.warn(`[Queue] Storage quota at ${Math.round(usage * 100)}%, evicting old events`);
            await this.evictOldestEvents(500); // Evict more aggressively
          }
        } catch (estimateError) {
          // Some browsers don't support storage.estimate()
          console.debug('[Queue] Storage estimate not supported:', estimateError);
        }
      }

      // Check queue size before adding
      const pending = await this.getPending();

      // Check count limit
      if (pending.length >= this.MAX_QUEUE_SIZE) {
        console.warn('[Queue] Queue size limit reached, removing oldest events');
        await this.evictOldestEvents(100); // Remove 100 oldest
      }

      // Check size limit (approximate)
      const eventSize = event.encrypted_payload.length;
      const totalSize = pending.reduce((sum, e) => sum + e.encrypted_payload.length, 0);
      if (totalSize + eventSize > this.MAX_QUEUE_SIZE_BYTES) {
        console.warn('[Queue] Queue size (bytes) limit reached, removing oldest events');
        await this.evictOldestEvents(100);
      }

      await addEvent(event);
    } catch (error: any) {
      // Handle QuotaExceededError gracefully
      if (error.name === 'QuotaExceededError' || error.code === 22) {
        console.error('[Queue] Storage quota exceeded, attempting emergency eviction');

        // Emergency eviction - remove 1000 oldest events
        try {
          await this.evictOldestEvents(1000);
        } catch (evictError) {
          console.error('[Queue] Emergency eviction failed:', evictError);
        }

        // Retry adding the event once
        try {
          await addEvent(event);
          console.log('[Queue] Event added after emergency eviction');
        } catch (retryError: any) {
          // Still failed - notify user via custom event
          this.notifyStorageFull();
          throw new Error(
            'Storage quota exceeded. Please reconnect to sync data or free up browser storage.'
          );
        }
      } else {
        // Re-throw other errors
        throw error;
      }
    }
  }

  /**
   * Notify user that storage is full
   * Dispatches custom event that UI can listen to
   */
  private notifyStorageFull(): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pocketbridge-storage-quota-exceeded', {
        detail: {
          message: 'Local storage full. Reconnect to sync data or clear browser storage.',
          timestamp: Date.now(),
        }
      }));
      console.error('[Queue] Storage quota exceeded - user notification dispatched');
    }
  }

  /**
   * Evict oldest events from queue (LRU-style)
   */
  private async evictOldestEvents(count: number): Promise<void> {
    try {
      // Use the already imported getDatabase function
      const db = await getDatabase();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_EVENTS], 'readwrite');
        const store = transaction.objectStore(STORE_EVENTS);
        const index = store.index('created_at');
        const request = index.openCursor(null, 'next');

        let evicted = 0;
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result;
          if (cursor && evicted < count) {
            cursor.delete();
            evicted++;
            cursor.continue();
          } else {
            resolve(undefined);
          }
        };

        request.onerror = () => {
          reject(new Error('Failed to evict events'));
        };

        transaction.oncomplete = () => {
          if (evicted < count) {
            resolve(undefined);
          }
        };
        
        transaction.onerror = () => {
          reject(new Error('Transaction failed'));
        };
      });
    } catch (error) {
      console.error('[Queue] Failed to evict old events:', error);
      // Don't throw - queue will continue to work
    }
  }

  /**
   * Get all pending events that need to be synced
   * Only returns events from this device to avoid resending other devices' events
   * Filters out events that are currently in-flight to prevent duplicates
   */
  async getPending(): Promise<EncryptedEvent[]> {
    const allPending = await getPendingEvents(this.lastAckDeviceSeq, this.getDeviceId());

    // Filter out events currently being sent (prevents duplicate sends during network flapping)
    return allPending.filter(e => !this.inFlightEvents.has(e.event_id));
  }

  /**
   * Mark event as in-flight (being sent)
   * Call this before sending an event to prevent duplicate sends
   */
  markInFlight(eventId: string): void {
    this.inFlightEvents.add(eventId);
  }

  /**
   * Remove event from in-flight set
   * Call this after event is acknowledged OR if send fails
   */
  clearInFlight(eventId: string): void {
    this.inFlightEvents.delete(eventId);
  }

  /**
   * Get count of events currently being sent
   */
  getInFlightCount(): number {
    return this.inFlightEvents.size;
  }

  /**
   * Mark events up to a device sequence number as acknowledged
   * Also clears events from in-flight tracking
   */
  async acknowledge(deviceId: string, seq: number): Promise<void> {
    // Phase 1: Only acknowledge events from this device
    if (deviceId === this.getDeviceId()) {
      this.lastAckDeviceSeq = Math.max(this.lastAckDeviceSeq, seq);
      this.saveLastAckDeviceSeq();

      // Clear acknowledged events from in-flight set
      // Get all events up to this sequence and remove from tracking
      try {
        const acknowledged = await getPendingEvents(0, deviceId);
        for (const event of acknowledged) {
          if (event.device_seq <= seq) {
            this.inFlightEvents.delete(event.event_id);
          }
        }
      } catch (error) {
        console.error('[Queue] Failed to clear in-flight events:', error);
      }
    }
  }

  /**
   * Get queue status
   */
  async getStatus(): Promise<QueueStatus> {
    const pending = await this.getPending();

    return {
      pending: pending.length,
      lastSync: pending.length > 0 ? Math.max(...pending.map(e => e.created_at || 0)) : null,
      lastAckDeviceSeq: this.lastAckDeviceSeq,
    };
  }

  /**
   * Get last acknowledged device sequence (synchronous getter)
   * This is the single source of truth for the device's sequence tracking
   */
  getLastAckDeviceSeq(): number {
    return this.lastAckDeviceSeq;
  }

  /**
   * Reset queue (clear all acknowledgments)
   */
  async reset(): Promise<void> {
    this.lastAckDeviceSeq = 0;
    this.saveLastAckDeviceSeq();
    this.inFlightEvents.clear();
    await AtomicSequenceGenerator.reset();
  }

  /**
   * Clear all events from the queue (for full resync)
   */
  async clear(): Promise<void> {
    const { clearDatabase } = await import('./db');
    await clearDatabase();
    await this.reset();
  }

  /**
   * Clean up acknowledged and orphaned events from IndexedDB
   * This should be called periodically to prevent unbounded growth
   * @param currentUserId - The current user's ID to identify orphaned events
   * @returns Number of events deleted
   */
  async cleanup(currentUserId: string): Promise<number> {
    try {
      const deletedCount = await deleteAcknowledgedEvents(this.lastAckDeviceSeq, currentUserId);
      if (deletedCount > 0) {
        console.log(`[Queue] Cleaned up ${deletedCount} acknowledged/orphaned events`);
      }
      return deletedCount;
    } catch (error) {
      console.error('[Queue] Failed to cleanup events:', error);
      return 0;
    }
  }

  /**
   * Clean up only orphaned events (events from different userId)
   * Use this when you want to clean up events from old identity without affecting current events
   * @param currentUserId - The current user's ID
   * @returns Number of events deleted
   */
  async cleanupOrphaned(currentUserId: string): Promise<number> {
    try {
      const deletedCount = await deleteOrphanedEvents(currentUserId);
      if (deletedCount > 0) {
        console.log(`[Queue] Cleaned up ${deletedCount} orphaned events from old identity`);
      }
      return deletedCount;
    } catch (error) {
      console.error('[Queue] Failed to cleanup orphaned events:', error);
      return 0;
    }
  }
}

/**
 * Singleton instance of event queue
 */
let queueInstance: EventQueue | null = null;

export function getEventQueue(): EventQueue {
  if (!queueInstance) {
    queueInstance = new EventQueue();
  }
  return queueInstance;
}

/**
 * Reset the queue singleton and clear all sequence counters
 * Call this when identity keypair changes (e.g., after pairing)
 * to ensure device_seq starts fresh with the new identity
 */
export async function resetEventQueue(): Promise<void> {
  if (queueInstance) {
    await queueInstance.reset();
  }
  // Also clear localStorage directly in case queue wasn't instantiated
  if (typeof window !== 'undefined') {
    localStorage.removeItem('pocketbridge_device_seq');
    localStorage.removeItem(STORAGE_KEYS.LAST_ACK_SEQ);
    console.log('[Queue] Reset event queue and sequence counters for identity change');
  }
  // Reset atomic sequence generator
  await AtomicSequenceGenerator.reset();
  // Reset singleton so next getEventQueue() creates fresh instance
  queueInstance = null;
}
