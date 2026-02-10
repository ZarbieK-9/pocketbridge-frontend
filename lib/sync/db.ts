/**
 * IndexedDB database setup and management - Phase 1
 * 
 * Stores encrypted events with Phase 1 structure:
 * - event_id (UUIDv7) as primary key
 * - user_id, device_id, device_seq, stream_id, stream_seq
 * - encrypted_payload (base64)
 * 
 * Indexes for efficient replay queries
 */

import { DB_NAME, DB_VERSION, STORE_EVENTS, STORE_DEVICES, STORE_STREAMS, STORE_FILE_CHUNKS } from '@/lib/constants';
import type { EncryptedEvent, Device, Stream } from '@/types';

export interface FileChunk {
  id: string; // `${fileId}:${chunkIndex}`
  fileId: string;
  chunkIndex: number;
  data: string; // base64 encoded chunk data
  receivedAt: number;
}

/**
 * Initialize IndexedDB database with required object stores
 */
export function initDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB'));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Events store - Phase 1 structure
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const eventStore = db.createObjectStore(STORE_EVENTS, { keyPath: 'event_id' });
        eventStore.createIndex('stream_id', 'stream_id', { unique: false });
        eventStore.createIndex('device_id', 'device_id', { unique: false });
        eventStore.createIndex('user_id', 'user_id', { unique: false });
        eventStore.createIndex('device_seq', 'device_seq', { unique: false });
        eventStore.createIndex('stream_seq', 'stream_seq', { unique: false });
        eventStore.createIndex('created_at', 'created_at', { unique: false });
        // Compound index for replay queries
        eventStore.createIndex('device_seq_idx', ['device_id', 'device_seq'], { unique: false });
      }

      // Devices store
      if (!db.objectStoreNames.contains(STORE_DEVICES)) {
        const deviceStore = db.createObjectStore(STORE_DEVICES, { keyPath: 'id' });
        deviceStore.createIndex('lastSeen', 'lastSeen', { unique: false });
      }

      // Streams store
      if (!db.objectStoreNames.contains(STORE_STREAMS)) {
        const streamStore = db.createObjectStore(STORE_STREAMS, { keyPath: 'id' });
        streamStore.createIndex('type', 'type', { unique: false });
      }

      // File chunks store (for resumable file transfers)
      if (!db.objectStoreNames.contains(STORE_FILE_CHUNKS)) {
        const fileChunkStore = db.createObjectStore(STORE_FILE_CHUNKS, { keyPath: 'id' });
        fileChunkStore.createIndex('fileId', 'fileId', { unique: false });
        fileChunkStore.createIndex('chunkIndex', 'chunkIndex', { unique: false });
        fileChunkStore.createIndex('receivedAt', 'receivedAt', { unique: false });
      }
    };
  });
}

/**
 * Get database connection
 */
export async function getDatabase(): Promise<IDBDatabase> {
  return await initDatabase();
}

/**
 * Add an encrypted event to the database - Phase 1
 * Idempotent: duplicate event_ids are ignored
 */
export async function addEvent(event: EncryptedEvent): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS], 'readwrite');
    const store = transaction.objectStore(STORE_EVENTS);

    // Check if event already exists (idempotency)
    const getRequest = store.get(event.event_id);

    getRequest.onsuccess = () => {
      if (getRequest.result) {
        // Event already exists, skip
        resolve();
      } else {
        // Add new event
        const addRequest = store.add(event);
        addRequest.onsuccess = () => resolve();
        addRequest.onerror = () => reject(new Error('Failed to add event'));
      }
    };

    getRequest.onerror = () => reject(new Error('Failed to check event existence'));
  });
}

/**
 * Get all events for a specific stream
 * Optionally filter by user_id to only get events from the current user
 */
export async function getEventsByStream(
  streamId: string,
  userId?: string
): Promise<EncryptedEvent[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS], 'readonly');
    const store = transaction.objectStore(STORE_EVENTS);
    const index = store.index('stream_id');
    const request = index.getAll(streamId);

    request.onsuccess = () => {
      let events = request.result as EncryptedEvent[];
      
      // Filter by user_id if provided (to avoid decryption errors from other users' events)
      if (userId) {
        events = events.filter(event => event.user_id === userId);
      }
      
      // Sort by stream_seq
      events.sort((a, b) => a.stream_seq - b.stream_seq);
      resolve(events);
    };

    request.onerror = () => reject(new Error('Failed to get events'));
  });
}

