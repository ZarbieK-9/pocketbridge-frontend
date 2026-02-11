/**
 * WebRTC Direct P2P File Transfer
 *
 * Bypasses the server/Redis for large file transfers (>100MB)
 * - Uses WebRTC data channels for direct peer-to-peer transfer
 * - WebSocket only used for signaling (offer/answer/ICE)
 * - No file data touches the server/Redis
 * - Chunks stored in IndexedDB (not memory) to support huge files
 * - Emits events for UI progress tracking
 */

import { createEvent } from '@/lib/sync/event-builder';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getWebSocketClient } from '@/lib/ws';
import {
  startTracking,
  storeChunk,
  getChunks,
  deleteTransfer,
  getTransferProgress,
} from '@/lib/features/file-transfer-tracker';
import type { EncryptedEvent } from '@/types';

const WEBRTC_STREAM_ID = 'webrtc:signaling';
const CHUNK_SIZE = 64 * 1024; // 64KB chunks for WebRTC data channel
const MAX_BUFFER_SIZE = 256 * 1024; // 256KB buffer before backpressure (well below browser's ~16MB hard limit)
const CONNECTION_TIMEOUT_MS = 30_000; // 30s to establish connection

export interface WebRTCFileTransfer {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  senderId: string;
  receiverId: string;
  status: 'pending' | 'connecting' | 'transferring' | 'complete' | 'failed';
  progress: number; // 0-100
  bytesTransferred: number;
  startTime: number;
  speed: number; // bytes/sec
  peerConnection?: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
}

// Active transfers
const activeTransfers = new Map<string, WebRTCFileTransfer>();

// ICE candidate queue — candidates that arrive before setRemoteDescription
const pendingICECandidates = new Map<string, RTCIceCandidateInit[]>();

// Event listeners for UI integration
type TransferEventType = 'progress' | 'incoming' | 'complete' | 'failed';
type TransferEventHandler = (transfer: WebRTCFileTransfer) => void;
const transferListeners = new Map<TransferEventType, Set<TransferEventHandler>>();

/**
 * Subscribe to WebRTC transfer events
 * Returns unsubscribe function
 */
export function onTransferEvent(
  eventType: TransferEventType,
  handler: TransferEventHandler,
): () => void {
  if (!transferListeners.has(eventType)) {
    transferListeners.set(eventType, new Set());
  }
  transferListeners.get(eventType)!.add(handler);
  return () => {
    transferListeners.get(eventType)?.delete(handler);
  };
}

function emitTransferEvent(eventType: TransferEventType, transfer: WebRTCFileTransfer) {
  transferListeners.get(eventType)?.forEach(handler => {
    try {
      handler(transfer);
    } catch (err) {
      console.error('[WebRTC] Transfer event handler error:', err);
    }
  });
}

/**
 * Get all active WebRTC transfers (for UI)
 */
export function getActiveWebRTCTransfers(): WebRTCFileTransfer[] {
  return Array.from(activeTransfers.values());
}

/**
 * Send file via WebRTC P2P
 * Returns a promise that resolves with the fileId when the connection is established
 * and rejects if connection fails (caller should fall back to relay)
 */
