/**
 * File Upload Tracker (Sender-side)
 *
 * Provides persistent upload tracking using IndexedDB:
 * - Stores file data in chunks for resume capability
 * - Tracks which chunks have been sent and acknowledged
 * - Enables resume after page reload or disconnection
 * - Handles resume requests from receiver
 */

import { logger } from '@/lib/utils/logger';

const DB_NAME = 'pocketbridge_file_uploads';
const DB_VERSION = 2; // Incremented to trigger IndexedDB migration on existing databases
const UPLOADS_STORE = 'uploads';
const UPLOAD_CHUNKS_STORE = 'upload_chunks';

// Stale upload threshold: 1 hour
const STALE_UPLOAD_THRESHOLD_MS = 60 * 60 * 1000;

export interface FileUploadRecord {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  encryptionKeyBase64: string; // Base64-encoded file encryption key
  sentChunks: number[]; // Chunk indices that have been sent
  ackedChunks: number[]; // Chunk indices that have been acknowledged by receiver
  status: 'uploading' | 'waiting_acks' | 'complete' | 'stale' | 'failed';
  failReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UploadChunkRecord {
  id: string; // fileId:chunkIndex
  fileId: string;
  chunkIndex: number;
  data: Uint8Array; // Raw chunk data (not encrypted - we re-encrypt on resume)
  storedAt: number;
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
      logger.error('[FileUploadTracker] Failed to open DB', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create uploads store
      if (!db.objectStoreNames.contains(UPLOADS_STORE)) {
        const uploadsStore = db.createObjectStore(UPLOADS_STORE, { keyPath: 'fileId' });
        uploadsStore.createIndex('status', 'status', { unique: false });
        uploadsStore.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // Create upload chunks store
      if (!db.objectStoreNames.contains(UPLOAD_CHUNKS_STORE)) {
        const chunksStore = db.createObjectStore(UPLOAD_CHUNKS_STORE, { keyPath: 'id' });
        chunksStore.createIndex('fileId', 'fileId', { unique: false });
      }
    };
  });

  return dbPromise;
}

/**
 * Start tracking a new file upload
 */
