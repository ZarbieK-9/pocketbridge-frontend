/**
 * Live Scratchpad Feature - Phase 1
 * 
 * CRDT-based collaborative text editor
 * - Offline edits converge
 * - Real-time synchronization
 * - Uses Yjs CRDT (recommended for Phase 1)
 * 
 * CRDT Choice: Yjs
 * - Mature, battle-tested
 * - Efficient binary format
 * - Good offline support
 * - Text editing optimized
 */

import { createEvent } from '@/lib/sync/event-builder';
import { decryptPayload } from '@/lib/crypto/encryption';
import { getEventsByStream } from '@/lib/sync/db';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getWebSocketClient } from '@/lib/ws';
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import type { EncryptedEvent, ScratchpadOpPayload, ScratchpadBatchPayload } from '@/types';

// For Phase 1, we'll use a simple operational transform approach
// In production, you'd use Yjs or Automerge
// This is a simplified CRDT implementation

const SCRATCHPAD_STREAM_ID = 'scratchpad:main';

/**
 * Simple CRDT operation for text editing
 */
export interface TextOperation {
  type: 'insert' | 'delete';
  position: number;
  text?: string; // For insert
  length?: number; // For delete
  timestamp: number;
  deviceId: string;
}

/**
 * Apply operation to text (simple implementation)
 */
export function applyOperation(text: string, op: TextOperation): string {
  if (op.type === 'insert' && op.text !== undefined) {
    return text.slice(0, op.position) + op.text + text.slice(op.position);
  } else if (op.type === 'delete' && op.length !== undefined) {
    return text.slice(0, op.position) + text.slice(op.position + op.length);
  }
  return text;
}

/**
 * Transform operation against another operation (OT)
 * Handles concurrent edits with deterministic conflict resolution
 */
export function transformOperation(
  op1: TextOperation,
  op2: TextOperation,
): TextOperation {
  // Concurrent edit at same position → use deviceId tie-breaking
  if (op1.position === op2.position && op1.timestamp === op2.timestamp) {
    // Deterministic ordering: compare device IDs lexicographically
    // This ensures all devices resolve conflicts the same way
    if (op1.deviceId < op2.deviceId) {
      // op1 wins - no transformation needed
      return op1;
    } else {
      // op2 wins - adjust op1's position
      if (op2.type === 'insert') {
        return { ...op1, position: op1.position + (op2.text?.length || 0) };
      }
    }
  }

  // Simple OT: if op2 happens before op1's position, adjust op1's position
  if (op2.position < op1.position) {
    if (op2.type === 'insert') {
      return { ...op1, position: op1.position + (op2.text?.length || 0) };
    } else if (op2.type === 'delete') {
      return { ...op1, position: Math.max(op2.position, op1.position - (op2.length || 0)) };
    }
  }

  // Handle deletion overlaps
  if (op2.type === 'delete' && op1.type === 'delete') {
    const op2End = op2.position + (op2.length || 0);
    const op1End = op1.position + (op1.length || 0);

    // Check if deletions overlap
    if (op2.position <= op1End && op2End >= op1.position) {
      // Adjust op1 to account for op2's deletion
      const overlapStart = Math.max(op1.position, op2.position);
      const overlapEnd = Math.min(op1End, op2End);
      const overlap = overlapEnd - overlapStart;

      return {
        ...op1,
        length: Math.max(0, (op1.length || 0) - overlap),
      };
    }
  }

  return op1;
}

/**
 * Send scratchpad operation
 */
export async function sendScratchpadOp(
  operation: TextOperation,
): Promise<EncryptedEvent> {
  const deviceId = getOrCreateDeviceId();
  const wsClient = getWebSocketClient();
  const userId = wsClient.getUserId() || undefined;

  const payload: ScratchpadOpPayload = {
    op: JSON.stringify(operation),
    version: Date.now(),
  };

  return await createEvent(
    SCRATCHPAD_STREAM_ID,
    deviceId,
    'scratchpad:op',
    payload,
    userId,
  );
}

/**
 * Batch operation payload for sending multiple operations at once
 */
export interface BatchOpPayload {
  ops: string[]; // Array of serialized operations
  version: number;
  count: number;
}

/**
 * Send multiple operations as a single batch event
 * This is more efficient for offline scenarios where many edits were made
 *
 * @param operations - Array of operations to send
 * @returns Encrypted event containing all operations
 */
