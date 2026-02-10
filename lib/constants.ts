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

// Chunk size tiers - MUST fit within WebSocket maxPayload (15MB) AFTER base64 encoding
// Base64 adds ~33% overhead, so max raw chunk = 15MB / 1.34 ≈ 11.2MB (use 5MB for safety)
// Small chunks = less Redis memory, more overhead
// Large chunks = more Redis memory, less overhead
// For files > 5GB, use WebRTC P2P instead to bypass server entirely!
export const FILE_CHUNK_SIZE_SMALL = 5 * 1024 * 1024 // 5MB for files < 100MB (~6.7MB after base64)
export const FILE_CHUNK_SIZE_MEDIUM = 5 * 1024 * 1024 // 5MB for files 100MB - 1GB (~6.7MB after base64)
export const FILE_CHUNK_SIZE_LARGE = 5 * 1024 * 1024 // 5MB for files > 1GB (~6.7MB after base64)
export const FILE_CHUNK_SIZE_HUGE = 4 * 1024 * 1024 // 4MB for files > 10GB (~5.3MB after base64, minimal memory)

// Default chunk size (for backward compatibility)
export const FILE_CHUNK_SIZE = FILE_CHUNK_SIZE_SMALL

// Parallel chunk uploads - tuned per tier to balance throughput and memory
export const FILE_PARALLEL_CHUNKS_SMALL = 8 // 8 parallel for small files (~40MB in flight)
export const FILE_PARALLEL_CHUNKS_MEDIUM = 6 // 6 parallel for medium files (~30MB in flight)
export const FILE_PARALLEL_CHUNKS_LARGE = 4 // 4 parallel for large files (~20MB in flight)
export const FILE_PARALLEL_CHUNKS_HUGE = 3 // 3 parallel for huge files (~12MB in flight - MINIMAL)

// Default parallel chunks (for backward compatibility)
export const FILE_PARALLEL_CHUNKS = FILE_PARALLEL_CHUNKS_SMALL

// File size thresholds
export const WEBRTC_THRESHOLD = 100 * 1024 * 1024 // 100MB - use WebRTC P2P for files larger than this
export const RELAY_MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB - hard cap for server relay transfers
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
 * Returns true for files > 100MB to avoid relay overhead
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
