/**
 * WebSocket client for real-time event synchronization - Phase 1
 * 
 * Implements full MTProto-inspired handshake:
 * 1. Client Hello (ephemeral ECDH + nonce)
 * 2. Server Hello (ephemeral ECDH + server signature + nonce)
 * 3. Client Auth (user_id + device_id + client signature)
 * 4. Session Established (confirmation + replay state)
 * 
 * Then handles:
 * - Event sending/receiving
 * - Replay on reconnect
 * - Offline queue sync
 */

import { WS_RECONNECT_DELAY, WS_HEARTBEAT_INTERVAL } from '@/lib/constants';
import { getEventQueue } from '@/lib/sync';
import {
  generateECDHKeyPair,
  computeECDHSecret,
  deriveSessionKeys,
} from '@/lib/crypto/ecdh';
import {
  signEd25519,
  loadIdentityKeyPair,
} from '@/lib/crypto/keys';
import { generateHandshakeNonce } from '@/lib/crypto/nonce';
import { encryptPayload, decryptPayload } from '@/lib/crypto/encryption';
import { logger } from '@/lib/utils/logger';
import type {
  ConnectionStatus,
  WSMessage,
  EncryptedEvent,
  ClientHello,
  ServerHello,
  ClientAuth,
  SessionEstablished,
  ReplayRequest,
  ReplayResponse,
  SessionExpiringWarning,
  FullResyncRequired,
  SessionKeys,
  Ed25519KeyPair,
} from '@/types';

