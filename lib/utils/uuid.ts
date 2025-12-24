/**
 * UUID Generation Utilities - Phase 1
 * 
 * Uses proper UUIDv7 library for event_id
 * Falls back to UUIDv4 for device_id
 */

import { uuidv7 } from 'uuidv7';
import { randomUUID } from 'crypto';

/**
 * Generate UUIDv7 (time-ordered)
 * Uses uuidv7 library for proper implementation
 */
export function generateUUIDv7(): string {
  return uuidv7();
}

/**
 * Generate UUIDv4 (for device_id)
 */
export function generateUUIDv4(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Legacy function for backward compatibility
 * Now generates UUIDv7 for events
 */
export function generateUUID(): string {
  return generateUUIDv7();
}
