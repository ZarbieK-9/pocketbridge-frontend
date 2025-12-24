/**
 * Core TypeScript types for PocketBridge Phase 1
 * 
 * Matches backend types and Phase 1 specification
 */

// Device identity and metadata
export interface Device {
  id: string; // UUIDv4
  name: string;
  type: 'browser' | 'desktop';
  publicKey: string; // Ed25519 public key (hex)
  lastSeen: number; // Unix timestamp
  isOnline: boolean;
}

// Stream represents a feature workspace (clipboard, scratchpad, messages, files)
export interface Stream {
  id: string;
  name: string;
  type: 'clipboard' | 'scratchpad' | 'messages' | 'files';
  deviceIds: string[]; // Devices subscribed to this stream
  lastEventSeq: number;
}

/**
 * EncryptedEvent - Phase 1 Universal Event Envelope
 * 
 * Matches backend EncryptedEvent structure exactly
 */
export interface EncryptedEvent {
  event_id: string; // UUIDv7 (time-ordered)
  user_id: string; // Ed25519 public key (hex) - user identity
  device_id: string; // UUIDv4 - device that created the event
  device_seq: number; // Monotonic sequence per device (starts at 1)
  stream_id: string; // Feature-specific stream identifier
  stream_seq: number; // Server-assigned sequence per stream (monotonic)
  type: string; // Event type (e.g., "clipboard:update", "scratchpad:op")
  encrypted_payload: string; // Base64-encoded AES-GCM ciphertext
  ttl?: number; // Optional TTL (Unix timestamp)
  created_at?: number; // Server-assigned timestamp (metadata only)
}

// Event types for different features
export type EventType =
  | 'clipboard:text'
  | 'clipboard:update'
  | 'scratchpad:op'
  | 'scratchpad:update'
  | 'message:text'
  | 'message:self_destruct'
  | 'file:chunk'
  | 'file:metadata'
  | 'file:complete'
  | 'device:handshake'
  | 'device:ack';

// Decrypted event payload types
export interface ClipboardTextPayload {
  text: string;
  source?: string; // App/context where copied
}

export interface ScratchpadOpPayload {
  // CRDT operation (type depends on CRDT chosen)
  op: string; // JSON stringified CRDT operation
  version?: number; // CRDT version/vector clock
}

// Yjs update payload for scratchpad (Phase 1)
export interface ScratchpadUpdatePayload {
  update: string; // base64-encoded Yjs update
  type: 'yjs_update';
}

export interface MessageTextPayload {
  text: string;
  replyTo?: string; // Event ID of message being replied to
}

export interface MessageSelfDestructPayload {
  text: string;
  expiresAt: number; // Unix timestamp
}

export interface FileChunkPayload {
  file_id: string;
  chunk_index: number;
  total_chunks: number;
  data: string; // Base64 encoded chunk
  hash: string; // SHA-256 hash of chunk for integrity
}

export interface FileMetadataPayload {
  file_id: string;
  name: string;
  size: number;
  mime_type: string;
  total_chunks: number;
  encryption_key?: string; // Base64-encoded file encryption key (encrypted with session key)
}

// Union type for all payloads
export type EventPayload =
  | ClipboardTextPayload
  | ScratchpadOpPayload
  | ScratchpadUpdatePayload
  | MessageTextPayload
  | MessageSelfDestructPayload
  | FileChunkPayload
  | FileMetadataPayload;

// Crypto key types
export interface Ed25519KeyPair {
  publicKey: Uint8Array; // 32 bytes
  privateKey: Uint8Array; // 64 bytes (32 bytes private + 32 bytes public)
  publicKeyHex: string; // Hex-encoded public key
  privateKeyHex: string; // Hex-encoded private key
}

export interface SessionKeys {
  clientKey: CryptoKey; // AES-256-GCM key
  serverKey: CryptoKey; // AES-256-GCM key (same as client for simplicity)
  clientKeyHex: string;
  serverKeyHex: string;
}

// WebSocket message types
export interface WSMessage {
  type:
    | 'client_hello'
    | 'server_hello'
    | 'client_auth'
    | 'session_established'
    | 'event'
    | 'ack'
    | 'replay_request'
    | 'replay_response'
    | 'error';
  payload: unknown;
}

// Handshake messages
export interface ClientHello {
  type: 'client_hello';
  client_ephemeral_pub: string; // P-256 public key (hex)
  nonce_c: string; // 32 bytes hex
}

export interface ServerHello {
  type: 'server_hello';
  server_ephemeral_pub: string; // P-256 public key (hex)
  server_identity_pub: string; // Server Ed25519 public key (hex)
  server_signature: string; // Ed25519 signature (hex)
  nonce_s: string; // 32 bytes hex
}

export interface ClientAuth {
  type: 'client_auth';
  user_id: string; // Ed25519 public key (hex)
  device_id: string; // UUIDv4
  client_signature: string; // Ed25519 signature (hex)
  nonce_c2: string; // 32 bytes hex
}

export interface SessionEstablished {
  type: 'session_established';
  device_id: string;
  last_ack_device_seq: number;
  expires_at: number; // Unix timestamp (milliseconds) when session expires
}

export interface ReplayRequest {
  type: 'replay_request';
  last_ack_device_seq: number;
}

export interface ReplayResponse {
  type: 'replay_response';
  events: EncryptedEvent[];
}

// Connection status
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error' | 'reconnecting';

// Offline queue status
export interface QueueStatus {
  pending: number;
  lastSync: number | null;
  lastAckDeviceSeq: number; // Single value for this device
}