export async function sendFileViaWebRTC(
  file: File,
  targetDeviceId: string,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const fileId = crypto.randomUUID();
  const deviceId = getOrCreateDeviceId();

  const transfer: WebRTCFileTransfer = {
    fileId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    senderId: deviceId,
    receiverId: targetDeviceId,
    status: 'connecting',
    progress: 0,
    bytesTransferred: 0,
    startTime: Date.now(),
    speed: 0,
  };

  activeTransfers.set(fileId, transfer);

  return new Promise<string>(async (resolve, reject) => {
    let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    try {
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });

      transfer.peerConnection = peerConnection;

      // Connection timeout — if data channel doesn't open in time, reject
      connectionTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          transfer.status = 'failed';
          peerConnection.close();
          activeTransfers.delete(fileId);
          emitTransferEvent('failed', transfer);
          reject(new Error('WebRTC connection timed out'));
        }
      }, CONNECTION_TIMEOUT_MS);

      // Create data channel
      const dataChannel = peerConnection.createDataChannel('fileTransfer', {
        ordered: true,
      });
      dataChannel.binaryType = 'arraybuffer';
      transfer.dataChannel = dataChannel;

      dataChannel.onopen = async () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        if (resolved) return;
        resolved = true;

        console.log('[WebRTC] Data channel opened, starting transfer');
        transfer.status = 'transferring';
        emitTransferEvent('progress', transfer);

        // Resolve immediately so caller knows connection succeeded
        resolve(fileId);

        // Start sending file data
        try {
          await transferFile(file, dataChannel, transfer, onProgress);
        } catch (err) {
          console.error('[WebRTC] Transfer failed:', err);
          transfer.status = 'failed';
          emitTransferEvent('failed', transfer);
        }
      };

      dataChannel.onerror = (error) => {
        console.error('[WebRTC] Data channel error:', error);
        if (!resolved) {
          resolved = true;
          if (connectionTimeout) clearTimeout(connectionTimeout);
          transfer.status = 'failed';
          emitTransferEvent('failed', transfer);
          reject(new Error('WebRTC data channel error'));
        }
      };

      // Handle ICE candidates
      peerConnection.onicecandidate = async (event) => {
        if (event.candidate) {
          await sendSignalingMessage(fileId, targetDeviceId, {
            type: 'ice-candidate',
            candidate: event.candidate.toJSON(),
          });
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'failed') {
          if (!resolved) {
            resolved = true;
            if (connectionTimeout) clearTimeout(connectionTimeout);
            transfer.status = 'failed';
            emitTransferEvent('failed', transfer);
            reject(new Error('WebRTC connection failed'));
          }
        }
      };

      // Create and send offer
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      // Calculate total chunks for receiver tracking
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      await sendSignalingMessage(fileId, targetDeviceId, {
        type: 'offer',
        sdp: offer.sdp!,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks,
      });

      console.log(`[WebRTC] Offer sent for ${file.name} (${totalChunks} chunks), waiting for answer...`);
    } catch (error) {
      if (connectionTimeout) clearTimeout(connectionTimeout);
      if (!resolved) {
        resolved = true;
        transfer.status = 'failed';
        activeTransfers.delete(fileId);
        emitTransferEvent('failed', transfer);
        reject(error);
      }
    }
  });
}

/**
 * Transfer file through data channel
 * Uses bufferedAmountLowThreshold event for proper backpressure
 * instead of polling, which prevents send queue overflow.
 */
