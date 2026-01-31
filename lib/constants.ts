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

// Chunk size tiers for optimal speed based on file size
// Larger chunks = less overhead (fewer encryption calls, fewer WebSocket messages)
// FAST settings: maximum speed, uses more memory
export const FILE_CHUNK_SIZE_SMALL = 8 * 1024 * 1024 // 8MB for files < 100MB
export const FILE_CHUNK_SIZE_MEDIUM = 16 * 1024 * 1024 // 16MB for files 100MB - 1GB
export const FILE_CHUNK_SIZE_LARGE = 32 * 1024 * 1024 // 32MB for files > 1GB (max speed)

// Default chunk size (for backward compatibility)
export const FILE_CHUNK_SIZE = FILE_CHUNK_SIZE_SMALL

// Parallel chunk uploads based on file size
// FAST settings: maximum parallelism for speed
export const FILE_PARALLEL_CHUNKS_SMALL = 12 // 12 parallel for small files (~96MB in flight)
export const FILE_PARALLEL_CHUNKS_MEDIUM = 24 // 24 parallel for medium files (~384MB in flight)
export const FILE_PARALLEL_CHUNKS_LARGE = 32 // 32 parallel for large files (~1GB in flight max)

// Default parallel chunks (for backward compatibility)
export const FILE_PARALLEL_CHUNKS = FILE_PARALLEL_CHUNKS_SMALL

/**
 * Get optimal chunk size based on file size
 * Larger files use larger chunks to reduce overhead
 */
export function getOptimalChunkSize(fileSize: number): number {
  if (fileSize > 1024 * 1024 * 1024) { // > 1GB
    return FILE_CHUNK_SIZE_LARGE
  } else if (fileSize > 100 * 1024 * 1024) { // > 100MB
    return FILE_CHUNK_SIZE_MEDIUM
  }
  return FILE_CHUNK_SIZE_SMALL
}

/**
 * Get optimal parallel chunk count based on file size
 * Larger files benefit from more parallelism
 */
export function getOptimalParallelChunks(fileSize: number): number {
  if (fileSize > 1024 * 1024 * 1024) { // > 1GB
    return FILE_PARALLEL_CHUNKS_LARGE
  } else if (fileSize > 100 * 1024 * 1024) { // > 100MB
    return FILE_PARALLEL_CHUNKS_MEDIUM
  }
  return FILE_PARALLEL_CHUNKS_SMALL
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
export const DB_VERSION = 1
export const STORE_EVENTS = "events"
export const STORE_DEVICES = "devices"
export const STORE_STREAMS = "streams"
