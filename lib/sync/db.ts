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

import { DB_NAME, DB_VERSION, STORE_EVENTS, STORE_DEVICES, STORE_STREAMS } from '@/lib/constants';
import type { EncryptedEvent, Device, Stream } from '@/types';

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
 */
export async function getEventsByStream(streamId: string): Promise<EncryptedEvent[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS], 'readonly');
    const store = transaction.objectStore(STORE_EVENTS);
    const index = store.index('stream_id');
    const request = index.getAll(streamId);

    request.onsuccess = () => {
      const events = request.result as EncryptedEvent[];
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
 */
export async function getPendingEvents(lastAckDeviceSeq: number): Promise<EncryptedEvent[]> {
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
        return event.device_seq > lastAckDeviceSeq;
      });

      // Sort by device_seq
      pending.sort((a, b) => a.device_seq - b.device_seq);
      resolve(pending);
    };

    request.onerror = () => reject(new Error('Failed to get pending events'));
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
 * Clear all data (for testing or reset)
 */
export async function clearDatabase(): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_EVENTS, STORE_DEVICES, STORE_STREAMS], 'readwrite');

    transaction.objectStore(STORE_EVENTS).clear();
    transaction.objectStore(STORE_DEVICES).clear();
    transaction.objectStore(STORE_STREAMS).clear();

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('Failed to clear database'));
  });
}
