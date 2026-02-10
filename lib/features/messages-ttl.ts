/**
 * TTL Management for Secret Messages
 *
 * Handles:
 * - Auto-deletion of expired messages (client-side enforcement)
 * - Relative TTL (fixes clock skew issues)
 * - Expiry warnings (notify before deletion)
 * - Cross-device deletion sync
 */

import { deleteMessagePayload } from './messages';
import { getEventsByStream } from '@/lib/sync/db';
import { createEvent } from '@/lib/sync/event-builder';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getWebSocketClient } from '@/lib/ws';
import type { MessageReadReceiptPayload } from '@/types';

const MESSAGES_STREAM_ID = 'messages:main';
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Extended message interface with TTL support
 */
export interface ChatMessageWithTTL {
  id: string;
  text: string;
  timestamp: number;
  deviceId: string;
  isLocal: boolean;
  expiresAt?: number; // Absolute expiry time (Unix timestamp)
  ttlSeconds?: number; // Original TTL duration for display
}

/**
 * Start automatic TTL cleanup
 * Checks every 5 seconds for expired messages and deletes them
 *
 * @param onMessageDeleted - Callback when message is auto-deleted
 */
export function startTTLCleanup(
  onMessageDeleted: (messageId: string) => void
): void {
  if (cleanupInterval) {
    console.warn('[TTL] Cleanup already running');
    return;
  }

  console.log('[TTL] Starting automatic cleanup (every 5s)');

  cleanupInterval = setInterval(async () => {
    try {
      const events = await getEventsByStream(MESSAGES_STREAM_ID);
      const now = Date.now();
      let deletedCount = 0;

      for (const event of events) {
        // Check event TTL (old format - absolute timestamp)
        if (event.ttl && event.ttl < now) {
          await deleteMessagePayload(event.event_id);
          onMessageDeleted(event.event_id);
          deletedCount++;
          console.log(`[TTL] Auto-deleted expired message: ${event.event_id}`);
        }

        // Check custom expiresAt metadata (new format)
        const metadata = (event as any).metadata;
        if (metadata?.expiresAt && metadata.expiresAt < now) {
          await deleteMessagePayload(event.event_id);
          onMessageDeleted(event.event_id);
          deletedCount++;
          console.log(`[TTL] Auto-deleted expired message (metadata): ${event.event_id}`);
        }
      }

      if (deletedCount > 0) {
        console.log(`[TTL] Cleaned up ${deletedCount} expired messages`);
      }
    } catch (error) {
      console.error('[TTL] Cleanup error:', error);
    }
  }, 5000); // Check every 5 seconds
}

/**
 * Stop automatic TTL cleanup
 */
export function stopTTLCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('[TTL] Stopped automatic cleanup');
  }
}

/**
 * Calculate expiry time using relative TTL
 * This fixes clock skew issues between devices
 *
 * @param ttlSeconds - Duration until expiry (e.g., 30 for 30 seconds)
 * @returns Unix timestamp when message should expire
 */
export function calculateExpiryTime(ttlSeconds: number): number {
  return Date.now() + (ttlSeconds * 1000);
}

/**
 * Setup expiry warnings for messages
 * Notifies user before message disappears
 *
 * @param messages - List of messages with expiry times
 * @param onWarning - Callback with (messageId, secondsLeft)
 */
export function setupExpiryWarnings(
  messages: ChatMessageWithTTL[],
  onWarning: (messageId: string, secondsLeft: number) => void
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];

  for (const msg of messages) {
    if (!msg.expiresAt) continue;

    const timeLeft = msg.expiresAt - Date.now();

    // Warn at 10 seconds remaining
    if (timeLeft > 10000 && timeLeft <= 15000) {
      const timer = setTimeout(() => {
        onWarning(msg.id, 10);
      }, timeLeft - 10000);
      timers.push(timer);
    }

    // Warn at 5 seconds remaining
    if (timeLeft > 5000 && timeLeft <= 10000) {
      const timer = setTimeout(() => {
        onWarning(msg.id, 5);
      }, timeLeft - 5000);
      timers.push(timer);
    }

    // Final warning at 3 seconds
    if (timeLeft > 3000 && timeLeft <= 5000) {
      const timer = setTimeout(() => {
        onWarning(msg.id, 3);
      }, timeLeft - 3000);
      timers.push(timer);
    }
  }

  // Return cleanup function
  return () => {
    timers.forEach(timer => clearTimeout(timer));
  };
}

/**
 * Send message deletion event to sync across devices
 * This ensures when one device deletes a message, all devices delete it
 *
 * @param eventId - ID of message to delete
 */
export async function deleteMessageEverywhere(eventId: string): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  const wsClient = getWebSocketClient();
  const userId = wsClient.getUserId() || undefined;

  // 1. Delete locally
  await deleteMessagePayload(eventId);

  // 2. Broadcast deletion to other devices
  const payload = {
    deleted_event_id: eventId,
    deleted_at: Date.now(),
  };

  await createEvent(
    MESSAGES_STREAM_ID,
    deviceId,
    'message:deleted',
    payload,
    userId
  );

  await wsClient.syncPending();

  console.log(`[TTL] Deleted message everywhere: ${eventId}`);
}

