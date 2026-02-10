/**
 * Application constants and configuration
 */

export const APP_NAME = "PocketBridge"
export const APP_VERSION = "0.1.0"

// Crypto constants
export const NONCE_LENGTH = 12 // 96 bits for AES-GCM
export const KEY_LENGTH = 256 // AES-256
export const HMAC_LENGTH = 32 // SHA-256

// File constraints
export const MAX_FILE_SIZE = 25 * 1024 * 1024 * 1024 // 25GB

// Chunk size tiers - OPTIMIZED FOR REDIS/SERVER MEMORY
// Small chunks = less Redis memory, more overhead
// Large chunks = more Redis memory, less overhead
// For files > 5GB, use WebRTC P2P instead to bypass server entirely!
export const FILE_CHUNK_SIZE_SMALL = 8 * 1024 * 1024 // 8MB for files < 100MB
export const FILE_CHUNK_SIZE_MEDIUM = 16 * 1024 * 1024 // 16MB for files 100MB - 1GB
export const FILE_CHUNK_SIZE_LARGE = 12 * 1024 * 1024 // 12MB for files > 1GB (REDUCED to save Redis memory)
export const FILE_CHUNK_SIZE_HUGE = 8 * 1024 * 1024 // 8MB for files > 10GB (SMALL chunks to prevent Redis overflow)

// Default chunk size (for backward compatibility)
export const FILE_CHUNK_SIZE = FILE_CHUNK_SIZE_SMALL

// Parallel chunk uploads - REDUCED for large files to prevent Redis overflow
export const FILE_PARALLEL_CHUNKS_SMALL = 12 // 12 parallel for small files (~96MB in flight)
export const FILE_PARALLEL_CHUNKS_MEDIUM = 16 // 16 parallel for medium files (~256MB in flight)
export const FILE_PARALLEL_CHUNKS_LARGE = 8 // 8 parallel for large files (~96MB in flight - REDUCED)
export const FILE_PARALLEL_CHUNKS_HUGE = 4 // 4 parallel for huge files (~32MB in flight - MINIMAL to prevent Redis overflow)

// Default parallel chunks (for backward compatibility)
export const FILE_PARALLEL_CHUNKS = FILE_PARALLEL_CHUNKS_SMALL

// File size thresholds
export const WEBRTC_THRESHOLD = 5 * 1024 * 1024 * 1024 // 5GB - use WebRTC P2P for files larger than this
export const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024 * 1024 // 10GB - use minimal parallelism

/**
 * Get optimal chunk size based on file size
 * REDUCED chunk sizes for large files to prevent Redis memory overflow
 */
export function getOptimalChunkSize(fileSize: number): number {
  if (fileSize > LARGE_FILE_THRESHOLD) { // > 10GB
    return FILE_CHUNK_SIZE_HUGE // Small chunks to save Redis
  } else if (fileSize > 1024 * 1024 * 1024) { // > 1GB
    return FILE_CHUNK_SIZE_LARGE
  } else if (fileSize > 100 * 1024 * 1024) { // > 100MB
    return FILE_CHUNK_SIZE_MEDIUM
  }
  return FILE_CHUNK_SIZE_SMALL
}

/**
 * Get optimal parallel chunk count based on file size
 * REDUCED parallelism for large files to prevent Redis overflow
 */
export function getOptimalParallelChunks(fileSize: number): number {
  if (fileSize > LARGE_FILE_THRESHOLD) { // > 10GB
    return FILE_PARALLEL_CHUNKS_HUGE // Minimal parallelism
  } else if (fileSize > 1024 * 1024 * 1024) { // > 1GB
    return FILE_PARALLEL_CHUNKS_LARGE
  } else if (fileSize > 100 * 1024 * 1024) { // > 100MB
    return FILE_PARALLEL_CHUNKS_MEDIUM
  }
  return FILE_PARALLEL_CHUNKS_SMALL
}

/**
 * Check if file should use WebRTC P2P transfer (bypass server)
 * Returns true for files > 5GB to prevent Redis overflow
 */
export function shouldUseWebRTC(fileSize: number): boolean {
  return fileSize > WEBRTC_THRESHOLD
}

// WebSocket configuration
export const WS_RECONNECT_DELAY = 3000 // 3 seconds
export const WS_HEARTBEAT_INTERVAL = 30000 // 30 seconds
export const WS_TIMEOUT = 60000 // 1 minute

// Storage keys
export const STORAGE_KEYS = {
  DEVICE_ID: "pocketbridge_device_id",
  DEVICE_NAME: "pocketbridge_device_name",
  DEVICE_ROLE: "pocketbridge_device_role", // 'sharer' or 'receiver'
  IDENTITY_KEYPAIR: "pocketbridge_identity_keypair",
  IDENTITY_KEYPAIR_BACKUP: "pocketbridge_identity_keypair_backup", // Original identity before pairing
  SYMMETRIC_KEY: "pocketbridge_symmetric_key",
  LAST_ACK_SEQ: "pocketbridge_last_ack_seq",
  SERVER_IDENTITY_KEY: "pocketbridge_server_identity_key",
} as const

// IndexedDB configuration
export const DB_NAME = "pocketbridge_db"
export const DB_VERSION = 2 // Bumped for file_chunks store
export const STORE_EVENTS = "events"
export const STORE_DEVICES = "devices"
export const STORE_STREAMS = "streams"
export const STORE_FILE_CHUNKS = "file_chunks" // For resumable file transfers