export async function sendBatchedOps(
  operations: TextOperation[],
): Promise<EncryptedEvent> {
  const deviceId = getOrCreateDeviceId();
  const wsClient = getWebSocketClient();
  const userId = wsClient.getUserId() || undefined;

  const payload: ScratchpadBatchPayload = {
    ops: operations.map(op => JSON.stringify(op)),
    version: Date.now(),
    count: operations.length,
  };

  const event = await createEvent(
    SCRATCHPAD_STREAM_ID,
    deviceId,
    'scratchpad:batch',
    payload,
    userId,
  );

  console.log(`[Scratchpad] Sent batch of ${operations.length} operations`);
  return event;
}

/**
 * Receive batched operations
 * Extracts all operations from a batch event
 */
export async function receiveBatchedOps(
  event: EncryptedEvent,
): Promise<TextOperation[]> {
  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[Scratchpad] Shared encryption key not available');
      return [];
    }

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as BatchOpPayload;

    const operations = payload.ops.map(op => JSON.parse(op) as TextOperation);
    console.log(`[Scratchpad] Received batch of ${operations.length} operations`);
    return operations;
  } catch (error) {
    console.error('[Scratchpad] Failed to decrypt batch:', error);
    return [];
  }
}

/**
 * Operation buffer for batching offline edits
 * Accumulates operations and sends them in batches when reconnected
 */
export class OperationBuffer {
  private buffer: TextOperation[] = [];
  private batchSize: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelay: number;

  constructor(batchSize: number = 50, flushDelayMs: number = 5000) {
    this.batchSize = batchSize;
    this.flushDelay = flushDelayMs;
  }

  /**
   * Add operation to buffer
   * Automatically flushes when batch size is reached or after delay
   */
  add(operation: TextOperation): void {
    this.buffer.push(operation);

    // Flush immediately if batch size reached
    if (this.buffer.length >= this.batchSize) {
      this.flush();
      return;
    }

    // Otherwise, flush after delay
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.flushDelay);
  }

  /**
   * Flush buffered operations
   * Sends all accumulated operations as a batch
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const toSend = [...this.buffer];
    this.buffer = [];

    try {
      if (toSend.length === 1) {
        // Send single operation normally
        await sendScratchpadOp(toSend[0]);
      } else {
        // Send as batch
        await sendBatchedOps(toSend);
      }

      const wsClient = getWebSocketClient();
      await wsClient.syncPending();
    } catch (error) {
      console.error('[Scratchpad] Failed to flush buffer:', error);
      // Re-add failed operations to buffer
      this.buffer.unshift(...toSend);
    }
  }

  /**
   * Get current buffer size
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Clear buffer without sending
   */
  clear(): void {
    this.buffer = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/**
 * Receive scratchpad operation
 */
export async function receiveScratchpadOp(
  event: EncryptedEvent,
): Promise<TextOperation | null> {
  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[Scratchpad] Shared encryption key not available');
      return null;
    }

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as ScratchpadOpPayload;

    return JSON.parse(payload.op) as TextOperation;
  } catch (error) {
    console.error('[Scratchpad] Failed to decrypt operation:', error);
    return null;
  }
}

/**
 * Scratchpad snapshot for efficient rebuilding
 */
export interface ScratchpadSnapshot {
  text: string;
  version: number; // Last stream_seq applied
  timestamp: number;
}

const SNAPSHOT_KEY = 'scratchpad_snapshot';
const SNAPSHOT_INTERVAL = 100; // Save snapshot every 100 operations

/**
 * Load snapshot from localStorage
 */