/**
 * Get pending events (not yet acknowledged) - Phase 1
 * Uses lastAckDeviceSeq (single value for this device)
 * @param lastAckDeviceSeq - Events with device_seq > this value are considered pending
 * @param deviceId - Optional: Only return events from this device (recommended to avoid resending other devices' events)
 */
export async function getPendingEvents(lastAckDeviceSeq: number, deviceId?: string): Promise<EncryptedEvent[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS], 'readonly');
    const store = transaction.objectStore(STORE_EVENTS);
    const request = store.getAll();

    request.onsuccess = () => {
      const allEvents = request.result as EncryptedEvent[];

      // Filter events that haven't been acknowledged
      // Only events from this device with device_seq > lastAckDeviceSeq
      const pending = allEvents.filter((event) => {
        const seqValid = event.device_seq > lastAckDeviceSeq;
        const deviceValid = !deviceId || event.device_id === deviceId;
        return seqValid && deviceValid;
      });

      // Sort by device_seq
      pending.sort((a, b) => a.device_seq - b.device_seq);
      resolve(pending);
    };

    request.onerror = () => reject(new Error('Failed to get pending events'));
  });
}

/**
 * Get events by device sequence range (for gap filling)
 * Returns events from a specific device within the given sequence range
 *
 * @param deviceId - Device ID to filter events
 * @param startSeq - Start of sequence range (inclusive)
 * @param endSeq - End of sequence range (inclusive)
 */
export async function getEventsBySequenceRange(
  deviceId: string,
  startSeq: number,
  endSeq: number
): Promise<EncryptedEvent[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS], 'readonly');
    const store = transaction.objectStore(STORE_EVENTS);
    const request = store.getAll();

    request.onsuccess = () => {
      const allEvents = request.result as EncryptedEvent[];

      // Filter events by device and sequence range
      const rangeEvents = allEvents.filter((event) => {
        return (
          event.device_id === deviceId &&
          event.device_seq >= startSeq &&
          event.device_seq <= endSeq
        );
      });

      // Sort by device_seq
      rangeEvents.sort((a, b) => a.device_seq - b.device_seq);
      resolve(rangeEvents);
    };

    request.onerror = () => reject(new Error('Failed to get events by sequence range'));
  });
}

/**
 * Add or update a device
 */
export async function upsertDevice(device: Device): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_DEVICES], 'readwrite');
    const store = transaction.objectStore(STORE_DEVICES);
    const request = store.put(device);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Failed to upsert device'));
  });
}

/**
 * Get all devices
 */
export async function getDevices(): Promise<Device[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_DEVICES], 'readonly');
    const store = transaction.objectStore(STORE_DEVICES);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result as Device[]);
    request.onerror = () => reject(new Error('Failed to get devices'));
  });
}

/**
 * Add or update a stream
 */
export async function upsertStream(stream: Stream): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_STREAMS], 'readwrite');
    const store = transaction.objectStore(STORE_STREAMS);
    const request = store.put(stream);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Failed to upsert stream'));
  });
}

/**
 * Get all streams
 */
export async function getStreams(): Promise<Stream[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_STREAMS], 'readonly');
    const store = transaction.objectStore(STORE_STREAMS);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result as Stream[]);
    request.onerror = () => reject(new Error('Failed to get streams'));
  });
}

/**
 * Get all events (for backup/export)
 */
export async function getAllEvents(): Promise<EncryptedEvent[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS], 'readonly');
    const store = transaction.objectStore(STORE_EVENTS);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result as EncryptedEvent[]);
    request.onerror = () => reject(new Error('Failed to get all events'));
  });
}

/**
 * Store event (for import/restore)
 */
export async function storeEvent(event: EncryptedEvent): Promise<void> {
  return addEvent(event); // addEvent already handles idempotency
}

/**
 * Delete event by ID
 */
export async function deleteEvent(eventId: string): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS], 'readwrite');
    const store = transaction.objectStore(STORE_EVENTS);
    const request = store.delete(eventId);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Failed to delete event'));
  });
}

/**
 * Clear all data (for testing or reset)
 */
export async function clearDatabase(): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS, STORE_DEVICES, STORE_STREAMS, STORE_FILE_CHUNKS], 'readwrite');

    transaction.objectStore(STORE_EVENTS).clear();
    transaction.objectStore(STORE_DEVICES).clear();
    transaction.objectStore(STORE_STREAMS).clear();
    transaction.objectStore(STORE_FILE_CHUNKS).clear();

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('Failed to clear database'));
  });
}

