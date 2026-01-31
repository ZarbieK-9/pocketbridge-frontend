/**
 * File Transfer Tracker
 *
 * Provides transactional file transfer tracking using IndexedDB:
 * - Persists incoming file transfers and their chunks
 * - Only marks transfers as "complete" when all chunks are received
 * - Cleans up stale incomplete transfers
 * - Survives page refreshes and reconnections
 */

import { logger } from '@/lib/utils/logger';

const DB_NAME = 'pocketbridge_file_transfers';
const DB_VERSION = 1;
const TRANSFERS_STORE = 'transfers';
const CHUNKS_STORE = 'chunks';

// Stale transfer threshold: 30 minutes
const STALE_TRANSFER_THRESHOLD_MS = 30 * 60 * 1000;

export interface FileTransferRecord {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  encryptionKey: string;
  receivedChunks: number;
  status: 'receiving' | 'complete' | 'stale';
  createdAt: number;
  updatedAt: number;
  sourceDeviceId: string;
}

export interface ChunkRecord {
  id: string; // fileId:chunkIndex
  fileId: string;
  chunkIndex: number;
  data: Uint8Array;
  hash: string;
  receivedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      logger.error('[FileTransferTracker] Failed to open DB', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create transfers store
      if (!db.objectStoreNames.contains(TRANSFERS_STORE)) {
        const transfersStore = db.createObjectStore(TRANSFERS_STORE, { keyPath: 'fileId' });
        transfersStore.createIndex('status', 'status', { unique: false });
        transfersStore.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // Create chunks store
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunksStore = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
        chunksStore.createIndex('fileId', 'fileId', { unique: false });
      }
    };
  });

  return dbPromise;
}

/**
 * Start tracking a new file transfer
 */
