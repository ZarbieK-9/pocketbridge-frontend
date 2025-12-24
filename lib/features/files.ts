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
import { getEventsByStream } from '@/lib/sync/db';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { FILE_CHUNK_SIZE, MAX_FILE_SIZE } from '@/lib/constants';
import { generateSymmetricKey, importAESKey, exportAESKey } from '@/lib/crypto/keys';
import { encryptPayload } from '@/lib/crypto/encryption';
import { getSharedEncryptionKey } from '@/lib/crypto/shared-key';
import type { EncryptedEvent, FileChunkPayload, FileMetadataPayload, EventPayload } from '@/types';

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
  const fileId = crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE);
  
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
  );

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
  
  // Encrypt chunk with file encryption key
  const chunkPayload = {
    data: btoa(String.fromCharCode(...chunkData)),
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
  const nonceBytes = new Uint8Array(
    nonce.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );
  const ciphertextBytes = new Uint8Array(
    ciphertext.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  );
  const combined = new Uint8Array(nonceBytes.length + ciphertextBytes.length);
  combined.set(nonceBytes, 0);
  combined.set(ciphertextBytes, nonceBytes.length);
  const encryptedPayload = btoa(String.fromCharCode(...combined));

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
  );

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

    const payload = await decryptPayload(
      event.encrypted_payload,
      sharedKey,
    ) as FileMetadataPayload;

    return payload;
  } catch (error) {
    console.error('[Files] Failed to decrypt metadata:', error);
    return null;
  }
}

/**
 * Receive file chunk
 */
export async function receiveFileChunk(
  event: EncryptedEvent,
  fileEncryptionKey: CryptoKey,
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
 * Reassemble file from chunks
 */
export async function reassembleFile(
  fileId: string,
  metadata: FileMetadataPayload,
): Promise<Blob | null> {
  try {
    // Import file encryption key
    const encryptionKeyBytes = Uint8Array.from(atob(metadata.encryption_key || ''), c => c.charCodeAt(0));
    const fileEncryptionKey = await importAESKey(encryptionKeyBytes);

    // Get all chunks for this file
    const events = await getEventsByStream(`${FILES_STREAM_ID}:${fileId}`);
    events.sort((a, b) => {
      const payloadA = JSON.parse(atob(a.encrypted_payload)) as FileChunkPayload;
      const payloadB = JSON.parse(atob(b.encrypted_payload)) as FileChunkPayload;
      return payloadA.chunk_index - payloadB.chunk_index;
    });

    const chunks: Uint8Array[] = [];
    
    for (const event of events) {
      if (event.type === 'file:chunk') {
        const chunk = await receiveFileChunk(event, fileEncryptionKey);
        if (chunk) {
          chunks[chunk.chunkIndex] = chunk.data;
        }
      }
    }

    // Check if all chunks are present
    if (chunks.length !== metadata.total_chunks) {
      console.error('[Files] Missing chunks');
      return null;
    }

    // Combine chunks
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return new Blob([combined], { type: metadata.mime_type });
  } catch (error) {
    console.error('[Files] Failed to reassemble file:', error);
    return null;
  }
}