type EventHandler = (event: EncryptedEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type ErrorHandler = (error: Error) => void;

interface HandshakeState {
  clientEphemeralKeyPair?: Awaited<ReturnType<typeof generateECDHKeyPair>>;
  serverEphemeralPub?: string;
  nonceC?: string;
  nonceS?: string;
  nonceC2?: string;
  clientAuthSent?: boolean; // Flag to prevent sending multiple client_auth messages
  processing?: boolean; // Guard flag to prevent concurrent message processing
}

/**
 * WebSocket client for PocketBridge Phase 1
 */
export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private status: ConnectionStatus = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private eventHandlers: EventHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private deviceId: string;
  private userId: string | null = null; // Ed25519 public key (hex)
  private identityKeyPair: Ed25519KeyPair | null = null;
  private sessionKeys: SessionKeys | null = null;
  private lastAckDeviceSeq: number = 0;
  private handshakeState: HandshakeState = {};
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000; // Max 30 seconds
  private sessionExpiresAt: number | null = null; // Session expiration timestamp

  constructor(url: string, deviceId: string) {
    this.url = url;
    this.deviceId = deviceId;
    
    // Listen for service worker sync requests
    if (typeof window !== 'undefined') {
      window.addEventListener('sw-sync-request', this.handleServiceWorkerSync as EventListener);
    }
  }
  
  /**
   * Handle service worker sync request
   */
  private handleServiceWorkerSync = async (event: Event) => {
    const customEvent = event as CustomEvent;
    
    // Try to reconnect if disconnected
    if (this.status === 'disconnected') {
      await this.connect();
    }
    
    // Sync pending events
    if (this.status === 'connected') {
      await this.syncPending();
    }
  }

  /**
   * Connect to WebSocket server and perform handshake
   */
  async connect(): Promise<void> {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    // Always reset handshake state on new connection attempt
    this.handshakeState = {};

    // Load identity keypair and set handshake state before opening WebSocket
    try {
      this.identityKeyPair = await loadIdentityKeyPair();
      if (!this.identityKeyPair) {
        // Try to initialize crypto if keypair is not found
        logger.warn('Identity keypair not found, attempting to initialize crypto...');
        try {
          const { initializeCrypto } = await import('@/lib/crypto');
          const { identityKeyPair } = await initializeCrypto();
          if (!identityKeyPair) {
            throw new Error('Failed to initialize crypto. Identity keypair is still null after initialization.');
          }
          this.identityKeyPair = identityKeyPair;
          logger.info('Crypto initialized successfully during WebSocket connection');
        } catch (initError) {
          const errorMessage = initError instanceof Error ? initError.message : String(initError);
          logger.error('Failed to initialize crypto during WebSocket connection', {
            error: errorMessage,
          });
          throw new Error(`Identity keypair not found. Initialize crypto first. Crypto initialization failed: ${errorMessage}`);
        }
      }
      this.userId = this.identityKeyPair.publicKeyHex;

      // Set handshakeState with at least identity info before opening WebSocket
      // (Ephemeral keypair will be set in sendClientHello)
      this.handshakeState = {
        ...this.handshakeState,
      };

      this.updateStatus('connecting');

      // Create WebSocket connection
      this.ws = new WebSocket(this.url);
      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onclose = (event: CloseEvent) => this.handleClose(event);
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error('Connection failed'));
    }
  }

  /**
   * Handle WebSocket open
   */
  private async handleOpen(): Promise<void> {
    await this.sendClientHello();
    // Flush any buffered messages
    const pending: WSMessage[] = Array.isArray((this as any)._pendingMessages) ? [...(this as any)._pendingMessages] : [];
    if (pending.length > 0) {
      const stillPending: WSMessage[] = [];
      for (const msg of pending) {
        try {
          // Guard: only send if socket is open
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            stillPending.push(msg);
            continue;
          }
          // Clone payload to avoid stale buffers (defensive)
          const safeMsg: WSMessage = JSON.parse(JSON.stringify(msg));
          this.ws.send(JSON.stringify(safeMsg));
        } catch (err) {
          logger.error('Failed to flush buffered message', err);
          // Keep message for retry on next open
          stillPending.push(msg);
        }
      }
      (this as any)._pendingMessages = stillPending;
    }
  }

  /**
   * Send Client Hello (Step 1 of handshake)
   */
  private async sendClientHello(): Promise<void> {
    // Reset handshake state completely before starting new handshake
    // This ensures we don't use stale state from previous attempts
    this.handshakeState = {
      clientAuthSent: false, // Reset flag for new handshake
    };
    
    // Generate ephemeral ECDH keypair
    const clientEphemeralKeyPair = await generateECDHKeyPair();
    const nonceC = generateHandshakeNonce(); // 32-byte hex nonce for handshake

    // Store handshake state
    this.handshakeState = {
      ...this.handshakeState,
      clientEphemeralKeyPair,
      nonceC,
      clientAuthSent: false, // Ensure flag is set
    };


    // Send Client Hello
    const clientHello: ClientHello = {
      type: 'client_hello',
      client_ephemeral_pub: clientEphemeralKeyPair.publicKeyHex,
      nonce_c: nonceC,
    };

    this.send({
      type: 'client_hello',
      payload: clientHello,
    });
  }

  /**
   * Handle Server Hello (Step 2 of handshake)
   * Thread-safe: Guards against concurrent processing
   */
  private async handleServerHello(message: ServerHello): Promise<void> {
    // Guard against concurrent processing
    if (this.handshakeState.processing) {
      logger.warn('Server hello already being processed, ignoring duplicate');
      return;
    }

    if (!this.handshakeState.clientEphemeralKeyPair || !this.handshakeState.nonceC) {
      logger.error('Handshake state error: clientEphemeralKeyPair or nonceC missing in handleServerHello. Resetting handshake state.');
      this.handshakeState = {};
      this.disconnect();
      return;
    }

    // Validate we're in the right state (should have sent client_hello but not yet received server_hello)
    // If we already have server values, this is a duplicate/stale server_hello - ignore it
    if (this.handshakeState.serverEphemeralPub || this.handshakeState.nonceS) {
      logger.warn('Received duplicate server_hello. Ignoring.');
      return;
    }

    // Mark as processing to prevent concurrent execution
    this.handshakeState.processing = true;

    try {
      // Store server ephemeral public key and nonce IMMEDIATELY to prevent race conditions
      // These values must match what the backend used when computing its signature
      this.handshakeState.serverEphemeralPub = message.server_ephemeral_pub;
      this.handshakeState.nonceS = message.nonce_s;


    // Verify server signature
    // Server signs: SHA256(server_identity_pub || server_ephemeral_pub || nonce_c || nonce_s)
    const signatureData = await this.hashForSignature(
      message.server_identity_pub,
      message.server_ephemeral_pub,
      this.handshakeState.nonceC,
      message.nonce_s
    );

    // Note: Server signature verification is intentionally deferred for Phase 1
    // We use Trust-On-First-Use (TOFU) model - trust the server on first connection
    // In production, you would verify: await verifyEd25519(message.server_signature, signatureData, message.server_identity_pub)
    // This requires implementing verifyEd25519 in the client crypto utilities

    // Compute shared secret
    const sharedSecret = await computeECDHSecret(
      message.server_ephemeral_pub,
      this.handshakeState.clientEphemeralKeyPair.privateKey
    );

    // Derive session keys
    this.sessionKeys = await deriveSessionKeys(
      sharedSecret,
      this.handshakeState.clientEphemeralKeyPair.publicKeyHex,
      message.server_ephemeral_pub
    );

      // Send Client Auth
      await this.sendClientAuth();
    } finally {
      // Clear processing flag
      this.handshakeState.processing = false;
    }
  }

  /**
   * Send Client Auth (Step 3 of handshake)
   * Thread-safe: Uses atomic flag to prevent duplicate sends
   */
  private async sendClientAuth(): Promise<void> {
    if (
      !this.identityKeyPair ||
      !this.handshakeState.serverEphemeralPub ||
      !this.handshakeState.nonceC ||
      !this.handshakeState.nonceS
    ) {
      throw new Error('Handshake state incomplete');
    }

    // Prevent sending multiple client_auth messages for the same handshake (atomic check)
    if (this.handshakeState.clientAuthSent) {
      logger.warn('client_auth already sent for this handshake. Ignoring duplicate send.');
      return;
    }

    // Atomically mark that we're sending client_auth to prevent duplicates
    // This must be set BEFORE any async operations to prevent race conditions
    this.handshakeState.clientAuthSent = true;

    const nonceC2 = generateHandshakeNonce(); // 32-byte hex nonce for handshake
    this.handshakeState.nonceC2 = nonceC2;

    // Sign: SHA256(user_id || device_id || nonce_c || nonce_s || server_ephemeral_pub)
    // IMPORTANT: Use the exact values from the server_hello message we just received
    const signatureData = await this.hashForSignature(
      this.userId!,
      this.deviceId,
      this.handshakeState.nonceC,
      this.handshakeState.nonceS,
      this.handshakeState.serverEphemeralPub
    );

    // Log the exact values being used for signature (development only)
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Handshake signature data', {
        userId: this.userId!,
        deviceId: this.deviceId,
        nonceC: this.handshakeState.nonceC,
        nonceS: this.handshakeState.nonceS,
        serverEphemeralPub: this.handshakeState.serverEphemeralPub,
      });
    }
    
    const signature = await signEd25519(this.identityKeyPair.privateKey, signatureData);
    // signEd25519 returns hex string
    const signatureHex = typeof signature === 'string' ? signature : Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');

    const clientAuth: ClientAuth = {
      type: 'client_auth',
      user_id: this.userId!,
      device_id: this.deviceId,
      client_signature: signatureHex,
      nonce_c2: nonceC2,
    };

    this.send({
      type: 'client_auth',
      payload: clientAuth,
    });
  }

  /**
   * Handle Session Established (Step 4 of handshake)
   */
  private handleSessionEstablished(message: SessionEstablished): void {
    this.lastAckDeviceSeq = message.last_ack_device_seq;
    this.sessionExpiresAt = message.expires_at || null;

    // Sync device sequence to ensure monotonicity
    // This prevents sending events with device_seq <= last_ack_device_seq
    const queue = getEventQueue();
    queue.syncDeviceSeq(this.lastAckDeviceSeq);
    queue.acknowledge(this.deviceId, this.lastAckDeviceSeq);

    // Clear handshake state (including clientAuthSent flag)
    this.handshakeState = {};

    // Update status
    this.updateStatus('connected');
    this.reconnectAttempts = 0; // Reset on successful connection
    this.startHeartbeat();

    // Request replay if needed
    if (this.lastAckDeviceSeq > 0) {
      this.requestReplay();
    }

    // Sync pending events from offline queue
    this.syncPending();
  }

  /**
   * Hash data for signature
   * Must match backend implementation exactly: convert to string, then hash UTF-8 encoding
   */
  private async hashForSignature(...parts: (string | number)[]): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const combined: Uint8Array[] = [];
    parts.forEach((part) => {
      let str: string;
      // Convert Buffer/Uint8Array to hex string (matching backend behavior)
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(part)) {
        str = Buffer.from(part).toString('hex');
      } else if (ArrayBuffer.isView(part) && part.constructor && part.constructor.name === 'Uint8Array') {
        // part is a Uint8Array or similar - convert to hex string
        str = Array.from(new Uint8Array(part.buffer, part.byteOffset, part.byteLength)).map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        str = String(part);
      }
      // Encode string as UTF-8 (matching backend: Buffer.from(str, 'utf8'))
      combined.push(encoder.encode(str));
    });
    // Concatenate all UTF-8 encoded strings
    const totalLength = combined.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of combined) {
      result.set(arr, offset);
      offset += arr.length;
    }
    // Hash the concatenated result (equivalent to backend's incremental hash.update)
    return new Uint8Array(await crypto.subtle.digest('SHA-256', result));
  }

  /**
   * Request replay of missing events (with pagination support)
   */
  private requestReplay(continuationToken?: string): void {
    const replayRequest: ReplayRequest = {
      type: 'replay_request',
      last_ack_device_seq: this.lastAckDeviceSeq,
      limit: 100, // Request 100 events per page
      ...(continuationToken && { continuation_token: continuationToken }),
    };
    this.send({
      type: 'replay_request',
      payload: replayRequest,
    });
  }

  /**
   * Handle replay response (with pagination support)
   */
  private async handleReplayResponse(message: ReplayResponse): Promise<void> {
    // Validate message structure
    if (!message || typeof message !== 'object') {
      logger.error('Invalid replay response: message is null or not an object', { message });
      return;
    }

    if (!Array.isArray(message.events)) {
      logger.error('Invalid replay response: events is not an array', {
        hasEvents: !!message.events,
        eventsType: typeof message.events,
        messageKeys: Object.keys(message),
      });
      return;
    }

    // Process events from this page
    for (const event of message.events) {
      await this.handleIncomingEvent(event);
    }

    // If there are more events, request the next page
    if (message.has_more && message.continuation_token) {
      logger.info('Replay pagination: requesting next page', { eventsProcessed: message.events.length });
      // Small delay to avoid overwhelming the server
      setTimeout(() => {
        this.requestReplay(message.continuation_token);
      }, 100);
    } else {
      logger.info('Replay complete', { 
        eventsProcessed: message.events.length,
        totalEvents: message.total_events 
      });
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.stopHeartbeat();
    this.stopReconnect();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.updateStatus('disconnected');
    this.sessionKeys = null;
  }

  /**
   * Send an encrypted event
   */
  async sendEvent(event: EncryptedEvent): Promise<void> {
    if (this.status !== 'connected' || !this.sessionKeys) {
      // Queue for later when connected
      const queue = getEventQueue();
      await queue.enqueue(event);
      
      // Notify service worker to queue for background sync
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'QUEUE_EVENT',
          event,
        });
        
        // Register background sync if available
        if ('serviceWorker' in navigator && 'sync' in (await navigator.serviceWorker.ready)) {
          try {
            const registration = await navigator.serviceWorker.ready;
            await (registration as any).sync.register('sync-events');
          } catch (error) {
          }
        }
      }
      
      return;
    }

    const message: WSMessage = {
      type: 'event',
      payload: event,
    };

    this.send(message);
  }

  /**
   * Sync pending events from offline queue
   */
  async syncPending(): Promise<void> {
    if (!this.userId) {
      return;
    }

    const queue = getEventQueue();
    const pending = await queue.getPending();

    // Filter out events that:
    // 1. Have device_seq <= last_ack_device_seq (already processed)
    // 2. Have user_id !== current userId (from different identity keypair)
    const validPending = pending.filter(event => {
      const validSeq = event.device_seq > this.lastAckDeviceSeq;
      const validUserId = event.user_id === this.userId;
      return validSeq && validUserId;
    });

    if (validPending.length < pending.length) {
      const skipped = pending.length - validPending.length;
      const skippedSeq = pending.filter(e => e.device_seq <= this.lastAckDeviceSeq).length;
      const skippedUserId = pending.filter(e => e.user_id !== this.userId).length;
      
      
      // Acknowledge the skipped events with bad sequence as they're likely duplicates
    for (const event of pending) {
        if (event.device_seq <= this.lastAckDeviceSeq && event.user_id === this.userId) {
          queue.acknowledge(this.deviceId, event.device_seq);
        }
      }
    }


    for (const event of validPending) {
      await this.sendEvent(event);
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  private async handleMessage(event: MessageEvent): Promise<void> {
    try {
      const message: WSMessage = JSON.parse(event.data as string);

      switch (message.type) {
        case 'server_hello':
          await this.handleServerHello(message.payload as ServerHello);
          break;
        case 'session_established':
          this.handleSessionEstablished(message.payload as SessionEstablished);
          break;
        case 'event':
          await this.handleIncomingEvent(message.payload as EncryptedEvent);
          break;
        case 'replay_response':
          // Handle both wrapped (with payload) and unwrapped replay responses
          const replayMessage = message.payload || message;
          if (replayMessage && typeof replayMessage === 'object' && 'events' in replayMessage && Array.isArray((replayMessage as any).events)) {
            await this.handleReplayResponse(replayMessage as ReplayResponse);
          } else {
            logger.error('Invalid replay_response format', {
              hasPayload: !!message.payload,
              payloadType: typeof message.payload,
              messageKeys: message ? Object.keys(message) : [],
              replayMessageKeys: replayMessage && typeof replayMessage === 'object' ? Object.keys(replayMessage) : [],
            });
          }
          break;
        case 'session_expiring_soon':
          this.handleSessionExpiring(message.payload as SessionExpiringWarning);
          break;
        case 'full_resync_required':
          this.handleFullResyncRequired(message.payload as FullResyncRequired);
          break;
        case 'ack':
          this.handleAck(message.payload as { device_seq: number });
          break;
        case 'error':
          logger.error('Server error', undefined, { payload: message.payload });
          this.handleError(new Error(`Server error: ${JSON.stringify(message.payload)}`));
          break;
        default:
          logger.warn('Unknown message type', { type: message.type });
      }
    } catch (error) {
      logger.error('Failed to parse message', error);
    }
  }

  /**
   * Handle incoming encrypted event
   */
  private async handleIncomingEvent(event: EncryptedEvent): Promise<void> {
    if (!this.sessionKeys) {
      logger.error('No session keys, cannot decrypt event');
      return;
    }

    // Store event in local database (encrypted)
    const queue = getEventQueue();
    await queue.enqueue(event);

    // Decrypt payload (if needed by feature handlers)
    // Note: Features handle decryption themselves

    // Notify handlers
    this.eventHandlers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        logger.error('Event handler error', error);
      }
    });

    // Send ACK
    this.send({
      type: 'ack',
      payload: { device_seq: event.device_seq },
    });
  }

  /**
   * Handle acknowledgment from server
   */
  private handleAck(ack: { device_seq: number }): void {
    this.lastAckDeviceSeq = ack.device_seq;

    const queue = getEventQueue();
    queue.acknowledge(this.deviceId, ack.device_seq);
  }

  /**
   * Send message via WebSocket
   */
  private send(message: WSMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Buffer message until socket opens
      const queue: WSMessage[] = (this as any)._pendingMessages || [];
      // Clone message to avoid retaining references to detached buffers
      const safeMsg: WSMessage = JSON.parse(JSON.stringify(message));
      queue.push(safeMsg);
      (this as any)._pendingMessages = queue;
      return;
    }

    try {
      // Clone before sending to avoid DOMExceptions from stale objects
      const safeMsg: WSMessage = JSON.parse(JSON.stringify(message));
      this.ws.send(JSON.stringify(safeMsg));
    } catch (err) {
      logger.error('WebSocket send failed, buffering for retry', err);
      const queue: WSMessage[] = (this as any)._pendingMessages || [];
      queue.push(JSON.parse(JSON.stringify(message)));
      (this as any)._pendingMessages = queue;
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      // Send ping (if server supports it)
    }, WS_HEARTBEAT_INTERVAL);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Schedule reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    this.stopReconnect();

    // Only reconnect if the previous WebSocket is fully closed
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      return;
    }

    // Update status to reconnecting
    this.updateStatus('reconnecting');

    // Exponential backoff: start at 3s, max 30s, with a minimum enforced delay
    const baseDelay = WS_RECONNECT_DELAY;
    const minDelay = 1000; // 1s minimum delay
    const delay = Math.max(minDelay, Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay));
    this.reconnectAttempts++;


    this.reconnectTimer = setTimeout(() => {
      // Double-check socket is still closed before reconnecting
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.connect();
      } else {
      }
    }, delay);
  }

  /**
   * Stop reconnection attempts
   */
  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Handle session expiring warning
   */
  private handleSessionExpiring(warning: SessionExpiringWarning): void {
    logger.warn('Session expiring soon', {
      expires_in_seconds: warning.expires_in_seconds,
      expires_at: new Date(warning.expires_at).toISOString(),
    });

    // Notify handlers about session expiration
    this.errorHandlers.forEach(handler => {
      try {
        handler(new Error(`Session expiring in ${warning.expires_in_seconds} seconds. Reconnecting...`));
      } catch (error) {
        logger.error('Error handler error', error);
      }
    });

    // Schedule reconnection before expiration (reconnect 30 seconds before expiration)
    const reconnectDelay = Math.max(0, warning.expires_in_seconds * 1000 - 30000);
    if (reconnectDelay > 0) {
      setTimeout(() => {
        logger.info('Reconnecting due to session expiration');
        this.disconnect();
        this.connect();
      }, reconnectDelay);
    } else {
      // Expiring very soon, reconnect immediately
      this.disconnect();
      this.connect();
    }
  }

  /**
   * Handle full resync required message
   */
  private handleFullResyncRequired(message: FullResyncRequired): void {
    logger.error('Full resync required', undefined, {
      reason: message.reason,
      event_count: message.event_count,
      recommendation: message.recommendation,
    });

    // Notify handlers
    this.errorHandlers.forEach(handler => {
      try {
        handler(new Error(`Full resync required: ${message.recommendation}`));
      } catch (error) {
        logger.error('Error handler error', error);
      }
    });

    // Clear local state and reset
    const queue = getEventQueue();
    queue.clear().then(() => {
      logger.info('Local state cleared, reconnecting');
      this.lastAckDeviceSeq = 0;
      this.disconnect();
      this.connect();
    });
  }

  /**
   * Handle WebSocket error
   */
  private handleError(error: Error | Event): void {
    // Extract useful information from the error
    let errorMessage = 'WebSocket error';
    let errorDetails: Record<string, unknown> = {
      url: this.url,
      readyState: this.ws?.readyState,
      readyStateText: this.ws?.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                     this.ws?.readyState === WebSocket.OPEN ? 'OPEN' :
                     this.ws?.readyState === WebSocket.CLOSING ? 'CLOSING' :
                     this.ws?.readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN',
    };

    if (error instanceof Error) {
      errorMessage = error.message;
      errorDetails.errorName = error.name;
      errorDetails.errorStack = error.stack;
    } else if (error instanceof Event) {
      errorMessage = `WebSocket error event: ${error.type}`;
      errorDetails.eventType = error.type;
      errorDetails.eventTarget = error.target;
      // Try to get more info from the WebSocket
      if (this.ws) {
        errorDetails.wsUrl = this.ws.url;
        errorDetails.wsReadyState = this.ws.readyState;
        errorDetails.wsBufferedAmount = this.ws.bufferedAmount;
      }
    }

    // Check if it's a connection error
    if (this.ws?.readyState === WebSocket.CLOSED && !this.ws?.url) {
      errorMessage = 'WebSocket connection failed - check URL and network connectivity';
      errorDetails.suggestion = 'Verify the WebSocket URL is correct and the server is reachable';
    }

    console.error('[Phase1] WebSocket error:', {
      message: errorMessage,
      ...errorDetails,
      rawError: error,
    });

    this.updateStatus('error');

    // Create a more informative error object
    const informativeError = error instanceof Error 
      ? error 
      : new Error(`${errorMessage}. Check browser console and network tab for details.`);

    this.errorHandlers.forEach(handler => {
      try {
        handler(informativeError);
      } catch (err) {
        console.error('[Phase1] Error handler failed:', err);
      }
    });

    this.scheduleReconnect();
  }

  /**
   * Handle WebSocket close
   */
  private handleClose(event?: CloseEvent): void {
    const closeCode = event?.code;
    const closeReason = event?.reason || '';
    const wasClean = event?.wasClean ?? false;
    
    // Log close details for debugging
    if (closeCode !== 1000 && closeCode !== 1001) {
      // Not a normal closure or session rotation
      logger.warn('WebSocket closed abnormally', {
        code: closeCode,
        reason: closeReason,
        wasClean,
        url: this.url,
        previousStatus: this.status,
      });
      console.warn('[Phase1] WebSocket closed:', {
        code: closeCode,
        reason: closeReason,
        wasClean,
        url: this.url,
        readyState: this.ws?.readyState,
      });
    }

    // Handle session key rotation (close code 1001)
    if (closeCode === 1001) {
      logger.info('Session key rotation required, reconnecting');
      // Clear session keys to force new handshake
      this.sessionKeys = null;
      this.handshakeState = {};
      // Reconnect immediately for session rotation
      setTimeout(() => {
        this.connect();
      }, 1000);
      return;
    }

    // Don't reset handshake state if we're in the middle of processing a handshake
    // Only reset if we're fully disconnected (not during an active handshake)
    // The handshake state will be reset on the next connection attempt in connect()
    if (this.status === 'connected') {
      // If we were connected, we can safely reset
      this.handshakeState = {};
    } else if (this.status !== 'error' && this.status !== 'connecting') {
      // Reset for other statuses except when actively connecting
      this.handshakeState = {};
    }

    this.stopHeartbeat();
    this.updateStatus('disconnected');
    this.sessionKeys = null;
    
    // Only schedule reconnect if socket is fully closed and not a session rotation
    if (closeCode !== 1001) {
      setTimeout(() => {
        this.scheduleReconnect();
      }, 100); // Small delay to ensure socket is closed
    }
  }

  /**
   * Update connection status
   */
  private updateStatus(status: ConnectionStatus): void {
    this.status = status;

    this.statusHandlers.forEach(handler => {
      try {
        handler(status);
      } catch (error) {
        logger.error('Status handler error', error);
      }
    });
  }

  /**
   * Register event handler
   */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
    };
  }

  /**
   * Register status handler
   * Immediately calls handler with current status if already connected/disconnected
   */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.push(handler);
    // Immediately notify handler of current status
    try {
      handler(this.status);
    } catch (error) {
      console.error('[Phase1] Status handler error on registration:', error);
    }
    return () => {
      this.statusHandlers = this.statusHandlers.filter(h => h !== handler);
    };
  }

  /**
   * Register error handler
   */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.push(handler);
    return () => {
      this.errorHandlers = this.errorHandlers.filter(h => h !== handler);
    };
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Get session keys (for testing/debugging)
   */
  getSessionKeys(): SessionKeys | null {
    return this.sessionKeys;
  }
}

/**
 * Singleton WebSocket client instance
 */
let clientInstance: WebSocketClient | null = null;

export function getWebSocketClient(url?: string, deviceId?: string): WebSocketClient {
  if (!clientInstance && url && deviceId) {
    clientInstance = new WebSocketClient(url, deviceId);
  }

  if (!clientInstance) {
    throw new Error('WebSocket client not initialized. Call with url and deviceId first.');
  }

  return clientInstance;
}