/**
 * Delete events that don't belong to the current user (orphaned events)
 * This handles events from old identity keypairs (e.g., before pairing)
 * Returns the number of events deleted
 */
export async function deleteOrphanedEvents(currentUserId: string): Promise<number> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS], 'readwrite');
    const store = transaction.objectStore(STORE_EVENTS);
    const request = store.openCursor();

    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const eventRecord = cursor.value as EncryptedEvent;
        // Delete events that belong to a different user
        if (eventRecord.user_id && eventRecord.user_id !== currentUserId) {
          cursor.delete();
          deletedCount++;
        }
        cursor.continue();
      }
    };

    transaction.oncomplete = () => resolve(deletedCount);
    transaction.onerror = () => reject(new Error('Failed to delete orphaned events'));
  });
}

/**
 * Delete acknowledged events (events with device_seq <= lastAckDeviceSeq)
 * This cleans up events that have been successfully synced
 * Returns the number of events deleted
 */
export async function deleteAcknowledgedEvents(
  lastAckDeviceSeq: number,
  currentUserId: string
): Promise<number> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS], 'readwrite');
    const store = transaction.objectStore(STORE_EVENTS);
    const request = store.openCursor();

    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const eventRecord = cursor.value as EncryptedEvent;
        // Delete events that:
        // 1. Belong to current user AND have been acknowledged (device_seq <= lastAckDeviceSeq)
        // 2. Belong to a different user (orphaned)
        const isAcknowledged =
          eventRecord.user_id === currentUserId && eventRecord.device_seq <= lastAckDeviceSeq;
        const isOrphaned = eventRecord.user_id !== currentUserId;

        if (isAcknowledged || isOrphaned) {
          cursor.delete();
          deletedCount++;
        }
        cursor.continue();
      }
    };

    transaction.oncomplete = () => resolve(deletedCount);
    transaction.onerror = () => reject(new Error('Failed to delete acknowledged events'));
  });
}

/**
 * Save a file chunk to the database (for resumable file transfers)
 */
export async function saveFileChunk(chunk: FileChunk): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_FILE_CHUNKS], 'readwrite');
    const store = transaction.objectStore(STORE_FILE_CHUNKS);
    const request = store.put(chunk);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Failed to save file chunk'));
  });
}

/**
 * Get all chunks for a specific file
 * Returns chunks sorted by chunkIndex
 */
export async function getFileChunks(fileId: string): Promise<FileChunk[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_FILE_CHUNKS], 'readonly');
    const store = transaction.objectStore(STORE_FILE_CHUNKS);
    const index = store.index('fileId');
    const request = index.getAll(fileId);

    request.onsuccess = () => {
      const chunks = request.result as FileChunk[];
      // Sort by chunkIndex
      chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      resolve(chunks);
    };

    request.onerror = () => reject(new Error('Failed to get file chunks'));
  });
}

/**
 * Get a specific chunk by ID
 */
export async function getFileChunkById(chunkId: string): Promise<FileChunk | null> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_FILE_CHUNKS], 'readonly');
    const store = transaction.objectStore(STORE_FILE_CHUNKS);
    const request = store.get(chunkId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('Failed to get file chunk'));
  });
}

/**
 * Delete all chunks for a specific file
 * Used to clean up after successful transfer or to cancel transfer
 */
export async function deleteFileChunks(fileId: string): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_FILE_CHUNKS], 'readwrite');
    const store = transaction.objectStore(STORE_FILE_CHUNKS);
    const index = store.index('fileId');
    const request = index.openCursor(IDBKeyRange.only(fileId));

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('Failed to delete file chunks'));
  });
}

/**
 * Get all file IDs that have stored chunks
 * Useful for resuming interrupted transfers
 */
export async function getIncompleteFileIds(): Promise<string[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_FILE_CHUNKS], 'readonly');
    const store = transaction.objectStore(STORE_FILE_CHUNKS);
    const index = store.index('fileId');
    const request = index.openKeyCursor();

    const fileIds = new Set<string>();

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursor>).result;
      if (cursor) {
        const chunk = cursor.primaryKey as string;
        const fileId = chunk.split(':')[0];
        fileIds.add(fileId);
        cursor.continue();
      }
    };

    transaction.oncomplete = () => resolve(Array.from(fileIds));
    transaction.onerror = () => reject(new Error('Failed to get incomplete file IDs'));
  });
}
