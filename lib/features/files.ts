/**
 * File Beaming Feature - Optimized for Large Files
 * 
 * Chunked file transfer with E2E encryption
 * - Up to 25GB per file
 * - Chunked uploads (5MB chunks for speed)
 * - Parallel uploads (10 chunks simultaneously)
 * - Per-file encryption key
 * - Per-chunk integrity verification
 * - Resume support
 */

import { createEvent } from '@/lib/sync/event-builder';
import { decryptPayload } from '@/lib/crypto/encryption';
import { getEventsByStream, saveFileChunk, getFileChunks, deleteFileChunks } from '@/lib/sync/db';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getWebSocketClient } from '@/lib/ws';
import { MAX_FILE_SIZE, getOptimalChunkSize } from '@/lib/constants';
import { generateSymmetricKey, importAESKey, exportAESKey } from '@/lib/crypto/keys';
import { encryptPayload, uint8ArrayToBase64 } from '@/lib/crypto/encryption';
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import type { EncryptedEvent, FileChunkPayload, FileMetadataPayload, EventPayload, FileChunk, FileResumeRequestPayload, FileChunkAckPayload } from '@/types';

const FILES_STREAM_ID = 'files:main';

export interface FileUpload {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  encryptionKey: CryptoKey;
  uploadedChunks: Set<number>;
}

/**
 * Start file upload
 */