async function transferFile(
  file: File,
  dataChannel: RTCDataChannel,
  transfer: WebRTCFileTransfer,
  onProgress?: (progress: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let offset = 0;
    let paused = false;

    // Use the browser's built-in backpressure event
    dataChannel.bufferedAmountLowThreshold = MAX_BUFFER_SIZE / 2;

    dataChannel.onbufferedamountlow = () => {
      if (paused) {
        paused = false;
        sendChunk();
      }
    };

    const sendChunk = () => {
      while (offset < file.size) {
        // Backpressure: pause and wait for onbufferedamountlow event
        if (dataChannel.bufferedAmount > MAX_BUFFER_SIZE) {
          paused = true;
          return; // onbufferedamountlow will resume
        }

        const end = Math.min(offset + CHUNK_SIZE, file.size);
        // Read chunk synchronously from the File slice
        // We need to go async for arrayBuffer(), so break the loop
        const chunk = file.slice(offset, end);
        chunk.arrayBuffer().then((data) => {
          try {
            dataChannel.send(data);
            offset += data.byteLength;
            transfer.bytesTransferred = offset;
            transfer.progress = Math.round((offset / file.size) * 100);

            const elapsed = (Date.now() - transfer.startTime) / 1000;
            transfer.speed = elapsed > 0 ? offset / elapsed : 0;

            if (onProgress) onProgress(transfer.progress);
            emitTransferEvent('progress', transfer);

            // Continue sending (next iteration will check buffer)
            sendChunk();
          } catch (error) {
            transfer.status = 'failed';
            emitTransferEvent('failed', transfer);
            reject(error);
          }
        }).catch((err) => {
          transfer.status = 'failed';
          emitTransferEvent('failed', transfer);
          reject(err);
        });

        // Exit the while loop — the .then() callback will continue
        return;
      }

      // All chunks fed to buffer — wait for buffer to drain before sending EOF
      const waitForDrain = () => {
        if (dataChannel.bufferedAmount > 0) {
          transfer.progress = 99;
          emitTransferEvent('progress', transfer);
          setTimeout(waitForDrain, 100);
          return;
        }

        try {
          dataChannel.send(new TextEncoder().encode('__EOF__'));
          transfer.status = 'complete';
          transfer.progress = 100;
          const duration = (Date.now() - transfer.startTime) / 1000;
          transfer.speed = file.size / duration;
          console.log(`[WebRTC] Transfer complete: ${file.name} (${(transfer.speed / 1024 / 1024).toFixed(2)} MB/s)`);
          emitTransferEvent('complete', transfer);
          if (onProgress) onProgress(100);
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      waitForDrain();
    };

    sendChunk();
  });
}

/**
 * Handle incoming WebRTC offer (receiver side)
 * Stores chunks in IndexedDB instead of memory to support huge files
 */
export async function handleWebRTCOffer(
  fileId: string,
  senderId: string,
  offer: RTCSessionDescriptionInit,
  metadata: { fileName: string; fileSize: number; mimeType: string; totalChunks: number },
): Promise<void> {
  // Guard against duplicate offers (e.g. from gap recovery retransmission)
  const existing = activeTransfers.get(fileId);
  if (existing?.peerConnection) {
    console.warn('[WebRTC] Ignoring duplicate offer for fileId:', fileId);
    return;
  }

  const deviceId = getOrCreateDeviceId();

  const transfer: WebRTCFileTransfer = {
    fileId,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
    senderId,
    receiverId: deviceId,
    status: 'connecting',
    progress: 0,
    bytesTransferred: 0,
    startTime: Date.now(),
    speed: 0,
  };

  activeTransfers.set(fileId, transfer);
  emitTransferEvent('incoming', transfer);

  // Start tracking in IndexedDB (same system as relay path)
  await startTracking(fileId, {
    name: metadata.fileName,
    size: metadata.fileSize,
    mimeType: metadata.mimeType,
    totalChunks: metadata.totalChunks,
    encryptionKey: '', // No per-file encryption for WebRTC (DTLS handles it)
  }, senderId);

  const peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  });

  transfer.peerConnection = peerConnection;

  // Handle incoming data channel
  peerConnection.ondatachannel = (event) => {
    const dataChannel = event.channel;
    dataChannel.binaryType = 'arraybuffer';
    transfer.dataChannel = dataChannel;
    transfer.status = 'transferring';

    let receivedBytes = 0;
    let chunkIndex = 0;

    dataChannel.onmessage = async (msgEvent) => {
      const data = msgEvent.data as ArrayBuffer;
      const bytes = new Uint8Array(data);

      // Check for EOF marker
      if (bytes.length <= 7) {
        const text = new TextDecoder().decode(bytes);
        if (text === '__EOF__') {
          // Transfer complete — reassemble from IndexedDB and download
          transfer.status = 'complete';
          transfer.progress = 100;
          const duration = (Date.now() - transfer.startTime) / 1000;
          transfer.speed = metadata.fileSize / duration;
          console.log(`[WebRTC] Received file: ${metadata.fileName} (${(transfer.speed / 1024 / 1024).toFixed(2)} MB/s)`);
          emitTransferEvent('complete', transfer);

          // Reassemble from IndexedDB
          try {
            const storedChunks = await getChunks(fileId);
            const sorted = storedChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
            const blobParts = sorted.map(c => c.data as BlobPart);
            const blob = new Blob(blobParts, { type: metadata.mimeType || 'application/octet-stream' });
            downloadFile(blob, metadata.fileName);

            // Clean up
            await deleteTransfer(fileId);
          } catch (err) {
            console.error('[WebRTC] Failed to reassemble file:', err);
            transfer.status = 'failed';
            emitTransferEvent('failed', transfer);
          }

          // Clean up peer connection
          dataChannel.close();
          peerConnection.close();
          return;
        }
      }

      // Store chunk to IndexedDB (not memory!)
      try {
        // Compute simple hash for the chunk
        const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        await storeChunk(fileId, chunkIndex, bytes, hash);
        chunkIndex++;
        receivedBytes += data.byteLength;
        transfer.bytesTransferred = receivedBytes;
        transfer.progress = Math.round((receivedBytes / metadata.fileSize) * 100);

        const elapsed = (Date.now() - transfer.startTime) / 1000;
        transfer.speed = elapsed > 0 ? receivedBytes / elapsed : 0;

        emitTransferEvent('progress', transfer);
      } catch (err) {
        console.error('[WebRTC] Failed to store chunk:', err);
      }
    };

    dataChannel.onerror = (error) => {
      console.error('[WebRTC] Data channel error:', error);
      transfer.status = 'failed';
      emitTransferEvent('failed', transfer);
    };
  };

  // Handle ICE candidates
  peerConnection.onicecandidate = async (event) => {
    if (event.candidate) {
      await sendSignalingMessage(fileId, senderId, {
        type: 'ice-candidate',
        candidate: event.candidate.toJSON(),
      });
    }
  };

  // Set remote description and create answer
  await peerConnection.setRemoteDescription(offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  // Send answer via WebSocket signaling
  await sendSignalingMessage(fileId, senderId, {
    type: 'answer',
    sdp: answer.sdp!,
  });

  console.log('[WebRTC] Answer sent, waiting for data channel...');
}

