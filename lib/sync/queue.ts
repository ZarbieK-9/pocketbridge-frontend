/**
 * Offline event queue management - Phase 1
 * 
 * Handles event queuing, dequeuing, and synchronization tracking
 * Uses lastAckDeviceSeq (single value) instead of per-device tracking
 */

import { STORAGE_KEYS } from '@/lib/constants';
import { addEvent, getPendingEvents, getDatabase } from './db';
import { STORE_EVENTS } from '@/lib/constants';
import type { EncryptedEvent, QueueStatus } from '@/types';

/**
 * Event queue manager for offline-first operation - Phase 1
 * 
 * Implements queue limits to prevent unbounded growth
 */
export class EventQueue {
  private lastAckDeviceSeq: number = 0; // Single value for this device
  private deviceSeq: number = 0; // Monotonic sequence for this device
  private readonly MAX_QUEUE_SIZE = 10000; // Maximum events in queue
  private readonly MAX_QUEUE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB max

  constructor() {
    this.loadLastAckDeviceSeq();
    this.loadDeviceSeq();
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
   * Load device sequence number from localStorage
   */
  private loadDeviceSeq(): void {
    if (typeof window === 'undefined') return;

    const stored = localStorage.getItem('pocketbridge_device_seq');
    if (stored) {
      this.deviceSeq = Number.parseInt(stored, 10) || 0;
    }
  }

  /**
   * Save last acknowledged device sequence to localStorage
   */
  private saveLastAckDeviceSeq(): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEYS.LAST_ACK_SEQ, this.lastAckDeviceSeq.toString());
  }

  /**
   * Save device sequence number to localStorage
   */
  private saveDeviceSeq(): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem('pocketbridge_device_seq', this.deviceSeq.toString());
  }

  /**
   * Get next device sequence number (monotonic)
   */
  getNextSeq(): number {
    this.deviceSeq++;
    this.saveDeviceSeq();
    return this.deviceSeq;
  }

  /**
   * Sync device sequence to ensure it's at least lastAckDeviceSeq + 1
   * This prevents sending events with device_seq <= last_ack_device_seq
   */
  syncDeviceSeq(lastAckDeviceSeq: number): void {
    // Ensure deviceSeq is at least lastAckDeviceSeq + 1
    // This way the next event will have device_seq > lastAckDeviceSeq
    if (this.deviceSeq <= lastAckDeviceSeq) {
      this.deviceSeq = lastAckDeviceSeq + 1;
      this.saveDeviceSeq();
      console.log(`[Phase1] Synced deviceSeq to ${this.deviceSeq} (lastAckDeviceSeq: ${lastAckDeviceSeq})`);
    }
  }

  /**
   * Enqueue an encrypted event
   * Enforces queue size limits
   */
  async enqueue(event: EncryptedEvent): Promise<void> {
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
   */
  async getPending(): Promise<EncryptedEvent[]> {
    return await getPendingEvents(this.lastAckDeviceSeq);
  }

  /**
   * Mark events up to a device sequence number as acknowledged
   */
  acknowledge(deviceId: string, seq: number): void {
    // Phase 1: Only acknowledge events from this device
    if (deviceId === this.getDeviceId()) {
      this.lastAckDeviceSeq = Math.max(this.lastAckDeviceSeq, seq);
      this.saveLastAckDeviceSeq();
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
   * Reset queue (clear all acknowledgments)
   */
  reset(): void {
    this.lastAckDeviceSeq = 0;
    this.deviceSeq = 0;
    this.saveLastAckDeviceSeq();
    this.saveDeviceSeq();
  }

  /**
   * Clear all events from the queue (for full resync)
   */
  async clear(): Promise<void> {
    const { clearDatabase } = await import('./db');
    await clearDatabase();
    this.reset();
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