export async function startTracking(
  fileId: string,
  metadata: {
    name: string;
    size: number;
    mimeType: string;
    totalChunks: number;
    encryptionKey: string;
  },
  sourceDeviceId: string
): Promise<FileTransferRecord> {
  const db = await openDB();
  const now = Date.now();

  const record: FileTransferRecord = {
    fileId,
    name: metadata.name,
    size: metadata.size,
    mimeType: metadata.mimeType,
    totalChunks: metadata.totalChunks,
    encryptionKey: metadata.encryptionKey,
    receivedChunks: 0,
    status: 'receiving',
    createdAt: now,
    updatedAt: now,
    sourceDeviceId,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSFERS_STORE, 'readwrite');
    const store = tx.objectStore(TRANSFERS_STORE);
    const request = store.put(record);

    request.onsuccess = () => {
      logger.debug('[FileTransferTracker] Started tracking transfer', { fileId, name: metadata.name });
      resolve(record);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get transfer record by fileId
 */
export async function getTransfer(fileId: string): Promise<FileTransferRecord | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSFERS_STORE, 'readonly');
    const store = tx.objectStore(TRANSFERS_STORE);
    const request = store.get(fileId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Store a received chunk
 * Returns true if this was the final chunk (transfer complete)
 */
export async function storeChunk(
  fileId: string,
  chunkIndex: number,
  data: Uint8Array,
  hash: string
): Promise<{ complete: boolean; transfer: FileTransferRecord | null }> {
  const db = await openDB();
  const now = Date.now();

  const chunkId = `${fileId}:${chunkIndex}`;
  const chunkRecord: ChunkRecord = {
    id: chunkId,
    fileId,
    chunkIndex,
    data,
    hash,
    receivedAt: now,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction([TRANSFERS_STORE, CHUNKS_STORE], 'readwrite');
    const transfersStore = tx.objectStore(TRANSFERS_STORE);
    const chunksStore = tx.objectStore(CHUNKS_STORE);

    // Check if chunk already exists (avoid duplicates)
    const checkRequest = chunksStore.get(chunkId);
    checkRequest.onsuccess = () => {
      if (checkRequest.result) {
        // Chunk already stored, just return current state
        const transferRequest = transfersStore.get(fileId);
        transferRequest.onsuccess = () => {
          const transfer = transferRequest.result as FileTransferRecord | null;
          resolve({
            complete: transfer?.status === 'complete',
            transfer,
          });
        };
        return;
      }

      // Store the chunk
      const storeChunkRequest = chunksStore.put(chunkRecord);
      storeChunkRequest.onerror = () => reject(storeChunkRequest.error);

      storeChunkRequest.onsuccess = () => {
        // Update transfer record
        const getTransferRequest = transfersStore.get(fileId);
        getTransferRequest.onsuccess = () => {
          const transfer = getTransferRequest.result as FileTransferRecord | null;
          if (!transfer) {
            logger.warn('[FileTransferTracker] Received chunk for unknown transfer', { fileId, chunkIndex });
            resolve({ complete: false, transfer: null });
            return;
          }

          transfer.receivedChunks++;
          transfer.updatedAt = now;

          // Check if all chunks received
          const isComplete = transfer.receivedChunks >= transfer.totalChunks;
          if (isComplete) {
            transfer.status = 'complete';
            logger.info('[FileTransferTracker] Transfer complete', {
              fileId,
              name: transfer.name,
              chunks: transfer.totalChunks,
            });
          }

          const updateRequest = transfersStore.put(transfer);
          updateRequest.onsuccess = () => {
            resolve({ complete: isComplete, transfer });
          };
          updateRequest.onerror = () => reject(updateRequest.error);
        };
        getTransferRequest.onerror = () => reject(getTransferRequest.error);
      };
    };
    checkRequest.onerror = () => reject(checkRequest.error);
  });
}

/**
 * Get all chunks for a completed transfer
 */
export async function getChunks(fileId: string): Promise<ChunkRecord[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNKS_STORE, 'readonly');
    const store = tx.objectStore(CHUNKS_STORE);
    const index = store.index('fileId');
    const request = index.getAll(fileId);

    request.onsuccess = () => {
      const chunks = request.result as ChunkRecord[];
      // Sort by chunkIndex
      chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      resolve(chunks);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all receiving (incomplete) transfers
 */
export async function getReceivingTransfers(): Promise<FileTransferRecord[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSFERS_STORE, 'readonly');
    const store = tx.objectStore(TRANSFERS_STORE);
    const index = store.index('status');
    const request = index.getAll('receiving');

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete a transfer and all its chunks
 */
export async function deleteTransfer(fileId: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([TRANSFERS_STORE, CHUNKS_STORE], 'readwrite');
    const transfersStore = tx.objectStore(TRANSFERS_STORE);
    const chunksStore = tx.objectStore(CHUNKS_STORE);

    // Delete transfer record
    transfersStore.delete(fileId);

    // Delete all chunks for this transfer
    const chunksIndex = chunksStore.index('fileId');
    const request = chunksIndex.openCursor(fileId);

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        chunksStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      logger.debug('[FileTransferTracker] Deleted transfer', { fileId });
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Clean up stale incomplete transfers
 * Transfers older than STALE_TRANSFER_THRESHOLD_MS that are not complete
 */
export async function cleanupStaleTransfers(): Promise<number> {
  const db = await openDB();
  const threshold = Date.now() - STALE_TRANSFER_THRESHOLD_MS;
  let cleanedCount = 0;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([TRANSFERS_STORE, CHUNKS_STORE], 'readwrite');
    const transfersStore = tx.objectStore(TRANSFERS_STORE);
    const chunksStore = tx.objectStore(CHUNKS_STORE);

    const request = transfersStore.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const transfer = cursor.value as FileTransferRecord;

        // Check if transfer is stale (old and incomplete)
        if (transfer.status === 'receiving' && transfer.updatedAt < threshold) {
          logger.info('[FileTransferTracker] Cleaning up stale transfer', {
            fileId: transfer.fileId,
            name: transfer.name,
            receivedChunks: transfer.receivedChunks,
            totalChunks: transfer.totalChunks,
            ageMinutes: Math.round((Date.now() - transfer.updatedAt) / 60000),
          });

          // Delete the transfer record
          transfersStore.delete(cursor.primaryKey);

          // Delete associated chunks
          const chunksIndex = chunksStore.index('fileId');
          const chunksRequest = chunksIndex.openCursor(transfer.fileId);
          chunksRequest.onsuccess = () => {
            const chunkCursor = chunksRequest.result;
            if (chunkCursor) {
              chunksStore.delete(chunkCursor.primaryKey);
              chunkCursor.continue();
            }
          };

          cleanedCount++;
        }

        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      if (cleanedCount > 0) {
        logger.info('[FileTransferTracker] Cleanup complete', { cleanedCount });
      }
      resolve(cleanedCount);
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Clear all completed transfers older than specified age
 */
export async function clearOldCompleteTransfers(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const db = await openDB();
  const threshold = Date.now() - maxAgeMs;
  let cleanedCount = 0;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([TRANSFERS_STORE, CHUNKS_STORE], 'readwrite');
    const transfersStore = tx.objectStore(TRANSFERS_STORE);
    const chunksStore = tx.objectStore(CHUNKS_STORE);

    const request = transfersStore.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const transfer = cursor.value as FileTransferRecord;

        // Clean up old completed transfers
        if (transfer.status === 'complete' && transfer.updatedAt < threshold) {
          // Delete transfer and chunks
          transfersStore.delete(cursor.primaryKey);

          const chunksIndex = chunksStore.index('fileId');
          const chunksRequest = chunksIndex.openCursor(transfer.fileId);
          chunksRequest.onsuccess = () => {
            const chunkCursor = chunksRequest.result;
            if (chunkCursor) {
              chunksStore.delete(chunkCursor.primaryKey);
              chunkCursor.continue();
            }
          };

          cleanedCount++;
        }

        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve(cleanedCount);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get transfer progress (percentage)
 */
export function getTransferProgress(transfer: FileTransferRecord): number {
  if (transfer.totalChunks === 0) return 0;
  return Math.round((transfer.receivedChunks / transfer.totalChunks) * 100);
}

/**
 * Buffer for orphaned chunk events (received before metadata)
 * These are stored temporarily in memory until metadata arrives
 * We store raw events because we can't decrypt without the encryption key from metadata
 */
const orphanedEventBuffer = new Map<string, any[]>();

/**
 * Buffer an orphaned chunk event
 */
export function bufferOrphanedChunkEvent(fileId: string, event: any): void {
  const events = orphanedEventBuffer.get(fileId) || [];
  events.push(event);
  orphanedEventBuffer.set(fileId, events);
  logger.debug('[FileTransferTracker] Buffered orphaned chunk event', { fileId, bufferedCount: events.length });
}

/**
 * Get buffered orphaned chunk events
 */
export function getOrphanedChunkEvents(fileId: string): any[] {
  return orphanedEventBuffer.get(fileId) || [];
}

/**
 * Clear orphaned chunk events after processing
 */
export function clearOrphanedChunkEvents(fileId: string): void {
  orphanedEventBuffer.delete(fileId);
}

// Legacy exports for compatibility - these are no longer used but kept to avoid import errors
export function bufferOrphanedChunk(fileId: string, chunkIndex: number, data: Uint8Array, hash: string): void {
  logger.warn('[FileTransferTracker] bufferOrphanedChunk is deprecated, use bufferOrphanedChunkEvent');
}

export async function processOrphanedChunks(fileId: string): Promise<void> {
  logger.warn('[FileTransferTracker] processOrphanedChunks is deprecated, chunks should be processed by caller');
}

export function clearOrphanedChunks(fileId: string): void {
  clearOrphanedChunkEvents(fileId);
}
