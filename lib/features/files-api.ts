/**
 * Files API Client
 *
 * Client-side utilities for interacting with files API
 * Fetches file transfer history and decrypts metadata
 */

import { getBackendApiUrl } from '@/lib/utils/pairing-code';
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import { decryptPayload } from '@/lib/crypto/encryption';
import { logger } from '@/lib/utils/logger';

export interface FileMetadata {
  file_id: string;
  name: string;
  size: number;
  mime_type: string;
  total_chunks: number;
  encryption_key?: string;
}

export interface FileHistoryItem {
  eventId: string;
  deviceId: string;
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: Date;
}

interface ServerEvent {
  event_id: string;
  device_id: string;
  stream_id: string;
  stream_seq: number;
  type: string;
  encrypted_payload: string;
  payload_size: number;
  created_at: string;
}

interface FileHistoryResponse {
  events: ServerEvent[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

/**
 * Fetch file transfer history from backend
 * Returns decrypted file metadata for display
 */
export async function fetchFileHistory(
  userId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<{ files: FileHistoryItem[]; total: number; hasMore: boolean }> {
  if (typeof window === 'undefined') {
    return { files: [], total: 0, hasMore: false };
  }

  try {
    const apiUrl = getBackendApiUrl();
    if (!apiUrl) {
      logger.warn('Backend API URL not configured, skipping file history fetch');
      return { files: [], total: 0, hasMore: false };
    }

    const { limit = 50, offset = 0 } = options;
    const url = `${apiUrl}/api/events/files?limit=${limit}&offset=${offset}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-User-ID': userId,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch file history: ${response.statusText}`);
    }

    const data: FileHistoryResponse = await response.json();

    // Get shared key for decryption
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      logger.warn('Shared encryption key not available, cannot decrypt file metadata');
      return { files: [], total: data.pagination.total, hasMore: data.pagination.hasMore };
    }

    // Decrypt each event's payload to get file metadata
    const files: FileHistoryItem[] = [];
    for (const event of data.events) {
      try {
        const payload = await decryptPayload(event.encrypted_payload, sharedKey) as FileMetadata;
        if (payload && payload.file_id && payload.name) {
          files.push({
            eventId: event.event_id,
            deviceId: event.device_id,
            fileId: payload.file_id,
            name: payload.name,
            size: payload.size,
            mimeType: payload.mime_type,
            createdAt: new Date(event.created_at),
          });
        }
      } catch (decryptError) {
        // Skip events that can't be decrypted (may be from different identity)
        logger.debug('Could not decrypt file event', {
          eventId: event.event_id,
          error: decryptError instanceof Error ? decryptError.message : String(decryptError),
        });
      }
    }

    return {
      files,
      total: data.pagination.total,
      hasMore: data.pagination.hasMore,
    };
  } catch (error) {
    const isNetworkError = error instanceof TypeError &&
      (error.message.includes('fetch') ||
        error.message.includes('NetworkError') ||
        error.message.includes('Failed to fetch'));

    const isAbortError = error instanceof Error && error.name === 'AbortError';

    if (isNetworkError || isAbortError) {
      logger.debug('Backend unavailable for file history', {
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      logger.error('Failed to fetch file history', error);
    }

    return { files: [], total: 0, hasMore: false };
  }
}
