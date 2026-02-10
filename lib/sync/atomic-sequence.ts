/**
 * Atomic sequence number generator for cross-tab coordination
 *
 * Prevents duplicate sequence numbers when multiple browser tabs
 * create events simultaneously.
 *
 * Uses localStorage-based locking mechanism to ensure atomic
 * read-modify-write operations across all tabs.
 */

const LOCK_KEY = 'pocketbridge_seq_lock';
const SEQ_KEY = 'pocketbridge_device_seq';
const LOCK_TIMEOUT = 5000; // 5 seconds - stale lock cleanup
const MAX_RETRY_ATTEMPTS = 20; // 20 attempts × 50ms = 1 second max wait
const RETRY_DELAY = 50; // 50ms between retries

/**
 * Atomic sequence generator
 * Prevents race conditions when multiple tabs generate sequence numbers
 */
export class AtomicSequenceGenerator {
  /**
   * Try to acquire the lock
   * Returns true if lock acquired, false if another tab holds it
   */
  private static async acquireLock(): Promise<boolean> {
    if (typeof window === 'undefined') return true; // Server-side: no locking needed

    const now = Date.now();
    const lock = localStorage.getItem(LOCK_KEY);

    if (lock) {
      const lockTime = parseInt(lock, 10);

      // Check if lock is stale (holder crashed or took too long)
      if (now - lockTime > LOCK_TIMEOUT) {
        console.warn('[AtomicSeq] Stale lock detected, taking over');
        localStorage.setItem(LOCK_KEY, now.toString());
        return true;
      }

      // Lock held by another tab
      return false;
    }

    // No lock exists, acquire it
    localStorage.setItem(LOCK_KEY, now.toString());

    // Double-check we got it (another tab might have written simultaneously)
    // This handles race condition where two tabs check at the same time
    await new Promise(resolve => setTimeout(resolve, 1));
    const verify = localStorage.getItem(LOCK_KEY);
    return verify === now.toString();
  }

  /**
   * Release the lock
   */
  private static releaseLock(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(LOCK_KEY);
  }

  /**
   * Get next sequence number atomically
   *
   * This method guarantees that no two tabs will ever receive
   * the same sequence number, even if they call this simultaneously.
   *
   * @returns Next sequence number
   * @throws Error if lock acquisition fails after max retries
   */
  static async getNextSeq(): Promise<number> {
    // Server-side: use simple increment (no cross-process coordination)
    if (typeof window === 'undefined') {
      const current = parseInt(
        (global as any).__mockSeq || '0',
        10
      );
      const next = current + 1;
      (global as any).__mockSeq = next.toString();
      return next;
    }

    // Try to acquire lock with retry
    let attempts = 0;
    while (attempts < MAX_RETRY_ATTEMPTS) {
      if (await this.acquireLock()) {
        try {
          // Critical section - atomic read-modify-write
          const current = parseInt(
            localStorage.getItem(SEQ_KEY) || '0',
            10
          );
          const next = current + 1;
          localStorage.setItem(SEQ_KEY, next.toString());

          return next;
        } finally {
          // Always release lock, even if error occurs
          this.releaseLock();
        }
      }

      // Wait before retry (exponential backoff for fairness)
      const backoff = RETRY_DELAY * (1 + attempts * 0.1);
      await new Promise(resolve => setTimeout(resolve, backoff));
      attempts++;
    }

    // Failed to acquire lock - this should be rare
    console.error('[AtomicSeq] Failed to acquire lock after max retries');
    throw new Error(
      `Failed to acquire sequence lock after ${MAX_RETRY_ATTEMPTS} attempts. ` +
      'Multiple tabs may be creating events too rapidly.'
    );
  }

  /**
   * Set sequence number (used for sync from server)
   * Only updates if new value is higher than current
   *
   * @param seq - New sequence number from server
   */
  static async setSeq(seq: number): Promise<void> {
    if (typeof window === 'undefined') {
      (global as any).__mockSeq = seq.toString();
      return;
    }

    // Acquire lock to ensure atomic update
    let attempts = 0;
    while (attempts < MAX_RETRY_ATTEMPTS) {
      if (await this.acquireLock()) {
        try {
          const current = parseInt(
            localStorage.getItem(SEQ_KEY) || '0',
            10
          );

          // Always trust server's value (handles pairing reset)
          if (seq !== current) {
            localStorage.setItem(SEQ_KEY, seq.toString());
            console.log(`[AtomicSeq] Updated sequence: ${current} → ${seq}`);
          }

          return;
        } finally {
          this.releaseLock();
        }
      }

      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      attempts++;
    }

    console.error('[AtomicSeq] Failed to set sequence after max retries');
  }

  /**
   * Get current sequence number (non-atomic read)
   * Only use for display purposes, not for generating new sequences
   */
  static getCurrentSeq(): number {
    if (typeof window === 'undefined') {
      return parseInt((global as any).__mockSeq || '0', 10);
    }

    return parseInt(localStorage.getItem(SEQ_KEY) || '0', 10);
  }

  /**
   * Reset sequence to 0 (used after pairing/identity change)
   */
  static async reset(): Promise<void> {
    await this.setSeq(0);
  }
}