export async function startFileUpload(
  file: File,
): Promise<FileUpload> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large. Maximum size: ${(MAX_FILE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB`);
  }

  const deviceId = getOrCreateDeviceId();
  const wsClient = getWebSocketClient();
  const userId = wsClient.getUserId() || undefined;
  const fileId = crypto.randomUUID();

  // Use dynamic chunk size based on file size for optimal speed
  const chunkSize = getOptimalChunkSize(file.size);
  const totalChunks = Math.ceil(file.size / chunkSize);

  // Debug: Log identity info for troubleshooting encryption issues
  const { loadIdentityKeyPair } = await import('@/lib/crypto/keys');
  const identity = await loadIdentityKeyPair();
  console.log('[Files] Starting file upload with key info:', {
    deviceId,
    wsUserId: userId?.substring(0, 16) + '...',
    localIdentityPubKey: identity?.publicKeyHex?.substring(0, 16) + '...',
    fileName: file.name,
    fileSize: file.size,
    fileSizeMB: (file.size / (1024 * 1024)).toFixed(2),
    chunkSizeMB: (chunkSize / (1024 * 1024)).toFixed(0),
    totalChunks,
  });
  
  // Generate per-file encryption key
  const encryptionKey = await generateSymmetricKey();
  
  const upload: FileUpload = {
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type,
    totalChunks,
    encryptionKey,
    uploadedChunks: new Set(),
  };

  // Send file metadata
  const encryptionKeyBytes = await exportAESKey(encryptionKey);
  const encryptionKeyBase64 = btoa(String.fromCharCode(...encryptionKeyBytes));
  
  const metadataPayload: FileMetadataPayload = {
    file_id: fileId,
    name: file.name,
    size: file.size,
    mime_type: file.type,
    total_chunks: totalChunks,
    encryption_key: encryptionKeyBase64, // Encrypted with session key in real implementation
  };

  await createEvent(
    FILES_STREAM_ID,
    deviceId,
    'file:metadata',
    metadataPayload,
    userId,
  );

  // Sync immediately to send the metadata event over WebSocket
  await wsClient.syncPending();

  return upload;
}

/**
 * Upload file chunk
 */
export async function uploadFileChunk(
  upload: FileUpload,
  chunkIndex: number,
  chunkData: Uint8Array,
): Promise<EncryptedEvent> {
  const deviceId = getOrCreateDeviceId();
  const wsClient = getWebSocketClient();
  const userId = wsClient.getUserId() || undefined;
  
  // Encrypt chunk with file encryption key
  const chunkPayload = {
    data: uint8ArrayToBase64(chunkData),
  };
  const { ciphertext, nonce } = await encryptPayload(chunkPayload as unknown as EventPayload, upload.encryptionKey);
  
  // Compute hash for integrity
  const viewForHash = chunkData.buffer.slice(chunkData.byteOffset, chunkData.byteOffset + chunkData.byteLength) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest('SHA-256', viewForHash);
  const hashArray = new Uint8Array(hashBuffer);
  const hash = Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Combine nonce + ciphertext for encrypted_payload
  // NOTE: nonce is base64 (from generateNonce), ciphertext is base64 (from encryptPayload)
  // We need to decode both from base64, not hex!
  const nonceBytes = new Uint8Array(
    nonce.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );
  // FIX: ciphertext is BASE64, not HEX - decode properly
  const ciphertextBytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const combined = new Uint8Array(nonceBytes.length + ciphertextBytes.length);
  combined.set(nonceBytes, 0);
  combined.set(ciphertextBytes, nonceBytes.length);
  const encryptedPayload = uint8ArrayToBase64(combined);

  const chunkPayload2: FileChunkPayload = {
    file_id: upload.fileId,
    chunk_index: chunkIndex,
    total_chunks: upload.totalChunks,
    data: encryptedPayload, // This is the encrypted chunk
    hash, // SHA-256 hash of original chunk for integrity
  };

  const event = await createEvent(
    `${FILES_STREAM_ID}:${upload.fileId}`,
    deviceId,
    'file:chunk',
    chunkPayload2,
    userId,
  );

  // Sync immediately to send the chunk event over WebSocket
  await wsClient.syncPending();

  upload.uploadedChunks.add(chunkIndex);
  return event;
}

/**
 * Receive file metadata
 */
export async function receiveFileMetadata(
  event: EncryptedEvent,
): Promise<FileMetadataPayload | null> {
  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[Files] Shared encryption key not available');
      return null;
    }

    // Debug: Log key info for troubleshooting decryption issues
    const { getCachedKeyInfo } = await import('@/lib/crypto/shared-key');
    const { loadIdentityKeyPair } = await import('@/lib/crypto/keys');
    const identity = await loadIdentityKeyPair();

    const eventUserId = event.user_id;
    const localIdentityPubKey = identity?.publicKeyHex;
    const identitiesMatch = eventUserId === localIdentityPubKey;

    console.log('[Files] Decrypting metadata with key info:', {
      eventDeviceId: event.device_id,
      eventUserId: eventUserId?.substring(0, 16) + '...',
      localIdentityPubKey: localIdentityPubKey?.substring(0, 16) + '...',
      cachedKeyPubKey: getCachedKeyInfo()?.publicKeyHex?.substring(0, 16) + '...',
      identitiesMatch,
      fullEventUserId: eventUserId, // Full ID for debugging
      fullLocalIdentity: localIdentityPubKey, // Full ID for debugging
    });

    if (!identitiesMatch) {
      console.error('[Files] IDENTITY MISMATCH! Event was encrypted with a different identity keypair.', {
        eventUserId,
        localIdentityPubKey,
        hint: 'This usually means the pairing did not properly transfer the identity keypair.',
      });
    }

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as FileMetadataPayload;

    return payload;
  } catch (error) {
    console.error('[Files] Failed to decrypt metadata:', error);
    // Log additional context on decryption failure
    const { loadIdentityKeyPair } = await import('@/lib/crypto/keys');
    const identity = await loadIdentityKeyPair();
    console.error('[Files] Decryption failed - identity context:', {
      eventUserId: event.user_id,
      localIdentityPubKey: identity?.publicKeyHex,
      areEqual: event.user_id === identity?.publicKeyHex,
    });
    return null;
  }
}

/**
 * Receive file chunk
 * Now persists chunks to IndexedDB for resume capability
 */
export async function receiveFileChunk(
  event: EncryptedEvent,
  fileEncryptionKey: CryptoKey,
  fileId: string,
  persistChunk: boolean = true,
): Promise<{ chunkIndex: number; data: Uint8Array; hash: string } | null> {
  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[Files] Shared encryption key not available');
      return null;
    }

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as FileChunkPayload;

    // Decrypt chunk data
    const chunkData = await decryptPayload(
      payload.data,
      fileEncryptionKey,
    ) as { data: string };

    // Decode base64
    const dataBytes = Uint8Array.from(atob(chunkData.data), c => c.charCodeAt(0));

    // Verify hash
    const viewForHash2 = dataBytes.buffer.slice(dataBytes.byteOffset, dataBytes.byteOffset + dataBytes.byteLength) as ArrayBuffer;
    const hashBuffer = await crypto.subtle.digest('SHA-256', viewForHash2);
    const hashArray = new Uint8Array(hashBuffer);
    const computedHash = Array.from(hashArray)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (computedHash !== payload.hash) {
      throw new Error('Chunk integrity check failed');
    }

    // Persist chunk to database for resume capability
    if (persistChunk) {
      const chunk: FileChunk = {
        id: `${fileId}:${payload.chunk_index}`,
        fileId,
        chunkIndex: payload.chunk_index,
        data: chunkData.data, // Store base64 to save memory
        receivedAt: Date.now(),
      };
      await saveFileChunk(chunk);
      console.log(`[Files] Persisted chunk ${payload.chunk_index} for file ${fileId}`);
    }

    return {
      chunkIndex: payload.chunk_index,
      data: dataBytes,
      hash: payload.hash,
    };
  } catch (error) {
    console.error('[Files] Failed to decrypt chunk:', error);
    return null;
  }
}

/**
 * Get missing chunk indexes for a file
 * Used to resume interrupted transfers
 */
export async function getMissingChunks(
  fileId: string,
  totalChunks: number,
): Promise<number[]> {
  const persistedChunks = await getFileChunks(fileId);
  const receivedIndexes = new Set(persistedChunks.map(c => c.chunkIndex));

  const missing: number[] = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!receivedIndexes.has(i)) {
      missing.push(i);
    }
  }

  return missing;
}

/**
 * Get transfer progress for a file
 */
export async function getFileTransferProgress(
  fileId: string,
  totalChunks: number,
): Promise<{ received: number; total: number; percentage: number }> {
  const persistedChunks = await getFileChunks(fileId);
  const received = persistedChunks.length;
  const percentage = Math.round((received / totalChunks) * 100);

  return {
    received,
    total: totalChunks,
    percentage,
  };
}

/**
 * Reassemble file from chunks
 * Now supports resume - checks database for existing chunks first
 */
export async function reassembleFile(
  fileId: string,
  metadata: FileMetadataPayload,
): Promise<Blob | null> {
  try {
    // Import file encryption key
    const encryptionKeyBytes = Uint8Array.from(atob(metadata.encryption_key || ''), c => c.charCodeAt(0));
    const fileEncryptionKey = await importAESKey(encryptionKeyBytes);

    console.log(`[Files] Reassembling file ${fileId} (${metadata.total_chunks} chunks)`);

    // First, check for persisted chunks in database (resume support)
    const persistedChunks = await getFileChunks(fileId);
    console.log(`[Files] Found ${persistedChunks.length} persisted chunks`);

    const chunks: Uint8Array[] = new Array(metadata.total_chunks);

    // Load persisted chunks first
    for (const persistedChunk of persistedChunks) {
      const dataBytes = Uint8Array.from(atob(persistedChunk.data), c => c.charCodeAt(0));
      chunks[persistedChunk.chunkIndex] = dataBytes;
    }

    // Identify missing chunks
    const missingChunks: number[] = [];
    for (let i = 0; i < metadata.total_chunks; i++) {
      if (!chunks[i]) {
        missingChunks.push(i);
      }
    }

    if (missingChunks.length > 0) {
      console.log(`[Files] Missing ${missingChunks.length} chunks, fetching from events...`);

      // Get all chunks for this file from events
      const events = await getEventsByStream(`${FILES_STREAM_ID}:${fileId}`);

      // Process only missing chunks
      for (const event of events) {
        if (event.type === 'file:chunk') {
          const chunk = await receiveFileChunk(event, fileEncryptionKey, fileId, false); // Don't persist again
          if (chunk && missingChunks.includes(chunk.chunkIndex)) {
            chunks[chunk.chunkIndex] = chunk.data;
          }
        }
      }
    }

    // Check if all chunks are present
    const hasAllChunks = chunks.every(chunk => chunk !== undefined);
    if (!hasAllChunks) {
      console.error('[Files] Missing chunks after reassembly attempt');
      return null;
    }

    console.log(`[Files] All chunks present, combining...`);

    // Combine chunks
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // Clean up persisted chunks after successful reassembly
    await deleteFileChunks(fileId);
    console.log(`[Files] Cleaned up persisted chunks for file ${fileId}`);

    return new Blob([combined], { type: metadata.mime_type });
  } catch (error) {
    console.error('[Files] Failed to reassemble file:', error);
    return null;
  }
}

/**
 * Clean up abandoned file transfers
 * Removes chunks for transfers older than the specified age
 * @param maxAgeMs - Maximum age in milliseconds (default: 7 days)
 * @returns Number of files cleaned up
 */
export async function cleanupAbandonedTransfers(
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000, // 7 days
): Promise<number> {
  try {
    const { getIncompleteFileIds } = await import('@/lib/sync/db');
    const incompleteFileIds = await getIncompleteFileIds();

    const now = Date.now();
    let cleanedCount = 0;

    for (const fileId of incompleteFileIds) {
      const chunks = await getFileChunks(fileId);

      if (chunks.length === 0) continue;

      // Check if all chunks are older than maxAge
      const oldestChunk = chunks.reduce((oldest, chunk) =>
        chunk.receivedAt < oldest ? chunk.receivedAt : oldest
      , chunks[0].receivedAt);

      if (now - oldestChunk > maxAgeMs) {
        await deleteFileChunks(fileId);
        cleanedCount++;
        console.log(`[Files] Cleaned up abandoned transfer for file ${fileId}`);
      }
    }

    return cleanedCount;
  } catch (error) {
    console.error('[Files] Failed to cleanup abandoned transfers:', error);
    return 0;
  }
}

/**
 * Request missing chunks for a file (resume protocol)
 * Sends a resume request to the sender with list of missing chunks
 */
export async function requestMissingChunks(
  fileId: string,
  totalChunks: number,
): Promise<EncryptedEvent | null> {
  try {
    const missingChunks = await getMissingChunks(fileId, totalChunks);

    if (missingChunks.length === 0) {
      console.log(`[Files] No missing chunks for file ${fileId}`);
      return null;
    }

    console.log(`[Files] Requesting ${missingChunks.length} missing chunks for file ${fileId}:`, missingChunks);

    const deviceId = getOrCreateDeviceId();
    const wsClient = getWebSocketClient();
    const userId = wsClient.getUserId() || undefined;

    const payload: FileResumeRequestPayload = {
      file_id: fileId,
      missing_chunks: missingChunks,
      total_chunks: totalChunks,
    };

    const event = await createEvent(
      `${FILES_STREAM_ID}:${fileId}`,
      deviceId,
      'file:resume_request',
      payload,
      userId,
    );

    // Send immediately
    await wsClient.syncPending();

    return event;
  } catch (error) {
    console.error('[Files] Failed to request missing chunks:', error);
    return null;
  }
}

/**
 * Handle resume request from receiver
 * Re-sends requested chunks
 */
export async function handleResumeRequest(
  event: EncryptedEvent,
  upload: FileUpload,
  file: File,
): Promise<void> {
  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[Files] Shared encryption key not available');
      return;
    }

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as FileResumeRequestPayload;

    console.log(`[Files] Received resume request for ${payload.missing_chunks.length} chunks:`, payload.missing_chunks);

    // Use dynamic chunk size based on file size
    const chunkSize = getOptimalChunkSize(file.size);

    // Re-send missing chunks
    for (const chunkIndex of payload.missing_chunks) {
      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunkBlob = file.slice(start, end);
      const chunkArrayBuffer = await chunkBlob.arrayBuffer();
      const chunkData = new Uint8Array(chunkArrayBuffer);

      await uploadFileChunk(upload, chunkIndex, chunkData);
      console.log(`[Files] Re-sent chunk ${chunkIndex} for file ${upload.fileId}`);
    }

    console.log(`[Files] Resume complete: re-sent ${payload.missing_chunks.length} chunks`);
  } catch (error) {
    console.error('[Files] Failed to handle resume request:', error);
  }
}

/**
 * Send chunk acknowledgment
 * Notifies sender that chunk was received
 */
export async function sendChunkAck(
  fileId: string,
  chunkIndex: number,
): Promise<EncryptedEvent | null> {
  try {
    const deviceId = getOrCreateDeviceId();
    const wsClient = getWebSocketClient();
    const userId = wsClient.getUserId() || undefined;

    const payload: FileChunkAckPayload = {
      file_id: fileId,
      chunk_index: chunkIndex,
      received_at: Date.now(),
    };

    const event = await createEvent(
      `${FILES_STREAM_ID}:${fileId}`,
      deviceId,
      'file:chunk_ack',
      payload,
      userId,
    );

    // Send immediately
    await wsClient.syncPending();

    return event;
  } catch (error) {
    console.error('[Files] Failed to send chunk ack:', error);
    return null;
  }
}

/**
 * Handle chunk acknowledgment from receiver
 * Updates upload progress tracking
 */
export async function handleChunkAck(
  event: EncryptedEvent,
  upload: FileUpload,
): Promise<void> {
  try {
    const sharedKey = await getSharedEncryptionKey();
    if (!sharedKey) {
      console.error('[Files] Shared encryption key not available');
      return;
    }

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as FileChunkAckPayload;

    upload.uploadedChunks.add(payload.chunk_index);
    console.log(`[Files] Chunk ${payload.chunk_index} acknowledged (${upload.uploadedChunks.size}/${upload.totalChunks})`);
  } catch (error) {
    console.error('[Files] Failed to handle chunk ack:', error);
  }
}

/**
 * Resume an interrupted file transfer
 * Checks for existing chunks and requests only missing ones
 * @returns Progress info showing existing and missing chunks
 */
export async function resumeFileTransfer(
  fileId: string,
  totalChunks: number,
): Promise<{ existing: number; missing: number; requested: boolean }> {
  try {
    const progress = await getFileTransferProgress(fileId, totalChunks);

    if (progress.percentage === 100) {
      console.log(`[Files] Transfer already complete for file ${fileId}`);
      return { existing: progress.received, missing: 0, requested: false };
    }

    const missingChunks = await getMissingChunks(fileId, totalChunks);

    console.log(`[Files] Resuming transfer: ${progress.received} chunks existing, ${missingChunks.length} missing`);

    if (missingChunks.length > 0) {
      await requestMissingChunks(fileId, totalChunks);
      return { existing: progress.received, missing: missingChunks.length, requested: true };
    }

    return { existing: progress.received, missing: 0, requested: false };
  } catch (error) {
    console.error('[Files] Failed to resume transfer:', error);
    return { existing: 0, missing: totalChunks, requested: false };
  }
}







