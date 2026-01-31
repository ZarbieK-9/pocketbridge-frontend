"use client"

/**
 * File Beaming Page - Optimized for Large Files
 * 
 * Chunked file transfer with E2E encryption
 * - Up to 25GB per file
 * - Parallel chunk uploads (10 chunks simultaneously)
 * - 5MB chunks for maximum speed
 * - Resume support
 */

import { useEffect, useState, useRef } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { useCrypto } from '@/hooks/use-crypto';
import {
  startFileUpload,
  uploadFileChunk,
} from '@/lib/features/files';
import { fetchFileHistory, type FileHistoryItem } from '@/lib/features/files-api';
import {
  startTracking,
  getTransfer,
  storeChunk,
  getChunks,
  deleteTransfer,
  cleanupStaleTransfers,
  getReceivingTransfers,
  bufferOrphanedChunkEvent,
  getOrphanedChunkEvents,
  clearOrphanedChunkEvents,
  getTransferProgress,
} from '@/lib/features/file-transfer-tracker';
import {
  startUploadTracking,
  storeUploadChunk,
  markChunkSent,
  getUpload,
  getUploadChunk,
  markChunkAcked,
  deleteUpload,
  getUploadProgress,
  cleanupStaleUploads,
} from '@/lib/features/file-upload-tracker';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { checkRateLimit } from '@/lib/utils/rate-limit';
import { validateFile } from '@/lib/utils/validation';
import { ValidationError } from '@/lib/utils/errors';
import { logger } from '@/lib/utils/logger';
import { MAX_FILE_SIZE, getOptimalChunkSize, getOptimalParallelChunks } from '@/lib/constants';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Upload, FileIcon } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { config } from '@/lib/config';
import { SyncIndicator } from '@/components/sync-indicator';
import { toast } from '@/components/ui/toast';

const WS_URL = config.wsUrl;

interface FileTransfer {
  fileId: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'completed' | 'error';
  direction: 'sending' | 'receiving';
  startTime?: number; // Timestamp when transfer started
  speed?: number; // Current speed in bytes/second
}

