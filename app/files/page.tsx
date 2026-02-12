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

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { eventRouter } from '@/lib/ws/event-router';
import { useCrypto } from '@/hooks/use-crypto';
import { getWebSocketClient } from '@/lib/ws';
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
  markTransferFailed,
  getFailedTransfers,
  deleteTransferChunks,
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
  markUploadFailed,
  getIncompleteUploads,
  getFailedUploads,
  getUnsentChunks,
} from '@/lib/features/file-upload-tracker';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { checkRateLimit } from '@/lib/utils/rate-limit';
import { validateFile } from '@/lib/utils/validation';
import { ValidationError } from '@/lib/utils/errors';
import { logger } from '@/lib/utils/logger';
import { MAX_FILE_SIZE, getOptimalChunkSize, getOptimalParallelChunks, shouldUseWebRTC } from '@/lib/constants';
import {
  sendFileViaWebRTC,
  handleWebRTCOffer,
  handleWebRTCAnswer,
  handleICECandidate,
  onTransferEvent,
  type WebRTCFileTransfer,
} from '@/lib/features/webrtc-transfer';
import { Button } from '@/components/ui/button';
import { Upload, FileIcon, FolderOpen, ShieldCheck, CheckCircle2, XCircle, ArrowUpCircle, ArrowDownCircle, X, RefreshCw } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { config } from '@/lib/config';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { MainLayout } from '@/components/layout/main-layout';

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
  failReason?: string; // Reason for failure
  sourceDeviceId?: string; // Device that sent this file (for offline detection)
}

