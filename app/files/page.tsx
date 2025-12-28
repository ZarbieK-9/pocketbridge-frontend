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
  reassembleFile,
} from '@/lib/features/files';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { checkRateLimit } from '@/lib/utils/rate-limit';
import { validateFile } from '@/lib/utils/validation';
import { ValidationError } from '@/lib/utils/errors';
import { logger } from '@/lib/utils/logger';
import { MAX_FILE_SIZE, FILE_CHUNK_SIZE, FILE_PARALLEL_CHUNKS } from '@/lib/constants';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Upload, FileIcon, Clock, Download } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { config } from '@/lib/config';

const WS_URL = config.wsUrl;

interface FileTransfer {
  fileId: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'completed' | 'error';
}

export default function FilesPage() {
  const deviceId = getOrCreateDeviceId();
  const { isInitialized: cryptoInitialized } = useCrypto();
  const { isConnected, sessionKeys, lastEvent } = useWebSocket({
    url: WS_URL,
    deviceId,
    autoConnect: cryptoInitialized,
  });

  const [transfers, setTransfers] = useState<FileTransfer[]>([]);
  const [incomingFiles, setIncomingFiles] = useState<Map<string, { metadata: any; chunks: Map<number, Uint8Array> }>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle incoming file events
  useEffect(() => {
    if (lastEvent && sessionKeys) {
      if (lastEvent.type === 'file:metadata') {
        handleIncomingFileMetadata(lastEvent);
      } else if (lastEvent.type === 'file:chunk') {
        handleIncomingFileChunk(lastEvent);
      }
    }
  }, [lastEvent, sessionKeys]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !sessionKeys) return;

    // Rate limiting for file uploads
    const rateLimit = checkRateLimit(`file:${deviceId}`, 'fileUpload');
    if (!rateLimit.allowed) {
      const resetIn = Math.ceil((rateLimit.resetAt - Date.now()) / 1000 / 60);
      alert(`Rate limit exceeded. Please wait ${resetIn} minutes before uploading another file.`);
      return;
    }

    try {
      // Validate file
      validateFile(file);
      
      if (file.size > MAX_FILE_SIZE) {
        throw new ValidationError(`File too large. Maximum size: ${(MAX_FILE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB`);
      }

      const upload = await startFileUpload(file);
      
      const transfer: FileTransfer = {
        fileId: upload.fileId,
        name: upload.name,
        size: upload.size,
        progress: 0,
        status: 'uploading',
      };
      setTransfers((prev) => [...prev, transfer]);

      // Upload chunks
      await uploadFileInChunks(file, upload, (progress) => {
        setTransfers((prev) =>
          prev.map((t) =>
            t.fileId === upload.fileId
              ? { ...t, progress, status: progress === 100 ? 'completed' : 'uploading' }
              : t
          )
        );
      });
    } catch (error) {
      logger.error('Failed to upload file', error);
      if (error instanceof ValidationError) {
        alert(error.message);
      } else {
        alert('Failed to upload file. Please try again.');
      }
    }
  }

  async function uploadFileInChunks(
    file: File,
    upload: Awaited<ReturnType<typeof startFileUpload>>,
    onProgress: (progress: number) => void
  ) {
    const totalChunks = upload.totalChunks;
    const PARALLEL_CHUNKS = FILE_PARALLEL_CHUNKS; // Upload chunks simultaneously for maximum speed
    let uploadedChunks = 0;
    const failedChunks: number[] = [];

    logger.info('Uploading file chunks', { totalChunks, parallelChunks: PARALLEL_CHUNKS });

    // Upload chunks in parallel batches
    for (let batchStart = 0; batchStart < totalChunks; batchStart += PARALLEL_CHUNKS) {
      const batchEnd = Math.min(batchStart + PARALLEL_CHUNKS, totalChunks);
      const batch: Promise<void>[] = [];

      // Create parallel upload promises for this batch
      for (let i = batchStart; i < batchEnd; i++) {
        const chunkIndex = i;
        const start = chunkIndex * FILE_CHUNK_SIZE;
        const end = Math.min(start + FILE_CHUNK_SIZE, file.size);
        
        const uploadPromise = (async () => {
          try {
            const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
            await uploadFileChunk(upload, chunkIndex, chunk);
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
          const start = chunkIndex * FILE_CHUNK_SIZE;
          const end = Math.min(start + FILE_CHUNK_SIZE, file.size);
          const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
          await uploadFileChunk(upload, chunkIndex, chunk);
          uploadedChunks++;
          onProgress((uploadedChunks / totalChunks) * 100);
        } catch (error) {
          logger.error('Failed to retry chunk', error, { chunkIndex });
          throw new Error(`Failed to upload chunk ${chunkIndex} after retry`);
        }
      }
    }

    logger.info('Upload complete', { fileName: upload.name, fileSize: upload.size });
  }

  async function handleIncomingFileMetadata(event: any) {
    try {
      const { receiveFileMetadata } = await import('@/lib/features/files');
      const metadata = await receiveFileMetadata(event);
      if (metadata) {
        // Add to incoming files tracking
        setIncomingFiles(prev => {
          const newMap = new Map(prev);
          newMap.set(metadata.file_id, {
            metadata,
            chunks: new Map(),
          });
          return newMap;
        });

        // Add to transfers list
        const transfer: FileTransfer = {
          fileId: metadata.file_id,
          name: metadata.name,
          size: metadata.size,
          progress: 0,
          status: 'uploading', // Will change to downloading
        };
        setTransfers(prev => [...prev, transfer]);
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
      
      const fileInfo = incomingFiles.get(fileId);
      if (!fileInfo) {
        logger.error('Received chunk for unknown file', undefined, { fileId });
        return;
      }

      // Import file encryption key
      const { importAESKey } = await import('@/lib/crypto/keys');
      const encryptionKeyBytes = Uint8Array.from(atob(fileInfo.metadata.encryption_key || ''), c => c.charCodeAt(0));
      const fileEncryptionKey = await importAESKey(encryptionKeyBytes);

      const chunk = await receiveFileChunk(event, fileEncryptionKey);
      if (chunk) {
        // Add chunk to tracking
        setIncomingFiles(prev => {
          const newMap = new Map(prev);
          const file = newMap.get(fileId);
          if (file) {
            file.chunks.set(chunk.chunkIndex, chunk.data);
            
            // Check if all chunks received
            if (file.chunks.size === file.metadata.total_chunks) {
              // Reassemble and download
              reassembleAndDownloadFile(file.metadata, file.chunks);
              
              // Update transfer status
              setTransfers(prev =>
                prev.map(t =>
                  t.fileId === fileId
                    ? { ...t, progress: 100, status: 'completed' }
                    : t
                )
              );
            } else {
              // Update progress
              const progress = (file.chunks.size / file.metadata.total_chunks) * 100;
              setTransfers(prev =>
                prev.map(t =>
                  t.fileId === fileId
                    ? { ...t, progress, status: 'uploading' }
                    : t
                )
              );
            }
          }
          return newMap;
        });
      }
    } catch (error) {
      logger.error('Failed to handle incoming file chunk', error);
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
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
        <StatusBadge status={isConnected ? 'online' : 'offline'} />
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
                    />
                  </div>
                  {transfer.status === 'uploading' && (
                    <Progress value={transfer.progress} className="h-2" />
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
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <FileIcon className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-4 text-sm text-muted-foreground">No file history</p>
            <p className="mt-2 text-xs text-muted-foreground">Transferred files will appear here</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