/**
 * Get time remaining before message expires
 * Returns null if message doesn't expire or is already expired
 *
 * @param message - Message with expiry time
 * @returns Seconds remaining, or null
 */
export function getTimeRemaining(message: ChatMessageWithTTL): number | null {
  if (!message.expiresAt) return null;

  const remaining = Math.max(0, message.expiresAt - Date.now());
  return Math.floor(remaining / 1000);
}

/**
 * Check if message has expired
 *
 * @param message - Message with expiry time
 * @returns true if expired, false otherwise
 */
export function isExpired(message: ChatMessageWithTTL): boolean {
  if (!message.expiresAt) return false;
  return Date.now() >= message.expiresAt;
}

/**
 * Format time remaining as human-readable string
 * Examples: "5s", "30s", "1m 30s"
 *
 * @param seconds - Seconds remaining
 * @returns Formatted string
 */
export function formatTimeRemaining(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (secs === 0) {
    return `${mins}m`;
  }

  return `${mins}m ${secs}s`;
}

/**
 * Read receipt interface
 */
export interface ReadReceipt {
  message_id: string;
  read_at: number;
  reader_device_id: string;
  reader_device_name?: string;
}

/**
 * Send read receipt when message is viewed
 * This notifies the sender that their message was seen
 *
 * @param messageId - ID of the message that was read
 */
export async function markMessageAsRead(messageId: string): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  const wsClient = getWebSocketClient();
  const userId = wsClient.getUserId() || undefined;

  // Get device name for display
  const { getOrCreateDeviceName } = await import('@/lib/utils/device');
  const deviceName = getOrCreateDeviceName();

  const payload: MessageReadReceiptPayload = {
    message_id: messageId,
    read_at: Date.now(),
    reader_device_id: deviceId,
    reader_device_name: deviceName,
  };

  await createEvent(
    MESSAGES_STREAM_ID,
    deviceId,
    'message:read_receipt',
    payload,
    userId
  );

  await wsClient.syncPending();

  console.log(`[ReadReceipt] Marked message as read: ${messageId}`);
}

/**
 * Get all read receipts for a specific message
 * Shows who has read the message and when
 *
 * @param messageId - ID of the message to check
 * @returns Array of read receipts
 */
export async function getReadReceipts(messageId: string): Promise<ReadReceipt[]> {
  try {
    const events = await getEventsByStream(MESSAGES_STREAM_ID);
    const receipts: ReadReceipt[] = [];
    const { getSharedEncryptionKey } = await import('@/lib/crypto/shared-key');
    const { decryptPayload } = await import('@/lib/crypto/encryption');

    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[ReadReceipt] Shared encryption key not available');
      return [];
    }

    for (const event of events) {
      if (event.type === 'message:read_receipt') {
        try {
          const receipt = await decryptPayload(
            event.encrypted_payload,
            sharedKey
          ) as ReadReceipt;

          if (receipt.message_id === messageId) {
            receipts.push(receipt);
          }
        } catch (error) {
          console.error('[ReadReceipt] Failed to decrypt receipt:', error);
        }
      }
    }

    // Sort by read time (earliest first)
    receipts.sort((a, b) => a.read_at - b.read_at);

    return receipts;
  } catch (error) {
    console.error('[ReadReceipt] Failed to get read receipts:', error);
    return [];
  }
}

/**
 * Check if a message has been read
 *
 * @param messageId - ID of the message to check
 * @returns true if at least one device has read it
 */
export async function isMessageRead(messageId: string): Promise<boolean> {
  const receipts = await getReadReceipts(messageId);
  return receipts.length > 0;
}

/**
 * Get read status for a message
 * Returns detailed information about who read the message
 *
 * @param messageId - ID of the message to check
 * @returns Object with read status and receipt details
 */
export async function getReadStatus(messageId: string): Promise<{
  isRead: boolean;
  readCount: number;
  receipts: ReadReceipt[];
  readByDevices: string[];
}> {
  const receipts = await getReadReceipts(messageId);

  return {
    isRead: receipts.length > 0,
    readCount: receipts.length,
    receipts,
    readByDevices: receipts.map(r => r.reader_device_name || r.reader_device_id),
  };
}

/**
 * Format read receipts as a human-readable string
 * Examples:
 * - "Read by Laptop"
 * - "Read by Laptop, Phone"
 * - "Read by 3 devices"
 *
 * @param receipts - Array of read receipts
 * @returns Formatted string
 */
export function formatReadReceipts(receipts: ReadReceipt[]): string {
  if (receipts.length === 0) {
    return 'Unread';
  }

  if (receipts.length === 1) {
    const device = receipts[0].reader_device_name || receipts[0].reader_device_id;
    return `Read by ${device}`;
  }

  if (receipts.length === 2) {
    const devices = receipts.map(r => r.reader_device_name || r.reader_device_id);
    return `Read by ${devices.join(', ')}`;
  }

  return `Read by ${receipts.length} devices`;
}