export default function FilesPage() {
  const deviceId = getOrCreateDeviceId();
  const { isInitialized: cryptoInitialized, identityKeyPair } = useCrypto();
  const { isConnected, sessionKeys, lastSystemMessage } = useWebSocket({
    url: WS_URL,
    deviceId,
    autoConnect: cryptoInitialized,
  });

  const [transfers, setTransfers] = useState<FileTransfer[]>([]);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'sending' | 'synced' | 'error'>('idle');
  const [fileHistory, setFileHistory] = useState<FileHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dedupeHistory = useCallback((items: FileHistoryItem[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.eventId)) return false;
      seen.add(item.eventId);
      return true;
    });
  }, []);

  const addHistoryItem = useCallback((item: FileHistoryItem) => {
    setFileHistory((prev) => {
      if (prev.some((entry) => entry.eventId === item.eventId)) return prev;
      return [item, ...prev];
    });
  }, []);

  const dedupedHistory = useMemo(() => dedupeHistory(fileHistory), [fileHistory, dedupeHistory]);

  const dedupeTransfers = useCallback((items: FileTransfer[]) => {
    const seen = new Map<string, FileTransfer>();
    for (const item of items) {
      const existing = seen.get(item.fileId);
      if (!existing || item.progress > existing.progress || item.status === 'completed') {
        seen.set(item.fileId, item);
      }
    }
    return Array.from(seen.values());
  }, []);

  const dedupedTransfers = useMemo(() => dedupeTransfers(transfers), [transfers, dedupeTransfers]);

  // Map of fileId to metadata for quick lookup (still needed for decryption key)
  const metadataCache = useRef<Map<string, any>>(new Map());

  // Track if we've already sent resume requests this session
  const resumeRequestsSent = useRef<Set<string>>(new Set());
  // Track processed fileIds to avoid duplicate downloads
  const processedFilesRef = useRef<Set<string>>(new Set());

  // Chunk-arrival timeout: if no new chunk arrives for 60 seconds, mark transfer as failed
  const chunkTimeoutTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const resetChunkTimeout = useCallback((fileId: string) => {
    // Clear existing timer
    const existing = chunkTimeoutTimers.current.get(fileId);
    if (existing) clearTimeout(existing);

    // Set new 60-second timer
    const timer = setTimeout(async () => {
      const transfer = await getTransfer(fileId);
      if (transfer && transfer.status === 'receiving') {
        logger.info('[FileTransfer] Chunk timeout — no data received for 60s', { fileId });
        await markTransferFailed(fileId, 'Transfer timed out — no data received');
        // Move from active transfers to file history
        setTransfers(prev => {
          const failedTransfer = prev.find(t => t.fileId === fileId && t.status === 'uploading');
          if (failedTransfer) {
            addHistoryItem({
              eventId: `failed-${fileId}`,
              deviceId: failedTransfer.sourceDeviceId || transfer.sourceDeviceId,
              fileId,
              name: transfer.name,
              size: transfer.size,
              mimeType: transfer.mimeType,
              createdAt: new Date(),
              status: 'failed' as const,
              failReason: 'Transfer timed out',
            });
          }
          return prev.filter(t => t.fileId !== fileId);
        });
        toast(`Transfer timed out — sender may have disconnected`, 'error');
      }
      chunkTimeoutTimers.current.delete(fileId);
    }, 60_000);

    chunkTimeoutTimers.current.set(fileId, timer);
  }, []);

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

        // Load any incomplete receiving transfers to show in UI
        const incompleteTransfers = await getReceivingTransfers();
        if (incompleteTransfers.length > 0) {
          logger.info('Resuming incomplete transfers', { count: incompleteTransfers.length });
          const resumedTransfers: FileTransfer[] = incompleteTransfers.map((t) => ({
            fileId: t.fileId,
            name: t.name,
            size: t.size,
            progress: getTransferProgress(t),
            status: 'uploading' as const,
            direction: 'receiving' as const,
            sourceDeviceId: t.sourceDeviceId,
          }));
          setTransfers((prev) => [...prev, ...resumedTransfers]);

          // Start chunk timeouts for resumed transfers — if sender is gone,
          // these will fail after 60s instead of sitting forever
          for (const t of incompleteTransfers) {
            resetChunkTimeout(t.fileId);
          }
        }

        // Mark incomplete uploads as failed (sender side) — after page refresh
        // the original File reference is gone so we can't resume
        const incompleteUploads = await getIncompleteUploads();
        for (const upload of incompleteUploads) {
          await markUploadFailed(upload.fileId, 'Upload interrupted — page was refreshed');
        }

      } catch (error) {
        logger.error('Failed to initialize transfer tracker', error);
      }
    }

    if (cryptoInitialized) {
      initTransferTracker();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cryptoInitialized, resetChunkTimeout]);

  // Resume incomplete uploads when reconnecting (sender side)
  useEffect(() => {
    async function resumeIncompleteUploads() {
      if (!isConnected) return;

      try {
        const incompleteUploads = await getIncompleteUploads();
        if (incompleteUploads.length === 0) return;

        logger.info('Found incomplete uploads to resume', { count: incompleteUploads.length });

        for (const upload of incompleteUploads) {
          // Determine which chunks still need to be sent
          const unsentChunks = getUnsentChunks(upload);

          if (unsentChunks.length === 0) {
            logger.debug('Upload has no unsent chunks, skipping', { fileId: upload.fileId });
            continue;
          }

          logger.info('Resuming upload', {
            fileId: upload.fileId,
            name: upload.name,
            unsentCount: unsentChunks.length,
            totalChunks: upload.totalChunks,
          });

          // Create a fake upload object for resumption
          const { importAESKey } = await import('@/lib/crypto/keys');
          const { uploadFileChunk } = await import('@/lib/features/files');
          const { markChunkSent } = await import('@/lib/features/file-upload-tracker');

          const encryptionKeyBytes = Uint8Array.from(atob(upload.encryptionKeyBase64), c => c.charCodeAt(0));
          const fileEncryptionKey = await importAESKey(encryptionKeyBytes);

          const fakeUpload = {
            fileId: upload.fileId,
            name: upload.name,
            size: upload.size,
            mimeType: upload.mimeType,
            totalChunks: upload.totalChunks,
            encryptionKey: fileEncryptionKey,
            uploadedChunks: new Set(upload.sentChunks),
          };

          // Resend each unsent chunk
          for (const chunkIndex of unsentChunks) {
            try {
              const { getUploadChunk } = await import('@/lib/features/file-upload-tracker');
              const chunkRecord = await getUploadChunk(upload.fileId, chunkIndex);

              if (!chunkRecord) {
                logger.warn('Chunk data missing for resume', { fileId: upload.fileId, chunkIndex });
                continue;
              }

              await uploadFileChunk(fakeUpload, chunkIndex, chunkRecord.data);
              await markChunkSent(upload.fileId, chunkIndex);

              logger.debug('Resumed chunk upload', { fileId: upload.fileId, chunkIndex });
            } catch (error) {
              logger.error('Failed to resume chunk', error, { fileId: upload.fileId, chunkIndex });
            }
          }

          // Show progress in UI
          const progress = (upload.sentChunks.length / upload.totalChunks) * 100;
          setTransfers(prev => [...prev, {
            fileId: upload.fileId,
            name: upload.name,
            size: upload.size,
            progress,
            status: 'uploading',
            direction: 'sending',
          }]);

          toast(`Resuming upload: ${upload.name}`, 'info');
        }
      } catch (error) {
        logger.error('Failed to resume incomplete uploads', error);
      }
    }

    if (isConnected && cryptoInitialized) {
      resumeIncompleteUploads();
    }
  }, [isConnected, cryptoInitialized]);

  // Send resume requests when WebSocket connects and there are incomplete transfers (receiver side)
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

  // Fetch file history on mount (includes failed transfers from IndexedDB)
  useEffect(() => {
    async function loadHistory() {
      if (!identityKeyPair?.publicKeyHex) return;

      setHistoryLoading(true);
      try {
        const { files } = await fetchFileHistory(identityKeyPair.publicKeyHex);

        // Load failed receiving transfers from IndexedDB
        const failedTransfers = await getFailedTransfers();
        const failedReceiveItems: FileHistoryItem[] = failedTransfers.map((t) => ({
          eventId: `failed-recv-${t.fileId}`,
          deviceId: t.sourceDeviceId,
          fileId: t.fileId,
          name: t.name,
          size: t.size,
          mimeType: t.mimeType,
          createdAt: new Date(t.updatedAt),
          status: 'failed' as const,
          failReason: t.failReason || 'Transfer failed',
        }));

        // Load failed uploads (sender side) from IndexedDB
        const failedUploads = await getFailedUploads();
        const failedUploadItems: FileHistoryItem[] = failedUploads.map((u) => ({
          eventId: `failed-send-${u.fileId}`,
          deviceId: deviceId,
          fileId: u.fileId,
          name: u.name,
          size: u.size,
          mimeType: u.mimeType,
          createdAt: new Date(u.updatedAt),
          status: 'failed' as const,
          failReason: u.failReason || 'Upload failed',
        }));

        // Merge and sort by date (newest first)
        const allHistory = dedupeHistory([...files, ...failedReceiveItems, ...failedUploadItems]).sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
        );
        setFileHistory(allHistory);
      } catch (error) {
        logger.error('Failed to load file history', error);
      } finally {
        setHistoryLoading(false);
      }
    }

    if (cryptoInitialized && identityKeyPair) {
      loadHistory();
    }
  }, [cryptoInitialized, identityKeyPair, dedupeHistory, deviceId]);

  // Handle incoming file events (skip self-originated events)
  useEffect(() => {
    if (!sessionKeys) return;

    const unsubscribe = eventRouter.subscribe(
      (event) => event.type.startsWith('file:') || event.type === 'webrtc:signal',
      (event) => {
        // DEBUG: Log all incoming events for tracing (only file events to reduce noise)
        if (event.type.startsWith('file:')) {
          console.log('[FILES PAGE] Received FILE event:', {
            type: event.type,
            eventId: event.event_id,
            deviceId: event.device_id,
            isOwnDevice: event.device_id === deviceId,
            hasSessionKeys: !!sessionKeys,
          });
        }

        // Skip events from this device to avoid processing our own uploads
        if (event.device_id === deviceId) {
          console.log('[FILES PAGE] Skipping own device event');
          return;
        }

        if (event.type === 'file:metadata') {
          console.log('[FILES PAGE] Processing file:metadata event');
          handleIncomingFileMetadata(event);
          setSyncStatus('synced');
          toast('File received from another device', 'success');
        } else if (event.type === 'file:chunk') {
          console.log('[FILES PAGE] Processing file:chunk event');
          handleIncomingFileChunk(event);
        } else if (event.type === 'file:chunk_ack') {
          console.log('[FILES PAGE] Processing file:chunk_ack event');
          handleChunkAck(event);
        } else if (event.type === 'file:resume_request') {
          console.log('[FILES PAGE] Processing file:resume_request event');
          handleResumeRequest(event);
        } else if (event.type === 'webrtc:signal') {
          console.log('[FILES PAGE] Processing webrtc:signal event');
          handleWebRTCSignal(event);
        }
      }
    );

    return unsubscribe;
  }, [sessionKeys, deviceId, handleIncomingFileMetadata, handleIncomingFileChunk, handleChunkAck, handleResumeRequest, handleWebRTCSignal]);

  // Process file events that arrived before this page was mounted.
  // The WebSocket client buffers file events, and we consume them here on mount.
  useEffect(() => {
    if (!sessionKeys) return;

    try {
      const client = getWebSocketClient(WS_URL, deviceId);
      const bufferedEvents = client.consumeBufferedFileEvents();

      if (bufferedEvents.length > 0) {
        console.log('[FILES PAGE] Processing', bufferedEvents.length, 'buffered file events from before mount');

        for (const event of bufferedEvents) {
          if (event.device_id === deviceId) continue;

          if (event.type === 'file:metadata') {
            console.log('[FILES PAGE] Processing buffered file:metadata event');
            handleIncomingFileMetadata(event);
            setSyncStatus('synced');
          } else if (event.type === 'file:chunk') {
            console.log('[FILES PAGE] Processing buffered file:chunk event');
            handleIncomingFileChunk(event);
          } else if (event.type === 'file:chunk_ack') {
            handleChunkAck(event);
          } else if (event.type === 'file:resume_request') {
            handleResumeRequest(event);
          }
        }
      }
    } catch (err) {
      // Client may not exist yet if connection hasn't been established
      console.debug('[FILES PAGE] Could not consume buffered events:', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKeys, deviceId]);

  // Subscribe to WebRTC transfer events for UI progress
  useEffect(() => {
    const updateTransfer = (wt: WebRTCFileTransfer) => {
      setTransfers((prev) => {
        const exists = prev.find((t) => t.fileId === wt.fileId);
        if (!exists) return prev;
        return prev.map((t) =>
          t.fileId === wt.fileId
            ? {
                ...t,
                progress: wt.progress,
                speed: wt.speed,
                status: wt.status === 'complete' ? 'completed' : wt.status === 'failed' ? 'error' : 'uploading',
              }
            : t
        );
      });
    };

    const handleIncoming = (wt: WebRTCFileTransfer) => {
      // Add receiving transfer to UI
      setTransfers((prev) => {
        if (prev.find((t) => t.fileId === wt.fileId)) return prev;
        return [
          ...prev,
          {
            fileId: wt.fileId,
            name: wt.fileName,
            size: wt.fileSize,
            progress: 0,
            status: 'uploading' as const,
            direction: 'receiving' as const,
            startTime: wt.startTime,
            speed: 0,
          },
        ];
      });
      toast(`Receiving ${wt.fileName} via P2P...`, 'info');
    };

    const handleComplete = (wt: WebRTCFileTransfer) => {
      updateTransfer(wt);
      const direction = wt.senderId === deviceId ? 'sent' : 'received';
      toast(`${wt.fileName} ${direction} successfully via P2P!`, 'success');
      setSyncStatus('synced');
    };

    const handleFailed = (wt: WebRTCFileTransfer) => {
      updateTransfer(wt);
      setSyncStatus('error');
    };

    const unsubs = [
      onTransferEvent('progress', updateTransfer),
      onTransferEvent('incoming', handleIncoming),
      onTransferEvent('complete', handleComplete),
      onTransferEvent('failed', handleFailed),
    ];

    return () => unsubs.forEach((fn) => fn());
  }, [deviceId]);

  // Detect when sender device goes offline and mark active receiving transfers as failed
  useEffect(() => {
    if (!lastSystemMessage) return;
    if (lastSystemMessage.type !== 'device_status_changed') return;

    const { device_id: offlineDeviceId, is_online } = lastSystemMessage;
    if (is_online) return; // Only care about devices going offline

    // Find active receiving transfers from this device and move them to history as failed
    setTransfers(prev => {
      const failed = prev.filter(
        t => t.direction === 'receiving' && t.status === 'uploading' && t.sourceDeviceId === offlineDeviceId
      );
      const remaining = prev.filter(t => !failed.includes(t));

      for (const t of failed) {
        markTransferFailed(t.fileId, 'Sender device went offline').catch(err =>
          logger.error('Failed to mark transfer as failed', err)
        );
        // Add to file history
        addHistoryItem({
          eventId: `failed-${t.fileId}`,
          deviceId: t.sourceDeviceId || offlineDeviceId,
          fileId: t.fileId,
          name: t.name,
          size: t.size,
          mimeType: '',
          createdAt: new Date(),
          status: 'failed' as const,
          failReason: 'Sender went offline',
        });
        toast(`Transfer of "${t.name}" failed — sender went offline`, 'error');
      }

      return remaining;
    });
  }, [lastSystemMessage, addHistoryItem]);

  // Clean up all timeout timers on unmount
  useEffect(() => {
    return () => {
      chunkTimeoutTimers.current.forEach(timer => clearTimeout(timer));
      chunkTimeoutTimers.current.clear();
    };
  }, []);

  // Track processed signal event IDs to ignore retransmissions from gap recovery
  const processedSignalIds = new Set<string>();

  // Handle incoming WebRTC signaling events
  async function handleWebRTCSignal(event: any) {
    // Deduplicate: skip events we've already processed (e.g. gap recovery retransmissions)
    if (event.event_id && processedSignalIds.has(event.event_id)) {
      console.log('[WebRTC] Ignoring duplicate signal event:', event.event_id);
      return;
    }
    if (event.event_id) {
      processedSignalIds.add(event.event_id);
      // Cap the set size to prevent unbounded growth
      if (processedSignalIds.size > 200) {
        const first = processedSignalIds.values().next().value;
        if (first !== undefined) processedSignalIds.delete(first);
      }
    }

    try {
      const { decryptPayload } = await import('@/lib/crypto/encryption');
      const { getSharedEncryptionKey } = await import('@/lib/crypto/shared-key');

      const sharedKey = await getSharedEncryptionKey();
      if (!sharedKey) {
        logger.error('[WebRTC] No shared key for signal decryption');
        return;
      }

      const payload = await decryptPayload(event.encrypted_payload, sharedKey) as {
        file_id: string;
        target_device: string;
        signal: any;
      };

      const signal = payload.signal;
      const fileId = payload.file_id;

      if (signal.type === 'offer') {
        // Skip if this transfer already exists in IndexedDB (replayed event after refresh)
        const existingTransfer = await getTransfer(fileId);
        if (existingTransfer) {
          console.log('[WebRTC] Skipping replayed offer — transfer already tracked', { fileId, status: existingTransfer.status });
          return;
        }
        console.log('[WebRTC] Received offer for', signal.fileName);
        await handleWebRTCOffer(fileId, event.device_id, { type: 'offer', sdp: signal.sdp }, {
          fileName: signal.fileName,
          fileSize: signal.fileSize,
          mimeType: signal.mimeType,
          totalChunks: signal.totalChunks,
        });
      } else if (signal.type === 'answer') {
        console.log('[WebRTC] Received answer for', fileId);
        await handleWebRTCAnswer(fileId, { type: 'answer', sdp: signal.sdp });
      } else if (signal.type === 'ice-candidate') {
        await handleICECandidate(fileId, signal.candidate);
      }
    } catch (error) {
      logger.error('[WebRTC] Failed to handle signal:', error);
    }
  }

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

      // Use WebRTC P2P for large files (>100MB), relay for small files
      if (shouldUseWebRTC(file.size)) {
        // WebRTC P2P path — file data goes direct, only signaling through server
        const startTime = Date.now();
        const fileId = crypto.randomUUID();

        const transfer: FileTransfer = {
          fileId,
          name: file.name,
          size: file.size,
          progress: 0,
          status: 'uploading',
          direction: 'sending',
          startTime,
          speed: 0,
        };
        setTransfers((prev) => [...prev, transfer]);
        toast(`Sending ${file.name} via P2P (${(file.size / 1024 / 1024).toFixed(0)}MB)...`, 'info');

        try {
          await sendFileViaWebRTC(file, '*', (progress) => {
            const elapsed = (Date.now() - startTime) / 1000;
            const bytesTransferred = (progress / 100) * file.size;
            const speed = elapsed > 0 ? bytesTransferred / elapsed : 0;

            setTransfers((prev) =>
              prev.map((t) =>
                t.fileId === fileId
                  ? { ...t, progress, speed, status: progress === 100 ? 'completed' : 'uploading' }
                  : t
              )
            );
          });
          setSyncStatus('synced');
        } catch (webrtcError) {
          // WebRTC failed — fall back to relay
          logger.warn('[FILES] WebRTC failed, falling back to relay', {
            error: webrtcError instanceof Error ? webrtcError.message : String(webrtcError),
          });
          toast('P2P connection failed, using server relay instead...', 'info');

          // Remove the WebRTC transfer entry
          setTransfers((prev) => prev.filter((t) => t.fileId !== fileId));

          // Fall through to relay path below
          await uploadViaRelay(file);
        }
      } else {
        // Relay path — small files go through server
        await uploadViaRelay(file);
      }

      setSyncStatus('synced');
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

  async function uploadViaRelay(file: File) {
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
    toast(`Sending ${file.name} via relay...`, 'info');

    await uploadFileInChunks(file, upload, (progress) => {
      const elapsed = (Date.now() - startTime) / 1000;
      const bytesTransferred = (progress / 100) * file.size;
      const speed = elapsed > 0 ? bytesTransferred / elapsed : 0;

      setTransfers((prev) =>
        prev.map((t) =>
          t.fileId === upload.fileId
            ? { ...t, progress, speed, status: 'uploading' }
            : t
        )
      );
    });

    toast(`${file.name} sent — waiting for confirmation...`, 'info');
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
        // Skip if this transfer already exists in IndexedDB (replayed event after refresh).
        // Re-calling startTracking would overwrite receivedChunks to 0 and break progress.
        const existingTransfer = await getTransfer(metadata.file_id);
        if (existingTransfer) {
          console.log('[FILES PAGE] Skipping replayed file:metadata — transfer already tracked', {
            fileId: metadata.file_id,
            status: existingTransfer.status,
          });
          return;
        }

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
          sourceDeviceId: event.device_id,
        };
        setTransfers(prev => {
          // Avoid duplicates (might already exist from resumed transfers)
          if (prev.some(t => t.fileId === metadata.file_id)) return prev;
          return [...prev, transfer];
        });

        // Start chunk-arrival timeout (60s to receive first chunk)
        resetChunkTimeout(metadata.file_id);

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

      // Skip chunks for already-completed or failed transfers (replayed events after refresh)
      const transferRecord = await getTransfer(fileId);
      if (transferRecord && (transferRecord.status === 'complete' || transferRecord.status === 'failed')) {
        return;
      }

      // Check if we have metadata (either cached or in tracker)
      let metadata = metadataCache.current.get(fileId);
      if (!metadata) {
        // Try to get from tracker
        const transfer = transferRecord;
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

      // Determine if sender used per-file encryption (web) or shared-key only (mobile)
      const hasPerFileKey = !!metadata.encryption_key && metadata.encryption_key.length > 0;

      let chunk: { chunkIndex: number; data: Uint8Array; hash: string } | null = null;

      if (hasPerFileKey) {
        // Per-file encryption (web sender): chunk data is double-encrypted
        const { importAESKey } = await import('@/lib/crypto/keys');
        const encryptionKeyBytes = Uint8Array.from(atob(metadata.encryption_key), c => c.charCodeAt(0));
        const fileEncryptionKey = await importAESKey(encryptionKeyBytes);
        chunk = await receiveFileChunk(event, fileEncryptionKey, fileId);
      } else {
        // No per-file encryption (mobile sender): payload.data is raw base64
        const dataBytes = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));

        // Verify hash integrity
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBytes);
        const hashArray = new Uint8Array(hashBuffer);
        const computedHash = Array.from(hashArray)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        if (computedHash !== payload.hash) {
          logger.error('Chunk integrity check failed', { fileId, chunkIndex: payload.chunk_index });
          return;
        }

        chunk = {
          chunkIndex: payload.chunk_index,
          data: dataBytes,
          hash: payload.hash,
        };
      }

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
          // Transfer is complete — clear the timeout and reassemble
          const existingTimer = chunkTimeoutTimers.current.get(fileId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            chunkTimeoutTimers.current.delete(fileId);
          }
          await handleTransferComplete(fileId, metadata);
        } else if (transfer) {
          // Reset chunk-arrival timeout (another 60s to get next chunk)
          resetChunkTimeout(fileId);
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

      // Move from active transfers to history
      setTransfers(prev => prev.filter(t => t.fileId !== fileId));
      addHistoryItem({
        eventId: `completed-recv-${fileId}`,
        deviceId: metadata.device_id || '',
        fileId,
        name: metadata.name,
        size: metadata.size || 0,
        mimeType: metadata.mime_type || '',
        createdAt: new Date(),
        status: 'completed' as const,
      });

      // Send file:complete event to notify sender
      await sendFileCompleteEvent(fileId, metadata.name);

      // Delete chunks to free space but keep the transfer record as 'complete'
      // so that event replay on page refresh won't restart the transfer
      await deleteTransferChunks(fileId);
      metadataCache.current.delete(fileId);

      // Optionally prune processed set if it grows too large
      if (processedRef.size > 1000) {
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
          // Move from active transfers to history
          setTransfers(prev => prev.filter(t => t.fileId !== fileId));
          addHistoryItem({
            eventId: `completed-send-${fileId}`,
            deviceId: deviceId,
            fileId,
            name: upload.name,
            size: upload.size,
            mimeType: upload.mimeType,
            createdAt: new Date(),
            status: 'completed' as const,
          });
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

  function getStatusConfig(status: string, direction: string) {
    switch (status) {
      case 'completed':
        return { icon: CheckCircle2, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/40', label: direction === 'sending' ? 'Sent' : 'Received' };
      case 'error':
        return { icon: XCircle, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-950/40', label: 'Failed' };
      case 'uploading':
        return direction === 'sending'
          ? { icon: ArrowUpCircle, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/40', label: 'Sending...' }
          : { icon: ArrowDownCircle, color: 'text-violet-500', bg: 'bg-violet-50 dark:bg-violet-950/40', label: 'Receiving...' };
      default:
        return { icon: FileIcon, color: 'text-muted-foreground', bg: 'bg-muted', label: 'Pending' };
    }
  }

  if (!cryptoInitialized) {
    return (
      <MainLayout>
        <div className="flex h-full items-center justify-center">
          <div className="text-center space-y-3 animate-in fade-in duration-500">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-950/40 animate-pulse">
              <FolderOpen className="h-8 w-8 text-blue-500" />
            </div>
            <p className="text-sm text-muted-foreground">Initializing encryption...</p>
          </div>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
    <div className="flex h-full flex-col">
      {/* Gradient Header */}
      <div className="border-b border-border bg-linear-to-b from-blue-50/60 to-card dark:from-blue-950/20 dark:to-card animate-in fade-in duration-400">
        <div className="flex items-end justify-between px-6 py-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Files</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {transfers.length + fileHistory.length} transfer{transfers.length + fileHistory.length !== 1 ? 's' : ''}
              {isConnected ? ' · Secure' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
              isConnected
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                : 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400'
            )}>
              <ShieldCheck className="h-3 w-3" />
              {isConnected ? 'Encrypted' : 'Offline'}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-6">
          {/* Upload Area */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '100ms', animationFillMode: 'backwards' }}>
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
              className="rounded-2xl border-2 border-dashed border-border bg-linear-to-br from-blue-50/30 to-violet-50/30 dark:from-blue-950/10 dark:to-violet-950/10 p-10 text-center transition-colors hover:border-primary/50 hover:from-blue-50/60 hover:to-violet-50/60 dark:hover:from-blue-950/20 dark:hover:to-violet-950/20 cursor-pointer"
            >
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-linear-to-br from-[#007AFF] to-[#5856D6]">
                <Upload className="h-6 w-6 text-white" />
              </div>
              <p className="mt-4 text-sm font-semibold text-foreground">Send a File</p>
              <p className="mt-1 text-xs text-muted-foreground">Drag and drop or click to browse (max {(MAX_FILE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB)</p>
              <Button
                className="mt-4 rounded-xl"
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
          </div>

          {/* Active Transfers */}
          {transfers.length > 0 && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '200ms', animationFillMode: 'backwards' }}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Active Transfers</h2>
              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                {dedupedTransfers.map((transfer, idx) => {
                  const cfg = getStatusConfig(transfer.status, transfer.direction);
                  const StatusIcon = cfg.icon;
                  return (
                    <div key={transfer.fileId}>
                      {idx > 0 && <div className="mx-4 h-px bg-border" />}
                      <div className="flex items-center gap-3.5 px-4 py-3">
                        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', cfg.bg)}>
                          <StatusIcon className={cn('h-5 w-5', cfg.color)} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">{transfer.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(transfer.size)}
                            {transfer.speed ? ` · ${formatSpeed(transfer.speed)}` : ''}
                          </p>
                          {transfer.status === 'uploading' && (
                            <div className="mt-1.5 space-y-0.5">
                              <Progress value={transfer.progress} className="h-1.5" />
                              <p className="text-[10px] text-muted-foreground text-right">{Math.round(transfer.progress)}%</p>
                            </div>
                          )}
                          {transfer.status === 'error' && transfer.failReason && (
                            <p className="mt-0.5 text-xs text-red-500">{transfer.failReason}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={cn('text-xs font-medium', cfg.color)}>{cfg.label}</span>
                          {transfer.status === 'error' && (
                            <button
                              className="ml-1 rounded-full p-1 hover:bg-muted"
                              onClick={async () => {
                                await deleteTransfer(transfer.fileId);
                                setTransfers(prev => prev.filter(t => t.fileId !== transfer.fileId));
                              }}
                            >
                              <X className="h-3.5 w-3.5 text-muted-foreground" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* File History */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '300ms', animationFillMode: 'backwards' }}>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transfer History</h2>
            {historyLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3.5 rounded-2xl border border-border bg-card px-4 py-3">
                    <div className="h-10 w-10 rounded-xl bg-muted animate-shimmer" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3.5 w-2/3 rounded bg-muted animate-shimmer" />
                      <div className="h-3 w-1/3 rounded bg-muted animate-shimmer" />
                    </div>
                  </div>
                ))}
              </div>
            ) : dedupedHistory.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border p-10 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted/50">
                  <FolderOpen className="h-8 w-8 text-muted-foreground/50" />
                </div>
                <p className="mt-4 text-sm font-medium text-muted-foreground">No file transfers</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Send files securely to your paired devices
                </p>
              </div>
            ) : (
              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                {dedupedHistory.map((file, idx) => {
                  const isFailed = file.status === 'failed';
                  const isSent = file.deviceId === deviceId;
                  return (
                    <div key={file.eventId}>
                      {idx > 0 && <div className="mx-4 h-px bg-border" />}
                      <div className="flex items-center gap-3.5 px-4 py-3">
                        <div className={cn(
                          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                          isFailed
                            ? 'bg-red-50 dark:bg-red-950/40'
                            : isSent
                              ? 'bg-blue-50 dark:bg-blue-950/40'
                              : 'bg-emerald-50 dark:bg-emerald-950/40'
                        )}>
                          {isFailed ? (
                            <XCircle className="h-5 w-5 text-red-500" />
                          ) : isSent ? (
                            <ArrowUpCircle className="h-5 w-5 text-blue-500" />
                          ) : (
                            <ArrowDownCircle className="h-5 w-5 text-emerald-500" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(file.size)} · {file.createdAt.toLocaleDateString()} {file.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                          {isFailed && file.failReason && (
                            <p className="mt-0.5 text-xs text-red-500">{file.failReason}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {isFailed ? (
                            <>
                              <span className="text-xs font-medium text-red-500">Failed</span>
                              <button
                                className="ml-1 rounded-full p-1 hover:bg-muted"
                                onClick={async () => {
                                  if (file.eventId.startsWith('failed-send-')) {
                                    await deleteUpload(file.fileId);
                                  } else {
                                    await deleteTransfer(file.fileId);
                                  }
                                  setFileHistory(prev => prev.filter(f => f.eventId !== file.eventId));
                                }}
                              >
                                <X className="h-3.5 w-3.5 text-muted-foreground" />
                              </button>
                            </>
                          ) : (
                            <span className={cn(
                              'text-xs font-medium',
                              isSent ? 'text-blue-500' : 'text-emerald-500'
                            )}>
                              {isSent ? 'Sent' : 'Received'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    </MainLayout>
  );
}
