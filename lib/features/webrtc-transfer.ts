/**
 * WebRTC Direct P2P File Transfer
 *
 * Bypasses the server/Redis for large file transfers
 * - Uses WebRTC data channels for direct peer-to-peer transfer
 * - WebSocket only used for signaling (offer/answer/ICE)
 * - No file data touches the server/Redis
 * - Supports unlimited file sizes
 * - Maximum speed (direct connection)
 */

import { createEvent } from '@/lib/sync/event-builder';
import { decryptPayload } from '@/lib/crypto/encryption';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getWebSocketClient } from '@/lib/ws';
import { getOptimalChunkSize } from '@/lib/constants';
import type { EncryptedEvent } from '@/types';

const WEBRTC_STREAM_ID = 'webrtc:signaling';
const CHUNK_SIZE = 64 * 1024; // 64KB chunks for WebRTC data channel (recommended)
const MAX_BUFFER_SIZE = 16 * 1024 * 1024; // 16MB buffer

interface WebRTCFileTransfer {
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
  peerConnection?: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
}

// Active transfers
const activeTransfers = new Map<string, WebRTCFileTransfer>();

/**
 * Send file via WebRTC P2P
 * Large files bypass server/Redis entirely
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
    mimeType: file.type,
    senderId: deviceId,
    receiverId: targetDeviceId,
    status: 'connecting',
    progress: 0,
    bytesTransferred: 0,
    startTime: Date.now(),
  };

  activeTransfers.set(fileId, transfer);

  try {
    // Create peer connection
    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    transfer.peerConnection = peerConnection;

    // Create data channel for file transfer
    const dataChannel = peerConnection.createDataChannel('fileTransfer', {
      ordered: true, // Ensure chunks arrive in order
    });

    transfer.dataChannel = dataChannel;

    // Set up data channel handlers
    dataChannel.onopen = async () => {
      console.log('[WebRTC] Data channel opened, starting transfer');
      transfer.status = 'transferring';
      await transferFile(file, dataChannel, transfer, onProgress);
    };

    dataChannel.onerror = (error) => {
      console.error('[WebRTC] Data channel error:', error);
      transfer.status = 'failed';
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        // Send ICE candidate via WebSocket signaling
        await sendSignalingMessage(fileId, targetDeviceId, {
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // Send offer via WebSocket signaling
    await sendSignalingMessage(fileId, targetDeviceId, {
      type: 'offer',
      sdp: offer.sdp!,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
    });

    console.log('[WebRTC] Offer sent, waiting for answer...');
    return fileId;
  } catch (error) {
    console.error('[WebRTC] Failed to initiate transfer:', error);
    transfer.status = 'failed';
    throw error;
  }
}

/**
 * Transfer file through data channel
 */
async function transferFile(
  file: File,
  dataChannel: RTCDataChannel,
  transfer: WebRTCFileTransfer,
  onProgress?: (progress: number) => void,
): Promise<void> {
  let offset = 0;

  const sendChunk = () => {
    // Check buffer before sending
    if (dataChannel.bufferedAmount > MAX_BUFFER_SIZE) {
      // Wait for buffer to drain
      setTimeout(sendChunk, 100);
      return;
    }

    const chunk = file.slice(offset, offset + CHUNK_SIZE);
    const reader = new FileReader();

    reader.onload = (e) => {
      const data = e.target?.result as ArrayBuffer;

      try {
        dataChannel.send(data);
        offset += data.byteLength;
        transfer.bytesTransferred = offset;
        transfer.progress = Math.round((offset / file.size) * 100);

        if (onProgress) {
          onProgress(transfer.progress);
        }

        if (offset < file.size) {
          sendChunk();
        } else {
          // Transfer complete
          dataChannel.send(new TextEncoder().encode('EOF'));
          transfer.status = 'complete';
          const duration = (Date.now() - transfer.startTime) / 1000;
          const speed = file.size / duration / 1024 / 1024; // MB/s
          console.log(`[WebRTC] Transfer complete: ${file.name} (${speed.toFixed(2)} MB/s)`);
        }
      } catch (error) {
        console.error('[WebRTC] Failed to send chunk:', error);
        transfer.status = 'failed';
      }
    };

    reader.onerror = () => {
      console.error('[WebRTC] Failed to read file chunk');
      transfer.status = 'failed';
    };

    reader.readAsArrayBuffer(chunk);
  };

  sendChunk();
}

/**
 * Handle incoming WebRTC offer
 */
export async function handleWebRTCOffer(
  fileId: string,
  senderId: string,
  offer: RTCSessionDescriptionInit,
  metadata: { fileName: string; fileSize: number; mimeType: string },
): Promise<void> {
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
  };

  activeTransfers.set(fileId, transfer);

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
    transfer.dataChannel = dataChannel;

    const chunks: ArrayBuffer[] = [];
    let receivedBytes = 0;

    dataChannel.onmessage = (event) => {
      // Check for EOF marker
      if (event.data instanceof ArrayBuffer) {
        const text = new TextDecoder().decode(new Uint8Array(event.data, 0, 3));
        if (text === 'EOF') {
          // Transfer complete - reassemble file
          const blob = new Blob(chunks, { type: metadata.mimeType });
          downloadFile(blob, metadata.fileName);
          transfer.status = 'complete';
          const duration = (Date.now() - transfer.startTime) / 1000;
          const speed = metadata.fileSize / duration / 1024 / 1024;
          console.log(`[WebRTC] Received file: ${metadata.fileName} (${speed.toFixed(2)} MB/s)`);
          return;
        }
      }

      chunks.push(event.data);
      receivedBytes += event.data.byteLength;
      transfer.bytesTransferred = receivedBytes;
      transfer.progress = Math.round((receivedBytes / metadata.fileSize) * 100);

      console.log(`[WebRTC] Progress: ${transfer.progress}% (${receivedBytes}/${metadata.fileSize})`);
    };

    dataChannel.onerror = (error) => {
      console.error('[WebRTC] Data channel error:', error);
      transfer.status = 'failed';
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
}

/**
 * Handle WebRTC answer
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

  await transfer.peerConnection.setRemoteDescription(answer);
  console.log('[WebRTC] Answer received, connection established');
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

  await transfer.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

/**
 * Send signaling message via WebSocket
 * Only signaling goes through server - no file data!
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
    activeTransfers.delete(fileId);
  }
}