function loadSnapshot(): ScratchpadSnapshot | null {
  try {
    const data = localStorage.getItem(SNAPSHOT_KEY);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

/**
 * Save snapshot to localStorage
 */
function saveSnapshot(snapshot: ScratchpadSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.error('[Scratchpad] Failed to save snapshot:', error);
  }
}

/**
 * Rebuild scratchpad text from all operations
 * OPTIMIZED: Uses snapshots to avoid replaying thousands of operations
 */
export async function rebuildScratchpadText(): Promise<string> {
  try {
    const events = await getEventsByStream(SCRATCHPAD_STREAM_ID);

    // Sort by stream_seq (CRITICAL: ensures correct order even if events arrive out of order)
    events.sort((a, b) => a.stream_seq - b.stream_seq);

    // Load snapshot if available
    const snapshot = loadSnapshot();
    let text = snapshot?.text || '';
    let startIndex = 0;

    if (snapshot) {
      // Only replay operations AFTER snapshot
      startIndex = events.findIndex(e => e.stream_seq > snapshot.version);
      if (startIndex === -1) {
        // No new operations since snapshot
        return text;
      }
      console.log(`[Scratchpad] Loaded snapshot (version ${snapshot.version}), replaying ${events.length - startIndex} operations`);
    } else {
      console.log(`[Scratchpad] No snapshot found, rebuilding from ${events.length} operations`);
    }

    // Decrypt and apply operations starting from snapshot
    const operations: TextOperation[] = [];

    for (let i = startIndex; i < events.length; i++) {
      const event = events[i];

      // Handle batch operations
      if (event.type === 'scratchpad:batch') {
        const batchOps = await receiveBatchedOps(event);
        for (const op of batchOps) {
          // Transform against previous operations
          let transformedOp = op;
          for (const prevOp of operations) {
            transformedOp = transformOperation(transformedOp, prevOp);
          }

          // Apply to text
          text = applyOperation(text, transformedOp);
          operations.push(transformedOp);
        }
      } else {
        // Handle single operation
        const op = await receiveScratchpadOp(event);
        if (op) {
          // Transform against previous operations (from this rebuild session only)
          let transformedOp = op;
          for (const prevOp of operations) {
            transformedOp = transformOperation(transformedOp, prevOp);
          }

          // Apply to text
          text = applyOperation(text, transformedOp);
          operations.push(transformedOp);
        }
      }
    }

    // Save snapshot if we've processed enough operations
    const lastEvent = events[events.length - 1];
    if (lastEvent && (!snapshot || events.length - startIndex >= SNAPSHOT_INTERVAL)) {
      saveSnapshot({
        text,
        version: lastEvent.stream_seq,
        timestamp: Date.now(),
      });
      console.log(`[Scratchpad] Saved snapshot at version ${lastEvent.stream_seq}`);
    }

    return text;
  } catch (error) {
    console.error('[Scratchpad] Failed to rebuild text:', error);
    return '';
  }
}

/**
 * Clear scratchpad snapshot (useful when resetting)
 */
export function clearSnapshot(): void {
  localStorage.removeItem(SNAPSHOT_KEY);
}

/**
 * Compact scratchpad by removing old operations
 * Keeps only recent operations after the last snapshot
 *
 * This prevents the database from growing indefinitely with thousands of operations
 *
 * @param keepCount - Number of recent operations to keep (default: 100)
 * @returns Number of operations deleted
 */
export async function compactScratchpad(keepCount: number = 100): Promise<number> {
  try {
    const events = await getEventsByStream(SCRATCHPAD_STREAM_ID);

    if (events.length <= keepCount) {
      console.log(`[Scratchpad] No compaction needed (${events.length} ops < ${keepCount} threshold)`);
      return 0;
    }

    // Sort by stream_seq
    events.sort((a, b) => a.stream_seq - b.stream_seq);

    // Rebuild current text to ensure we have the correct state
    const currentText = await rebuildScratchpadText();

    // Get operations to delete (all except last keepCount)
    const toDelete = events.slice(0, -keepCount);

    // Delete old operations from IndexedDB
    const { deleteEvent } = await import('@/lib/sync/db');
    for (const event of toDelete) {
      await deleteEvent(event.event_id);
    }

    // Update snapshot to reflect compaction
    const lastKeptEvent = events[events.length - keepCount];
    if (lastKeptEvent) {
      saveSnapshot({
        text: currentText,
        version: lastKeptEvent.stream_seq,
        timestamp: Date.now(),
      });
    }

    console.log(`[Scratchpad] Compacted: deleted ${toDelete.length} old operations, kept ${keepCount}`);
    return toDelete.length;
  } catch (error) {
    console.error('[Scratchpad] Failed to compact:', error);
    return 0;
  }
}

/**
 * Auto-compact scratchpad if it grows too large
 * Call this periodically or after receiving new operations
 *
 * @param maxOperations - Trigger compaction when operations exceed this count (default: 500)
 */
export async function autoCompact(maxOperations: number = 500): Promise<void> {
  try {
    const events = await getEventsByStream(SCRATCHPAD_STREAM_ID);

    if (events.length > maxOperations) {
      console.log(`[Scratchpad] Auto-compacting (${events.length} ops > ${maxOperations} threshold)`);
      await compactScratchpad();
    }
  } catch (error) {
    console.error('[Scratchpad] Auto-compact failed:', error);
  }
}