/**
 * Handle WebRTC answer (sender side)
 */
export async function handleWebRTCAnswer(
  fileId: string,
  answer: RTCSessionDescriptionInit,
): Promise<void> {
  const transfer = activeTransfers.get(fileId);
  if (!transfer?.peerConnection) {
    console.error('[WebRTC] No active transfer found for answer');
    return;
  }

  // Guard against duplicate answers (e.g. from gap recovery retransmission)
  if (transfer.peerConnection.signalingState !== 'have-local-offer') {
    console.warn('[WebRTC] Ignoring duplicate answer, signalingState:', transfer.peerConnection.signalingState);
    return;
  }

  await transfer.peerConnection.setRemoteDescription(answer);
  console.log('[WebRTC] Answer received, connection established');

  // Flush any ICE candidates that arrived before the remote description was set
  const queued = pendingICECandidates.get(fileId);
  if (queued && queued.length > 0) {
    console.log(`[WebRTC] Flushing ${queued.length} queued ICE candidates`);
    for (const candidate of queued) {
      await transfer.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
    pendingICECandidates.delete(fileId);
  }
}

/**
 * Handle ICE candidate
 */
export async function handleICECandidate(
  fileId: string,
  candidate: RTCIceCandidateInit,
): Promise<void> {
  const transfer = activeTransfers.get(fileId);
  if (!transfer?.peerConnection) {
    console.error('[WebRTC] No active transfer found for ICE candidate');
    return;
  }

  // Queue ICE candidates if remote description hasn't been set yet
  if (!transfer.peerConnection.remoteDescription) {
    if (!pendingICECandidates.has(fileId)) {
      pendingICECandidates.set(fileId, []);
    }
    pendingICECandidates.get(fileId)!.push(candidate);
    console.log(`[WebRTC] Queued ICE candidate (no remote description yet)`);
    return;
  }

  await transfer.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

/**
 * Send signaling message via WebSocket
 * Only signaling goes through server — no file data!
 */
async function sendSignalingMessage(
  fileId: string,
  targetDeviceId: string,
  message: any,
): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  const wsClient = getWebSocketClient();
  const userId = wsClient.getUserId() || undefined;

  const event = await createEvent(
    `${WEBRTC_STREAM_ID}:${fileId}`,
    deviceId,
    'webrtc:signal',
    {
      file_id: fileId,
      target_device: targetDeviceId,
      signal: message,
    },
    userId,
  );

  await wsClient.sendEvent(event);
}

/**
 * Download received file
 */
function downloadFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Get transfer status
 */
export function getTransferStatus(fileId: string): WebRTCFileTransfer | null {
  return activeTransfers.get(fileId) || null;
}

/**
 * Cancel transfer
 */
export function cancelTransfer(fileId: string): void {
  const transfer = activeTransfers.get(fileId);
  if (transfer) {
    transfer.dataChannel?.close();
    transfer.peerConnection?.close();
    transfer.status = 'failed';
    emitTransferEvent('failed', transfer);
    activeTransfers.delete(fileId);
    pendingICECandidates.delete(fileId);
  }
}