export async function startUploadTracking(
  fileId: string,
  file: File,
  encryptionKeyBase64: string,
  totalChunks: number
): Promise<FileUploadRecord> {
  const db = await openDB();
  const now = Date.now();

  const record: FileUploadRecord = {
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type,
    totalChunks,
    encryptionKeyBase64,
    sentChunks: [],
    ackedChunks: [],
    status: 'uploading',
    createdAt: now,
    updatedAt: now,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOADS_STORE, 'readwrite');
    const store = tx.objectStore(UPLOADS_STORE);
    const request = store.put(record);

    request.onsuccess = () => {
      logger.debug('[FileUploadTracker] Started tracking upload', { fileId, name: file.name, totalChunks });
      resolve(record);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Store a chunk for potential resume
 */
export async function storeUploadChunk(
  fileId: string,
  chunkIndex: number,
  data: Uint8Array
): Promise<void> {
  const db = await openDB();
  const chunkId = `${fileId}:${chunkIndex}`;

  const chunkRecord: UploadChunkRecord = {
    id: chunkId,
    fileId,
    chunkIndex,
    data,
    storedAt: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOAD_CHUNKS_STORE, 'readwrite');
    const store = tx.objectStore(UPLOAD_CHUNKS_STORE);
    const request = store.put(chunkRecord);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Mark a chunk as sent
 */
export async function markChunkSent(fileId: string, chunkIndex: number): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOADS_STORE, 'readwrite');
    const store = tx.objectStore(UPLOADS_STORE);
    const getRequest = store.get(fileId);

    getRequest.onsuccess = () => {
      const upload = getRequest.result as FileUploadRecord | null;
      if (!upload) {
        resolve();
        return;
      }

      if (!upload.sentChunks.includes(chunkIndex)) {
        upload.sentChunks.push(chunkIndex);
        upload.updatedAt = Date.now();

        // Check if all chunks sent
        if (upload.sentChunks.length >= upload.totalChunks) {
          upload.status = 'waiting_acks';
        }

        const putRequest = store.put(upload);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      } else {
        resolve();
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * Mark a chunk as acknowledged by receiver
 */
export async function markChunkAcked(
  fileId: string,
  chunkIndex: number
): Promise<{ allAcked: boolean; upload: FileUploadRecord | null }> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOADS_STORE, 'readwrite');
    const store = tx.objectStore(UPLOADS_STORE);
    const getRequest = store.get(fileId);

    getRequest.onsuccess = () => {
      const upload = getRequest.result as FileUploadRecord | null;
      if (!upload) {
        resolve({ allAcked: false, upload: null });
        return;
      }

      if (!upload.ackedChunks.includes(chunkIndex)) {
        upload.ackedChunks.push(chunkIndex);
        upload.updatedAt = Date.now();

        // Check if all chunks acknowledged
        const allAcked = upload.ackedChunks.length >= upload.totalChunks;
        if (allAcked) {
          upload.status = 'complete';
          logger.info('[FileUploadTracker] All chunks acknowledged', { fileId, name: upload.name });
        }

        const putRequest = store.put(upload);
        putRequest.onsuccess = () => resolve({ allAcked, upload });
        putRequest.onerror = () => reject(putRequest.error);
      } else {
        const allAcked = upload.ackedChunks.length >= upload.totalChunks;
        resolve({ allAcked, upload });
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * Get upload record by fileId
 */
export async function getUpload(fileId: string): Promise<FileUploadRecord | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOADS_STORE, 'readonly');
    const store = tx.objectStore(UPLOADS_STORE);
    const request = store.get(fileId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get a stored chunk for re-sending
 */
export async function getUploadChunk(fileId: string, chunkIndex: number): Promise<UploadChunkRecord | null> {
  const db = await openDB();
  const chunkId = `${fileId}:${chunkIndex}`;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOAD_CHUNKS_STORE, 'readonly');
    const store = tx.objectStore(UPLOAD_CHUNKS_STORE);
    const request = store.get(chunkId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all incomplete uploads (for resume on page load)
 */
export async function getIncompleteUploads(): Promise<FileUploadRecord[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOADS_STORE, 'readonly');
    const store = tx.objectStore(UPLOADS_STORE);
    const request = store.getAll();

    request.onsuccess = () => {
      const uploads = (request.result || []) as FileUploadRecord[];
      // Filter to incomplete uploads
      const incomplete = uploads.filter(u => u.status === 'uploading' || u.status === 'waiting_acks');
      resolve(incomplete);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all failed uploads
 */
export async function getFailedUploads(): Promise<FileUploadRecord[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOADS_STORE, 'readonly');
    const store = tx.objectStore(UPLOADS_STORE);
    const index = store.index('status');
    const request = index.getAll('failed');

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get chunks that need to be re-sent (sent but not acknowledged)
 */
export function getUnackedChunks(upload: FileUploadRecord): number[] {
  return upload.sentChunks.filter(idx => !upload.ackedChunks.includes(idx));
}

/**
 * Get chunks that haven't been sent yet
 */
export function getUnsentChunks(upload: FileUploadRecord): number[] {
  const allChunks = Array.from({ length: upload.totalChunks }, (_, i) => i);
  return allChunks.filter(idx => !upload.sentChunks.includes(idx));
}

/**
 * Mark an upload as failed with a reason
 */
export async function markUploadFailed(fileId: string, reason: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOADS_STORE, 'readwrite');
    const store = tx.objectStore(UPLOADS_STORE);
    const getRequest = store.get(fileId);

    getRequest.onsuccess = () => {
      const upload = getRequest.result as FileUploadRecord | null;
      if (!upload || upload.status === 'complete') {
        resolve();
        return;
      }

      upload.status = 'failed';
      upload.failReason = reason;
      upload.updatedAt = Date.now();

      const putRequest = store.put(upload);
      putRequest.onsuccess = () => {
        logger.info('[FileUploadTracker] Upload marked as failed', { fileId, reason });
        resolve();
      };
      putRequest.onerror = () => reject(putRequest.error);
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * Delete an upload and all its chunks
 */
export async function deleteUpload(fileId: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([UPLOADS_STORE, UPLOAD_CHUNKS_STORE], 'readwrite');
    const uploadsStore = tx.objectStore(UPLOADS_STORE);
    const chunksStore = tx.objectStore(UPLOAD_CHUNKS_STORE);

    // Delete upload record
    uploadsStore.delete(fileId);

    // Delete all chunks for this upload
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
      logger.debug('[FileUploadTracker] Deleted upload', { fileId });
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Clean up stale incomplete uploads
 */
export async function cleanupStaleUploads(): Promise<number> {
  const db = await openDB();
  const threshold = Date.now() - STALE_UPLOAD_THRESHOLD_MS;
  let cleanedCount = 0;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([UPLOADS_STORE, UPLOAD_CHUNKS_STORE], 'readwrite');
    const uploadsStore = tx.objectStore(UPLOADS_STORE);
    const chunksStore = tx.objectStore(UPLOAD_CHUNKS_STORE);

    const request = uploadsStore.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const upload = cursor.value as FileUploadRecord;

        // Check if upload is stale (old and incomplete)
        if ((upload.status === 'uploading' || upload.status === 'waiting_acks') && upload.updatedAt < threshold) {
          logger.info('[FileUploadTracker] Marking stale upload as failed', {
            fileId: upload.fileId,
            name: upload.name,
            sentChunks: upload.sentChunks.length,
            ackedChunks: upload.ackedChunks.length,
            totalChunks: upload.totalChunks,
            ageMinutes: Math.round((Date.now() - upload.updatedAt) / 60000),
          });

          // Mark as failed instead of silently deleting
          upload.status = 'failed';
          upload.failReason = 'Upload timed out';
          upload.updatedAt = Date.now();
          uploadsStore.put(upload);

          cleanedCount++;
        }

        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      if (cleanedCount > 0) {
        logger.info('[FileUploadTracker] Cleanup complete', { cleanedCount });
      }
      resolve(cleanedCount);
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get upload progress (percentage based on acks)
 */
export function getUploadProgress(upload: FileUploadRecord): number {
  if (upload.totalChunks === 0) return 0;
  return Math.round((upload.ackedChunks.length / upload.totalChunks) * 100);
}

/**
 * Get send progress (percentage based on sent, not acked)
 */
export function getSendProgress(upload: FileUploadRecord): number {
  if (upload.totalChunks === 0) return 0;
  return Math.round((upload.sentChunks.length / upload.totalChunks) * 100);
}