export default function FilesPage() {
  const deviceId = getOrCreateDeviceId();
  const { isInitialized: cryptoInitialized, identityKeyPair } = useCrypto();
  const { isConnected, sessionKeys, lastEvent } = useWebSocket({
    url: WS_URL,
    deviceId,
    autoConnect: cryptoInitialized,
  });

  const [transfers, setTransfers] = useState<FileTransfer[]>([]);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'sending' | 'synced' | 'error'>('idle');
  const [fileHistory, setFileHistory] = useState<FileHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Map of fileId to metadata for quick lookup (still needed for decryption key)
  const metadataCache = useRef<Map<string, any>>(new Map());

  // Track if we've already sent resume requests this session
  const resumeRequestsSent = useRef<Set<string>>(new Set());
  // Track processed fileIds to avoid duplicate downloads
  const processedFilesRef = useRef<Set<string>>(new Set());

  // Cleanup stale transfers and load incomplete transfers on mount
  useEffect(() => {
    async function initTransferTracker() {
      try {
        // Clean up stale transfers (older than 30 minutes for receives, 1 hour for uploads)
        const cleanedReceives = await cleanupStaleTransfers();
        const cleanedUploads = await cleanupStaleUploads();
        if (cleanedReceives > 0 || cleanedUploads > 0) {
          logger.info('Cleaned up stale transfers', { cleanedReceives, cleanedUploads });
        }

        // Load any incomplete transfers to show in UI
        const incompleteTransfers = await getReceivingTransfers();
        if (incompleteTransfers.length > 0) {
          logger.info('Resuming incomplete transfers', { count: incompleteTransfers.length });
          const resumedTransfers: FileTransfer[] = incompleteTransfers.map((t) => ({
            fileId: t.fileId,
            name: t.name,
            size: t.size,
            progress: getTransferProgress(t),
            status: 'uploading' as const,
            direction: 'receiving' as const, // Resumed transfers are always receives
          }));
          setTransfers((prev) => [...prev, ...resumedTransfers]);
        }
      } catch (error) {
        logger.error('Failed to initialize transfer tracker', error);
      }
    }

    if (cryptoInitialized) {
      initTransferTracker();
    }
  }, [cryptoInitialized]);

  // Send resume requests when WebSocket connects and there are incomplete transfers
  useEffect(() => {
    async function requestMissingChunks() {
      if (!isConnected) return;

      const incompleteTransfers = await getReceivingTransfers();
      for (const transfer of incompleteTransfers) {
        // Skip if we already sent a resume request for this file this session
        if (resumeRequestsSent.current.has(transfer.fileId)) continue;

        // Calculate missing chunks
        const receivedIndices = new Set<number>();
        const chunks = await getChunks(transfer.fileId);
        for (const chunk of chunks) {
          receivedIndices.add(chunk.chunkIndex);
        }

        const missingChunks: number[] = [];
        for (let i = 0; i < transfer.totalChunks; i++) {
          if (!receivedIndices.has(i)) {
            missingChunks.push(i);
          }
        }

        if (missingChunks.length > 0) {
          logger.info('Requesting missing chunks', {
            fileId: transfer.fileId,
            name: transfer.name,
            missingCount: missingChunks.length,
            totalChunks: transfer.totalChunks,
          });
          await sendResumeRequest(transfer.fileId, missingChunks, transfer.totalChunks);
          resumeRequestsSent.current.add(transfer.fileId);
        }
      }
    }

    if (isConnected && cryptoInitialized) {
      requestMissingChunks();
    }
  }, [isConnected, cryptoInitialized]);

  // Fetch file history on mount
  useEffect(() => {
    async function loadHistory() {
      if (!identityKeyPair?.publicKeyHex) return;

      setHistoryLoading(true);
      try {
        const { files } = await fetchFileHistory(identityKeyPair.publicKeyHex);
        setFileHistory(files);
      } catch (error) {
        logger.error('Failed to load file history', error);
      } finally {
        setHistoryLoading(false);
      }
    }

    if (cryptoInitialized && identityKeyPair) {
      loadHistory();
    }
  }, [cryptoInitialized, identityKeyPair]);

  // Handle incoming file events (skip self-originated events)
  useEffect(() => {
    // DEBUG: Log all incoming events for tracing (only file events to reduce noise)
    if (lastEvent && lastEvent.type.startsWith('file:')) {
      console.log('[FILES PAGE] Received FILE event:', {
        type: lastEvent.type,
        eventId: lastEvent.event_id,
        deviceId: lastEvent.device_id,
        isOwnDevice: lastEvent.device_id === deviceId,
        hasSessionKeys: !!sessionKeys,
      });
    }

    if (lastEvent && sessionKeys) {
      // Skip events from this device to avoid processing our own uploads
      if (lastEvent.device_id === deviceId) {
        console.log('[FILES PAGE] Skipping own device event');
        return;
      }

      if (lastEvent.type === 'file:metadata') {
        console.log('[FILES PAGE] Processing file:metadata event');
        handleIncomingFileMetadata(lastEvent);
        setSyncStatus('synced');
        toast('File received from another device', 'success');
      } else if (lastEvent.type === 'file:chunk') {
        console.log('[FILES PAGE] Processing file:chunk event');
        handleIncomingFileChunk(lastEvent);
      } else if (lastEvent.type === 'file:chunk_ack') {
        console.log('[FILES PAGE] Processing file:chunk_ack event');
        handleChunkAck(lastEvent);
      } else if (lastEvent.type === 'file:resume_request') {
        console.log('[FILES PAGE] Processing file:resume_request event');
        handleResumeRequest(lastEvent);
      }
    } else if (lastEvent && !sessionKeys) {
      console.warn('[FILES PAGE] Event received but no session keys!', {
        type: lastEvent.type,
        eventId: lastEvent.event_id,
      });
    }
  }, [lastEvent, sessionKeys, deviceId]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !sessionKeys) return;

    // Rate limiting for file uploads
    const rateLimit = checkRateLimit(`file:${deviceId}`, 'fileUpload');
    if (!rateLimit.allowed) {
      const resetIn = Math.ceil((rateLimit.resetAt - Date.now()) / 1000 / 60);
      toast(`Rate limit exceeded. Please wait ${resetIn} minutes before uploading another file.`, 'error');
      return;
    }

    try {
      // Validate file
      validateFile(file);
      
      if (file.size > MAX_FILE_SIZE) {
        throw new ValidationError(`File too large. Maximum size: ${(MAX_FILE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB`);
      }

      setSyncStatus('sending');
      const upload = await startFileUpload(file);
      const startTime = Date.now();

      const transfer: FileTransfer = {
        fileId: upload.fileId,
        name: upload.name,
        size: upload.size,
        progress: 0,
        status: 'uploading',
        direction: 'sending',
        startTime,
        speed: 0,
      };
      setTransfers((prev) => [...prev, transfer]);
      toast(`Sending ${file.name} to all devices...`, 'info');

      // Upload chunks with speed tracking
      await uploadFileInChunks(file, upload, (progress) => {
        const elapsed = (Date.now() - startTime) / 1000; // seconds
        const bytesTransferred = (progress / 100) * file.size;
        const speed = elapsed > 0 ? bytesTransferred / elapsed : 0;

        setTransfers((prev) =>
          prev.map((t) =>
            t.fileId === upload.fileId
              ? { ...t, progress, speed, status: progress === 100 ? 'completed' : 'uploading' }
              : t
          )
        );
      });

      // Mark sync as complete after upload finishes
      setSyncStatus('synced');
      toast(`${file.name} sent successfully!`, 'success');
    } catch (error) {
      logger.error('Failed to upload file', error);
      setSyncStatus('error');
      if (error instanceof ValidationError) {
        toast(error.message, 'error');
      } else {
        toast('Failed to upload file. Please try again.', 'error');
      }
    }
  }

  async function uploadFileInChunks(
    file: File,
    upload: Awaited<ReturnType<typeof startFileUpload>>,
    onProgress: (progress: number) => void
  ) {
    const totalChunks = upload.totalChunks;
    // Use dynamic chunk size and parallelism based on file size for maximum speed
    const CHUNK_SIZE = getOptimalChunkSize(file.size);
    const PARALLEL_CHUNKS = getOptimalParallelChunks(file.size);
    let uploadedChunks = 0;
    const failedChunks: number[] = [];

    logger.info('Uploading file chunks', {
      totalChunks,
      parallelChunks: PARALLEL_CHUNKS,
      chunkSizeMB: CHUNK_SIZE / (1024 * 1024),
      fileSizeMB: file.size / (1024 * 1024),
    });

    // Get encryption key as base64 for storage
    const { exportAESKey } = await import('@/lib/crypto/keys');
    const encryptionKeyBytes = await exportAESKey(upload.encryptionKey);
    const encryptionKeyBase64 = btoa(String.fromCharCode(...encryptionKeyBytes));

    // Start upload tracking for resume capability
    await startUploadTracking(upload.fileId, file, encryptionKeyBase64, totalChunks);

    // Upload chunks in parallel batches
    for (let batchStart = 0; batchStart < totalChunks; batchStart += PARALLEL_CHUNKS) {
      const batchEnd = Math.min(batchStart + PARALLEL_CHUNKS, totalChunks);
      const batch: Promise<void>[] = [];

      // Create parallel upload promises for this batch
      for (let i = batchStart; i < batchEnd; i++) {
        const chunkIndex = i;
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);

        const uploadPromise = (async () => {
          try {
            const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());

            // Store chunk for potential resume
            await storeUploadChunk(upload.fileId, chunkIndex, chunk);

            // Upload the chunk
            await uploadFileChunk(upload, chunkIndex, chunk);

            // Mark as sent
            await markChunkSent(upload.fileId, chunkIndex);

            uploadedChunks++;
            const progress = (uploadedChunks / totalChunks) * 100;
            onProgress(progress);

            // Log progress every 10%
            if (uploadedChunks % Math.max(1, Math.floor(totalChunks / 10)) === 0) {
              logger.debug('Upload progress', { progress: progress.toFixed(1), uploadedChunks, totalChunks });
            }
          } catch (error) {
            logger.error('Failed to upload chunk', error, { chunkIndex });
            failedChunks.push(chunkIndex);
            throw error;
          }
        })();

        batch.push(uploadPromise);
      }

      // Wait for all chunks in this batch to complete
      await Promise.all(batch);
    }

    // Retry failed chunks
    if (failedChunks.length > 0) {
      logger.info('Retrying failed chunks', { failedCount: failedChunks.length });
      for (const chunkIndex of failedChunks) {
        try {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
          await uploadFileChunk(upload, chunkIndex, chunk);
          await markChunkSent(upload.fileId, chunkIndex);
          uploadedChunks++;
          onProgress((uploadedChunks / totalChunks) * 100);
        } catch (error) {
          logger.error('Failed to retry chunk', error, { chunkIndex });
          throw new Error(`Failed to upload chunk ${chunkIndex} after retry`);
        }
      }
    }

    logger.info('Upload complete (waiting for acks)', { fileName: upload.name, fileSize: upload.size });
  }

  async function handleIncomingFileMetadata(event: any) {
    console.log('[FILES PAGE] handleIncomingFileMetadata called', { eventId: event.event_id });
    try {
      const { receiveFileMetadata } = await import('@/lib/features/files');
      console.log('[FILES PAGE] Calling receiveFileMetadata...');
      const metadata = await receiveFileMetadata(event);
      console.log('[FILES PAGE] receiveFileMetadata result:', metadata);
      if (metadata) {
        console.log('[FILES PAGE] Starting transfer tracking:', { fileId: metadata.file_id, name: metadata.name });

        // Cache metadata for decryption
        metadataCache.current.set(metadata.file_id, metadata);

        // Start persistent tracking
        await startTracking(
          metadata.file_id,
          {
            name: metadata.name,
            size: metadata.size,
            mimeType: metadata.mime_type,
            totalChunks: metadata.total_chunks,
            encryptionKey: metadata.encryption_key || '',
          },
          event.device_id
        );

        // Add to transfers list
        const transfer: FileTransfer = {
          fileId: metadata.file_id,
          name: metadata.name,
          size: metadata.size,
          progress: 0,
          status: 'uploading',
          direction: 'receiving',
        };
        setTransfers(prev => {
          // Avoid duplicates (might already exist from resumed transfers)
          if (prev.some(t => t.fileId === metadata.file_id)) return prev;
          return [...prev, transfer];
        });

        // Process any orphaned chunk events that arrived before metadata
        const orphanedEvents = getOrphanedChunkEvents(metadata.file_id);
        if (orphanedEvents.length > 0) {
          logger.debug('Processing orphaned chunk events', { fileId: metadata.file_id, count: orphanedEvents.length });
          clearOrphanedChunkEvents(metadata.file_id);
          for (const chunkEvent of orphanedEvents) {
            await handleIncomingFileChunk(chunkEvent);
          }
        }

        // Check if transfer is now complete after processing orphaned chunks
        const updatedTransfer = await getTransfer(metadata.file_id);
        if (updatedTransfer?.status === 'complete') {
          await handleTransferComplete(metadata.file_id, metadata);
        }
      }
    } catch (error) {
      logger.error('Failed to handle incoming file metadata', error);
    }
  }

  async function handleIncomingFileChunk(event: any) {
    try {
      const { receiveFileChunk } = await import('@/lib/features/files');
      const { getSharedEncryptionKey } = await import('@/lib/crypto/shared-key');
      const { decryptPayload } = await import('@/lib/crypto/encryption');

      // Decrypt payload to get file_id
      const sharedKey = await getSharedEncryptionKey();
      if (!sharedKey) {
        logger.error('Shared encryption key not available');
        return;
      }
      const payload = await decryptPayload(event.encrypted_payload, sharedKey) as any;
      const fileId = payload.file_id;

      if (!fileId) {
        logger.error('Received chunk without file_id');
        return;
      }

      // Check if we have metadata (either cached or in tracker)
      let metadata = metadataCache.current.get(fileId);
      if (!metadata) {
        // Try to get from tracker
        const transfer = await getTransfer(fileId);
        if (transfer) {
          metadata = {
            file_id: fileId,
            name: transfer.name,
            mime_type: transfer.mimeType,
            total_chunks: transfer.totalChunks,
            encryption_key: transfer.encryptionKey,
          };
          metadataCache.current.set(fileId, metadata);
        }
      }

      if (!metadata) {
        // Buffer raw event for later - metadata may arrive after chunks due to network reordering
        // We can't decrypt without the encryption key from metadata
        console.log('[FILES PAGE] Buffering orphaned chunk event for file:', fileId, 'chunk:', payload.chunk_index);
        bufferOrphanedChunkEvent(fileId, event);
        return;
      }

      // Import file encryption key
      const { importAESKey } = await import('@/lib/crypto/keys');
      const encryptionKeyBytes = Uint8Array.from(atob(metadata.encryption_key || ''), c => c.charCodeAt(0));
      const fileEncryptionKey = await importAESKey(encryptionKeyBytes);

      const chunk = await receiveFileChunk(event, fileEncryptionKey);
      if (chunk) {
        // Store chunk in persistent tracker
        const { complete, transfer } = await storeChunk(
          fileId,
          chunk.chunkIndex,
          chunk.data,
          chunk.hash
        );

        // Send acknowledgment to sender
        await sendChunkAck(fileId, chunk.chunkIndex);

        if (complete && transfer) {
          // Transfer is complete - reassemble and download
          await handleTransferComplete(fileId, metadata);
        } else if (transfer) {
          // Update progress
          const progress = getTransferProgress(transfer);
          setTransfers(prev =>
            prev.map(t =>
              t.fileId === fileId
                ? { ...t, progress, status: 'uploading' }
                : t
            )
          );
        }
      }
    } catch (error) {
      logger.error('Failed to handle incoming file chunk', error);
    }
  }

  async function handleTransferComplete(fileId: string, metadata: any) {
    try {
      // Dedup: prevent duplicate reassembly/downloads for the same file
      const processedRef = processedFilesRef.current;
      if (processedRef.has(fileId)) {
        logger.warn('Ignoring duplicate transfer complete for already processed file', { fileId });
        return;
      }
      processedRef.add(fileId);

      // Get all chunks from persistent storage
      const chunks = await getChunks(fileId);

      // Reassemble in order
      const chunksMap = new Map<number, Uint8Array>();
      for (const chunk of chunks) {
        chunksMap.set(chunk.chunkIndex, chunk.data);
      }

      // Reassemble and download
      await reassembleAndDownloadFile(metadata, chunksMap);

      // Update transfer status
      setTransfers(prev =>
        prev.map(t =>
          t.fileId === fileId
            ? { ...t, progress: 100, status: 'completed' }
            : t
        )
      );

      // Send file:complete event to notify sender
      await sendFileCompleteEvent(fileId, metadata.name);

      // Clean up tracker after successful download
      await deleteTransfer(fileId);
      metadataCache.current.delete(fileId);

      // Optionally prune processed set if it grows too large
      if (processedRef.size > 1000) {
        // Reset if too large; in practice fileIds are unique per transfer
        processedFilesRef.current = new Set();
      }

      toast(`${metadata.name} received successfully!`, 'success');
    } catch (error) {
      logger.error('Failed to complete transfer', error);
      toast('Failed to reassemble file', 'error');
    }
  }

  async function sendResumeRequest(fileId: string, missingChunks: number[], totalChunks: number) {
    try {
      const { createEvent } = await import('@/lib/sync/event-builder');
      const { getWebSocketClient } = await import('@/lib/ws');

      const wsClient = getWebSocketClient();
      const userId = wsClient.getUserId() || undefined;

      await createEvent(
        'files:main',
        deviceId,
        'file:resume_request',
        { file_id: fileId, missing_chunks: missingChunks, total_chunks: totalChunks },
        userId
      );

      // Sync immediately to send the request
      await wsClient.syncPending();

      logger.info('Sent resume request', { fileId, missingCount: missingChunks.length, totalChunks });
    } catch (err) {
      logger.warn('Failed to send resume request (non-blocking)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function sendChunkAck(fileId: string, chunkIndex: number) {
    try {
      const { createEvent } = await import('@/lib/sync/event-builder');
      const { getWebSocketClient } = await import('@/lib/ws');

      const wsClient = getWebSocketClient();
      const userId = wsClient.getUserId() || undefined;

      await createEvent(
        'files:main',
        deviceId,
        'file:chunk_ack',
        { file_id: fileId, chunk_index: chunkIndex, received_at: Date.now() },
        userId
      );

      // Sync immediately to send the ack
      await wsClient.syncPending();
    } catch (error) {
      // Non-blocking - don't fail chunk processing if ack fails
      logger.debug('Failed to send chunk ack (non-blocking)', { fileId, chunkIndex });
    }
  }

  async function sendFileCompleteEvent(fileId: string, fileName: string) {
    try {
      const { createEvent } = await import('@/lib/sync/event-builder');
      const { getWebSocketClient } = await import('@/lib/ws');

      const wsClient = getWebSocketClient();
      const userId = wsClient.getUserId() || undefined;

      await createEvent(
        'files:main',
        deviceId,
        'file:complete',
        { file_id: fileId, name: fileName, completed_at: Date.now() },
        userId
      );

      // Sync immediately to send the event
      await wsClient.syncPending();

      logger.info('Sent file:complete event', { fileId, fileName });
    } catch (err) {
      logger.warn('Failed to send file:complete event (non-blocking)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleChunkAck(event: any) {
    try {
      const { getSharedEncryptionKey } = await import('@/lib/crypto/shared-key');
      const { decryptPayload } = await import('@/lib/crypto/encryption');

      const sharedKey = await getSharedEncryptionKey();
      if (!sharedKey) {
        logger.error('Shared encryption key not available for chunk ack');
        return;
      }

      const payload = await decryptPayload(event.encrypted_payload, sharedKey) as any;
      const { file_id: fileId, chunk_index: chunkIndex } = payload;

      if (!fileId || chunkIndex === undefined) {
        logger.error('Invalid chunk ack payload');
        return;
      }

      // Mark chunk as acknowledged in upload tracker
      const { allAcked, upload } = await markChunkAcked(fileId, chunkIndex);

      if (upload) {
        // Update progress based on acks
        const progress = getUploadProgress(upload);
        setTransfers(prev =>
          prev.map(t =>
            t.fileId === fileId
              ? { ...t, progress }
              : t
          )
        );

        if (allAcked) {
          logger.info('All chunks acknowledged, upload complete', { fileId, name: upload.name });
          setTransfers(prev =>
            prev.map(t =>
              t.fileId === fileId
                ? { ...t, progress: 100, status: 'completed' }
                : t
            )
          );
          // Clean up upload tracker
          await deleteUpload(fileId);
        }
      }
    } catch (error) {
      logger.error('Failed to handle chunk ack', error);
    }
  }

  async function handleResumeRequest(event: any) {
    try {
      const { getSharedEncryptionKey } = await import('@/lib/crypto/shared-key');
      const { decryptPayload } = await import('@/lib/crypto/encryption');

      const sharedKey = await getSharedEncryptionKey();
      if (!sharedKey) {
        logger.error('Shared encryption key not available for resume request');
        return;
      }

      const payload = await decryptPayload(event.encrypted_payload, sharedKey) as any;
      const { file_id: fileId, missing_chunks: missingChunks } = payload;

      if (!fileId || !Array.isArray(missingChunks)) {
        logger.error('Invalid resume request payload');
        return;
      }

      // Get the upload record
      const upload = await getUpload(fileId);
      if (!upload) {
        logger.warn('Resume request for unknown upload', { fileId });
        return;
      }

      logger.info('Processing resume request', {
        fileId,
        name: upload.name,
        missingCount: missingChunks.length,
      });

      // Re-send missing chunks
      const { importAESKey } = await import('@/lib/crypto/keys');
      const encryptionKeyBytes = Uint8Array.from(atob(upload.encryptionKeyBase64), c => c.charCodeAt(0));
      const fileEncryptionKey = await importAESKey(encryptionKeyBytes);

      for (const chunkIndex of missingChunks) {
        const chunkRecord = await getUploadChunk(fileId, chunkIndex);
        if (chunkRecord) {
          // Re-upload this chunk
          const fakeUpload = {
            fileId: upload.fileId,
            name: upload.name,
            size: upload.size,
            mimeType: upload.mimeType,
            totalChunks: upload.totalChunks,
            encryptionKey: fileEncryptionKey,
            uploadedChunks: new Set(upload.sentChunks),
          };

          await uploadFileChunk(fakeUpload, chunkIndex, chunkRecord.data);
          logger.debug('Re-sent chunk', { fileId, chunkIndex });
        } else {
          logger.warn('Missing chunk data for resume', { fileId, chunkIndex });
        }
      }

      logger.info('Resume request completed', { fileId, resentCount: missingChunks.length });
    } catch (error) {
      logger.error('Failed to handle resume request', error);
    }
  }

  async function reassembleAndDownloadFile(metadata: any, chunks: Map<number, Uint8Array>) {
    try {
      // Reassemble chunks in order
      const chunksArray = Array.from({ length: metadata.total_chunks }, (_, i) => chunks.get(i)!);
      const totalSize = chunksArray.reduce((sum, chunk) => sum + chunk.length, 0);
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunksArray) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      // Create blob and download
      const blob = new Blob([combined], { type: metadata.mime_type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = metadata.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      logger.error('Failed to reassemble file', error);
    }
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatSpeed(bytesPerSecond: number): string {
    if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    if (bytesPerSecond < 1024 * 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    return `${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
  }

  if (!cryptoInitialized) {
    return (
      <div className="container mx-auto p-6">
        <Card className="p-6">
          <p>Initializing cryptography...</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">File Beaming</h1>
        <div className="flex items-center gap-3">
          <SyncIndicator status={syncStatus} />
          <StatusBadge status={isConnected ? 'online' : 'offline'} />
        </div>
      </div>

      {/* Upload Area */}
      <Card>
        <CardHeader>
          <CardTitle>Send File</CardTitle>
          <CardDescription>Upload a file to beam it to your other devices (max {(MAX_FILE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB)</CardDescription>
        </CardHeader>
        <CardContent>
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            className="hidden"
            disabled={!isConnected}
            aria-label="Select file to upload"
          />
          <div
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg border-2 border-dashed border-border bg-muted/20 p-12 text-center transition-colors hover:border-primary/50 hover:bg-primary/5 cursor-pointer"
          >
            <Upload className="mx-auto h-12 w-12 text-muted-foreground" />
            <p className="mt-4 text-sm font-medium">Drag and drop files here</p>
            <p className="mt-2 text-xs text-muted-foreground">or click to browse (max {(MAX_FILE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB)</p>
            <Button
              className="mt-4"
              variant="outline"
              disabled={!isConnected}
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
            >
              Choose File
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Active Transfers */}
      {transfers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active Transfers</CardTitle>
            <CardDescription>Files currently being transferred</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {transfers.map((transfer) => (
                <div key={transfer.fileId} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileIcon className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{transfer.name}</span>
                      <span className="text-xs text-muted-foreground">
                        ({formatFileSize(transfer.size)})
                      </span>
                    </div>
                    <StatusBadge
                      status={
                        transfer.status === 'completed'
                          ? 'online'
                          : transfer.status === 'error'
                          ? 'error'
                          : 'syncing'
                      }
                      label={
                        transfer.status === 'completed'
                          ? (transfer.direction === 'sending' ? 'Sent' : 'Received')
                          : transfer.status === 'error'
                          ? 'Failed'
                          : (transfer.direction === 'sending' ? 'Sending...' : 'Receiving...')
                      }
                    />
                  </div>
                  {transfer.status === 'uploading' && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          {transfer.direction === 'sending' ? 'Uploading' : 'Downloading'}
                          {transfer.speed ? ` • ${formatSpeed(transfer.speed)}` : ''}
                        </span>
                        <span>{Math.round(transfer.progress)}%</span>
                      </div>
                      <Progress value={transfer.progress} className="h-2" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* File History */}
      <Card>
        <CardHeader>
          <CardTitle>Transfer History</CardTitle>
          <CardDescription>Recently sent and received files</CardDescription>
        </CardHeader>
        <CardContent>
          {historyLoading ? (
            <div className="flex items-center justify-center p-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
              <span className="ml-2 text-sm text-muted-foreground">Loading history...</span>
            </div>
          ) : fileHistory.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <FileIcon className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-4 text-sm text-muted-foreground">No file history</p>
              <p className="mt-2 text-xs text-muted-foreground">Transferred files will appear here</p>
            </div>
          ) : (
            <div className="space-y-3">
              {fileHistory.map((file) => (
                <div
                  key={file.eventId}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                >
                  <div className="flex items-center gap-3">
                    <FileIcon className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)} • {file.createdAt.toLocaleDateString()} {file.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {file.deviceId === deviceId ? 'Sent' : 'Received'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
