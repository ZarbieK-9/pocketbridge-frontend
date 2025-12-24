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
export const FILE_CHUNK_SIZE = 5 * 1024 * 1024 // 5MB chunks (optimized for speed)
export const FILE_PARALLEL_CHUNKS = 10 // Upload 10 chunks in parallel for maximum speed

// WebSocket configuration
export const WS_RECONNECT_DELAY = 3000 // 3 seconds
export const WS_HEARTBEAT_INTERVAL = 30000 // 30 seconds
export const WS_TIMEOUT = 60000 // 1 minute

// Storage keys
export const STORAGE_KEYS = {
  DEVICE_ID: "pocketbridge_device_id",
  DEVICE_NAME: "pocketbridge_device_name",
  IDENTITY_KEYPAIR: "pocketbridge_identity_keypair",
  SYMMETRIC_KEY: "pocketbridge_symmetric_key",
  LAST_ACK_SEQ: "pocketbridge_last_ack_seq",
} as const

// IndexedDB configuration
export const DB_NAME = "pocketbridge_db"
export const DB_VERSION = 1
export const STORE_EVENTS = "events"
export const STORE_DEVICES = "devices"
export const STORE_STREAMS = "streams"
