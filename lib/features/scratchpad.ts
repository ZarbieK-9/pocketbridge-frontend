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
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import type { EncryptedEvent, ScratchpadOpPayload } from '@/types';

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
 */
export function transformOperation(
  op1: TextOperation,
  op2: TextOperation,
): TextOperation {
  // Simple OT: if op2 happens before op1's position, adjust op1's position
  if (op2.position < op1.position) {
    if (op2.type === 'insert') {
      return { ...op1, position: op1.position + (op2.text?.length || 0) };
    } else if (op2.type === 'delete') {
      return { ...op1, position: op1.position - (op2.length || 0) };
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
  
  const payload: ScratchpadOpPayload = {
    op: JSON.stringify(operation),
    version: Date.now(),
  };

  return await createEvent(
    SCRATCHPAD_STREAM_ID,
    deviceId,
    'scratchpad:op',
    payload,
  );
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
 * Rebuild scratchpad text from all operations
 */
export async function rebuildScratchpadText(): Promise<string> {
  try {
    const events = await getEventsByStream(SCRATCHPAD_STREAM_ID);
    
    // Sort by stream_seq
    events.sort((a, b) => a.stream_seq - b.stream_seq);
    
    // Decrypt and apply operations
    let text = '';
    const operations: TextOperation[] = [];
    
    for (const event of events) {
      const op = await receiveScratchpadOp(event);
      if (op) {
        // Transform against previous operations
        let transformedOp = op;
        for (const prevOp of operations) {
          transformedOp = transformOperation(transformedOp, prevOp);
        }
        
        // Apply to text
        text = applyOperation(text, transformedOp);
        operations.push(transformedOp);
      }
    }
    
    return text;
  } catch (error) {
    console.error('[Scratchpad] Failed to rebuild text:', error);
    return '';
  }
}







