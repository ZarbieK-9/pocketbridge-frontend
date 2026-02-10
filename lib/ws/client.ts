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

import { WS_RECONNECT_DELAY, WS_HEARTBEAT_INTERVAL, STORAGE_KEYS } from '@/lib/constants';
import { config } from '@/lib/config';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { getEventQueue } from '@/lib/sync';
import {
  generateECDHKeyPair,
  computeECDHSecret,
  deriveSessionKeys,
} from '@/lib/crypto/ecdh';
import {
  signEd25519,
  verifyEd25519,
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
  SystemMessage,
} from '@/types';

type EventHandler = (event: EncryptedEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type ErrorHandler = (error: Error) => void;
type SystemHandler = (message: SystemMessage) => void;

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
    private systemHandlers: SystemHandler[] = [];
  private deviceId: string;
  private userId: string | null = null; // Ed25519 public key (hex)
  private identityKeyPair: Ed25519KeyPair | null = null;
  private sessionKeys: SessionKeys | null = null;
  // NOTE: lastAckDeviceSeq is managed by EventQueue (single source of truth)
  // Use getEventQueue().getLastAckDeviceSeq() instead of maintaining a separate copy
  private handshakeState: HandshakeState = {};
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000; // Max 30 seconds for fast phase
  private slowReconnectDelay: number = 60000; // 60 seconds for slow phase
  private fastReconnectThreshold: number = 10; // After this many attempts, switch to slow polling
  private sessionExpiresAt: number | null = null; // Session expiration timestamp
  private handshakeRetries: number = 0;
  private maxHandshakeRetries: number = 3; // Max handshake retries
  private connectInProgress: boolean = false; // Guard against concurrent connect() calls
  private pendingEventsBuffer: EncryptedEvent[] = []; // Buffer for events received before session keys are ready
  private fileEventBuffer: EncryptedEvent[] = []; // Buffer file events for pages that mount late

  constructor(url: string, deviceId: string) {
    this.url = url;
    this.deviceId = deviceId;
    
    // Listen for service worker sync requests
    if (typeof window !== 'undefined') {
      window.addEventListener('sw-sync-request', this.handleServiceWorkerSync as EventListener);

      // Reconnect immediately when user returns to the app/tab
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  /**
   * Handle page visibility change — reconnect when user returns to the tab/app
   */
  private handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;

    const needsReconnect =
      this.status === 'disconnected' ||
      this.status === 'error' ||
      (this.ws && this.ws.readyState === WebSocket.CLOSED);

    if (needsReconnect) {
      logger.info('[WS] Tab became visible, reconnecting', {
        status: this.status,
        reconnectAttempts: this.reconnectAttempts,
      });
      this.reconnectAttempts = 0; // Reset to fast phase
      this.stopReconnect();
      this.connect();
    }
  };

  /**
   * Get current user ID (UUID after pairing, or identity public key hex)
   */
  getUserId(): string | null {
    return this.userId;
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
    // Guard against concurrent connect() calls
    if (this.connectInProgress) {
      logger.info('[WS] connect() already in progress, skipping');
      return;
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.connectInProgress = true;

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
      logger.info('[WS] Creating WebSocket connection', { url: this.url });
      this.ws = new WebSocket(this.url);
      
      logger.info('[WS] Attaching event listeners');
      // Use property assignment for event handlers (standard approach)
      // Note: Do NOT also use addEventListener with the same handler - that causes duplicate firing
      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onclose = (event: CloseEvent) => this.handleClose(event);
      
      // Watchdog: if open event is lost and no client_hello is queued within 5s, force-send it when socket is open
      setTimeout(() => {
        const ready = this.ws?.readyState === WebSocket.OPEN;
        const alreadyConnected = this.status === 'connected';
        const hasClientHello = !!this.handshakeState.nonceC || !!this.handshakeState.clientEphemeralKeyPair;
        if (ready && !alreadyConnected && !hasClientHello) {
          logger.warn('[HANDSHAKE] Watchdog firing: open detected but client_hello not sent; forcing sendClientHello');
          this.sendClientHello().catch(err => {
            logger.error('[HANDSHAKE] Watchdog sendClientHello failed', err instanceof Error ? err : new Error(String(err)));
          });
        }
      }, 5000);
      
      logger.info('[WS] WebSocket setup complete, waiting for connection');
      this.connectInProgress = false;
    } catch (error) {
      this.connectInProgress = false;
      logger.error('[WS] Error during connection setup', error);
      this.handleError(error instanceof Error ? error : new Error('Connection failed'));
    }
  }

  /**
   * Handle WebSocket open
   */
  private async handleOpen(): Promise<void> {
    logger.info('[HANDSHAKE] WebSocket connection opened, readyState=' + (this.ws?.readyState ?? 'N/A'));
    
    // Always flush any buffered messages first (before the handshake guard)
    // This ensures client_hello buffered during CONNECTING gets sent when socket opens
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
          logger.debug('[SEND] Flushed buffered message', { type: msg.type });
        } catch (err) {
          logger.error('Failed to flush buffered message', err);
          // Keep message for retry on next open
          stillPending.push(msg);
        }
      }
      (this as any)._pendingMessages = stillPending;
    }

    // Guard: if we already have an in-flight client_hello (nonceC set and no server response yet), don't resend
    if (this.handshakeState.nonceC && !this.handshakeState.serverEphemeralPub) {
      logger.info('[HANDSHAKE] client_hello already in-flight (buffered/sent), awaiting server_hello', {
        hasNonceC: !!this.handshakeState.nonceC,
        hasServerEphemeral: !!this.handshakeState.serverEphemeralPub,
      });
      return;
    }
    try {
      logger.info('[HANDSHAKE] Calling sendClientHello()...');
      await this.sendClientHello();
      logger.info('[HANDSHAKE] sendClientHello() completed successfully');
    } catch (error) {
      logger.error('[HANDSHAKE] Failed to send client hello on WebSocket open', error);
      this.handleError(error instanceof Error ? error : new Error(String(error)));
      // Don't call disconnect() here - handleError() already schedules reconnect
      // and the WebSocket will close, triggering handleClose()
      return;
    }
  }

  /**
   * Send Client Hello (Step 1 of handshake)
   */
  private async sendClientHello(): Promise<void> {
    try {
      logger.info('[HANDSHAKE] sendClientHello() called');

      // Prevent duplicate client_hello if one is already pending (nonceC set, no server_hello yet)
      if (this.handshakeState.nonceC && !this.handshakeState.serverEphemeralPub) {
        logger.info('[HANDSHAKE] client_hello already sent and awaiting server_hello; not sending another');
        return;
      }

      // Reset handshake state completely before starting new handshake
      // This ensures we don't use stale state from previous attempts
      this.handshakeState = {
        clientAuthSent: false, // Reset flag for new handshake
      };

      // CRITICAL: Clear stale session keys from previous handshake attempts
      // Using stale keys would cause decryption failures
      this.sessionKeys = null;
      
      logger.info('[HANDSHAKE] Generating ECDH keypair for handshake...');
      // Generate ephemeral ECDH keypair
      const clientEphemeralKeyPair = await generateECDHKeyPair();
      logger.info('[HANDSHAKE] ECDH keypair generated successfully, generating nonce...');
      const nonceC = generateHandshakeNonce(); // 32-byte hex nonce for handshake

      // Store handshake state
      this.handshakeState = {
        ...this.handshakeState,
        clientEphemeralKeyPair,
        nonceC,
        clientAuthSent: false, // Ensure flag is set
      };

      logger.info('[HANDSHAKE] About to send client_hello message', {
        ephemeralPubKeyPrefix: clientEphemeralKeyPair.publicKeyHex.substring(0, 16) + '...',
        nonceCLength: nonceC.length,
        wsReadyState: this.ws?.readyState ?? 'N/A',
        wsUrl: this.url,
      });

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
      
      logger.info('[HANDSHAKE] client_hello message sent to WebSocket');
    } catch (error) {
      logger.error('[HANDSHAKE] Error in sendClientHello', error);
      throw error;
    }
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
      this.handleError(new Error('Handshake state corrupted'));
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

    // Verify server signature and pin server identity (TOFU with change detection)
    let signatureData: Uint8Array;
    let signatureBytes: Uint8Array;
    let serverIdentityBytes: Uint8Array;
    
    try {
      signatureData = await this.hashForSignature(
        message.server_identity_pub,
        message.server_ephemeral_pub,
        this.handshakeState.nonceC,
        message.nonce_s
      );

      signatureBytes = this.hexToBytes(message.server_signature);
      serverIdentityBytes = this.hexToBytes(message.server_identity_pub);

      const signatureDataHex = Buffer.from(signatureData).toString('hex');
      logger.info('[HANDSHAKE] ServerHello verification inputs', {
        serverIdentityPubPrefix: message.server_identity_pub?.substring(0, 16) + '...',
        serverIdentityPubLength: message.server_identity_pub?.length,
        serverEphemeralPubPrefix: message.server_ephemeral_pub?.substring(0, 16) + '...',
        serverEphemeralPubLength: message.server_ephemeral_pub?.length,
        nonceC: this.handshakeState.nonceC,
        nonceS: message.nonce_s,
        signatureLength: message.server_signature?.length,
        signatureDataHashPrefix: signatureDataHex.substring(0, 16) + '...',
        signatureDataHashLength: signatureDataHex.length,
        signatureDataHashFull: signatureDataHex,
      });
    } catch (err) {
      const error = new Error(`Failed to prepare signature verification: ${err instanceof Error ? err.message : String(err)}`);
      logger.error('Signature preparation error', {
        error: error.message,
        originalError: err instanceof Error ? err.message : String(err),
      });
      this.handleError(error);
      return;
    }

    const pinnedKey = this.getPinnedServerKey();
    if (pinnedKey && pinnedKey !== message.server_identity_pub) {
      const error = new Error('Server identity key changed - refusing connection');
      logger.error('Server identity key mismatch', {
        pinnedKey: pinnedKey.substring(0, 16) + '...',
        receivedKey: message.server_identity_pub.substring(0, 16) + '...',
      });
      this.handleError(error);
      return;
    }

    let isValidSignature = false;
    try {
      const signatureBytes = this.hexToBytes(message.server_signature);
      const serverIdentityBytes = this.hexToBytes(message.server_identity_pub);
      isValidSignature = await verifyEd25519(
        signatureBytes,
        signatureData,
        serverIdentityBytes
      );
    } catch (err) {
      const error = new Error(`Signature verification threw error: ${err instanceof Error ? err.message : String(err)}`);
      logger.error('Signature verification exception', {
        error: error.message,
        originalError: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      this.handleError(error);
      return;
    }

    if (!isValidSignature) {
      const error = new Error('Server signature verification failed');
      logger.error('Server signature verification failed', {
        error: error.message,
        serverIdentityPub: message.server_identity_pub.substring(0, 16) + '...',
        signatureDataLength: signatureData.length,
        signatureBytesLength: signatureBytes.length,
        serverIdentityBytesLength: serverIdentityBytes.length,
      });
      this.handleError(error);
      return;
    }

    if (!pinnedKey) {
      this.pinServerKey(message.server_identity_pub);
      logger.info('Pinned server identity key (TOFU)', {
        serverKey: message.server_identity_pub.substring(0, 16) + '...',
      });
    }

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

    // Get device name and type for registration
    const { getOrCreateDeviceName } = await import('@/lib/utils/device');
    const { getDeviceType } = await import('@/lib/utils/device');
    const deviceName = getOrCreateDeviceName();
    const deviceType = getDeviceType() === 'tablet' ? 'mobile' : getDeviceType(); // Map tablet to mobile
    
    const clientAuth: ClientAuth = {
      type: 'client_auth',
      user_id: this.userId!,
      device_id: this.deviceId,
      client_signature: signatureHex,
      nonce_c2: nonceC2,
      device_name: deviceName,
      device_type: deviceType as 'mobile' | 'desktop' | 'web',
    };

    this.send({
      type: 'client_auth',
      payload: clientAuth,
    });
  }

  /**
   * Handle Session Established (Step 4 of handshake)
   */
  private async handleSessionEstablished(message: SessionEstablished): Promise<void> {
    // Parse last_ack_device_seq as number (server may send as string)
    const lastAckSeq = typeof message.last_ack_device_seq === 'string'
      ? parseInt(message.last_ack_device_seq, 10)
      : message.last_ack_device_seq;

    logger.info('[HANDSHAKE] Session established received', {
      lastAckDeviceSeq: lastAckSeq,
      expiresAt: message.expires_at,
    });
    this.sessionExpiresAt = message.expires_at || null;

    // Sync device sequence to ensure monotonicity
    // This prevents sending events with device_seq <= last_ack_device_seq
    // IMPORTANT: EventQueue is the single source of truth for lastAckDeviceSeq
    const queue = getEventQueue();
    await queue.setLastAckFromServer(lastAckSeq);
    await queue.acknowledge(this.deviceId, lastAckSeq);

    // Clear handshake state (including clientAuthSent flag)
    this.handshakeState = {};

    // Update status
    this.updateStatus('connected');
    this.reconnectAttempts = 0; // Reset on successful connection
    this.resetHandshakeRetries(); // Reset handshake retries on successful connection
    this.startHeartbeat();

    // Process any buffered events that arrived before session keys were ready
    if (this.pendingEventsBuffer.length > 0) {
      logger.info('[HANDSHAKE] Processing buffered events', {
        count: this.pendingEventsBuffer.length,
      });
      const bufferedEvents = [...this.pendingEventsBuffer];
      this.pendingEventsBuffer = []; // Clear buffer before processing to avoid infinite loop

      // Process buffered events asynchronously (fire-and-forget pattern)
      this.processBufferedEvents(bufferedEvents);
    }

    // Skip replay and event sync if we're mid-pairing flow.
    // During pairing, the server session userId is the device's OLD identity (preserved
    // from the DB), but the client's events use the NEW adopted identity. Sending events
    // now would cause "Event user_id mismatch". The complete_pairing message will fix the
    // session, and events will sync on the next connection after the page redirects.
    const hasPendingPairing = typeof window !== 'undefined' &&
      !!sessionStorage.getItem('pending_pairing_code');

    if (!hasPendingPairing) {
      // Request replay if needed
      const lastAck = queue.getLastAckDeviceSeq();
      if (lastAck > 0) {
        this.requestReplay();
      }

      // Sync pending events from offline queue
      this.syncPending();
    } else {
      logger.info('[HANDSHAKE] Skipping syncPending/requestReplay — pending pairing code detected');
    }
  }

  /**
   * Process buffered events that arrived before session keys were ready
   */
  private async processBufferedEvents(events: EncryptedEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.handleIncomingEvent(event);
      } catch (error) {
        logger.error('[processBufferedEvents] Error processing buffered event', error, {
          eventId: event.event_id,
          type: event.type,
        });
      }
    }
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

  private hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const pairs = clean.match(/.{1,2}/g) || [];
    return new Uint8Array(pairs.map((byte) => parseInt(byte, 16)));
  }

  private getPinnedServerKey(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEYS.SERVER_IDENTITY_KEY);
  }

  private pinServerKey(serverKey: string): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEYS.SERVER_IDENTITY_KEY, serverKey);
    } catch (error) {
      logger.warn('Failed to persist pinned server identity key', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Request replay of missing events (with pagination support)
   */
  private requestReplay(continuationToken?: string): void {
    const queue = getEventQueue();
    const replayRequest: ReplayRequest = {
      type: 'replay_request',
      last_ack_device_seq: queue.getLastAckDeviceSeq(),
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
   * Complete pairing by sending pairing code to backend
   * This links this device to another user's account
   */
  completePairing(pairingCode: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error('Cannot complete pairing: WebSocket not connected');
      throw new Error('WebSocket not connected. Please wait for connection and try again.');
    }

    if (!pairingCode || pairingCode.length !== 6) {
      throw new Error('Invalid pairing code format');
    }

    logger.info('Sending complete_pairing message', { codeLength: pairingCode.length });

    this.send({
      type: 'complete_pairing',
      payload: {
        pairing_code: pairingCode,
      },
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.stopHeartbeat();
    this.stopReconnect();

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }

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
    const lastAckSeq = queue.getLastAckDeviceSeq();

    // Filter out events that:
    // 1. Have device_seq <= last_ack_device_seq (already processed)
    // 2. Have user_id !== current userId (from different identity keypair)
    // 3. Have device_id !== this device (events from other devices should not be resent)
    const validPending = pending.filter(event => {
      const validSeq = event.device_seq > lastAckSeq;
      const validUserId = event.user_id === this.userId;
      const validDeviceId = event.device_id === this.deviceId;
      return validSeq && validUserId && validDeviceId;
    });

    if (validPending.length < pending.length) {
      const skippedSeq = pending.filter(e => e.device_seq <= lastAckSeq).length;
      const skippedUserId = pending.filter(e => e.user_id !== this.userId).length;
      const skippedDeviceId = pending.filter(e => e.device_id !== this.deviceId).length;

      logger.info('Filtering pending events', {
        total: pending.length,
        valid: validPending.length,
        skippedSeq,
        skippedUserId,
        skippedDeviceId,
        thisDeviceId: this.deviceId?.substring(0, 8) + '...',
      });

      // Clean up acknowledged and orphaned events from IndexedDB
      // This prevents orphaned events from accumulating indefinitely
      if (this.userId) {
        const deletedCount = await queue.cleanup(this.userId);
        if (deletedCount > 0) {
          logger.info('Cleaned up stale events from IndexedDB', { deletedCount });
        }
      }
    }


    // Track failed sends to retry later
    const failedEvents: EncryptedEvent[] = [];

    for (const event of validPending) {
      try {
        // Mark as in-flight to prevent duplicate sends during network flapping
        queue.markInFlight(event.event_id);

        await this.sendEvent(event);

        // Note: Event stays in-flight until server acknowledges it
        // The acknowledge() handler will clear it from in-flight set
      } catch (error) {
        logger.error('Failed to send pending event', {
          eventId: event.event_id,
          deviceSeq: event.device_seq,
          error,
        });

        // Clear from in-flight on error so it can be retried
        queue.clearInFlight(event.event_id);
        failedEvents.push(event);

        // Continue with next event instead of stopping (partial sync continuation)
      }
    }

    if (failedEvents.length > 0) {
      logger.warn(`Failed to sync ${failedEvents.length}/${validPending.length} events`, {
        failedEventIds: failedEvents.map(e => e.event_id.substring(0, 8)),
        inFlightCount: queue.getInFlightCount(),
      });

      // Retry failed events after delay (exponential backoff)
      setTimeout(() => {
        logger.info('Retrying failed events', { count: failedEvents.length });
        this.syncPending().catch(err => {
          logger.error('Retry syncPending failed', { error: err });
        });
      }, 5000); // 5 second delay before retry
    } else if (validPending.length > 0) {
      logger.info('All pending events sent successfully', {
        count: validPending.length,
        inFlightCount: queue.getInFlightCount(),
      });
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
          await this.handleSessionEstablished(message.payload as SessionEstablished);
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
          await this.handleAck(message.payload as { device_seq: number });
          break;
        case 'pong':
          // Handle heartbeat pong - no action needed, just acknowledges ping
          logger.debug('Received heartbeat pong', { timestamp: Date.now() });
          break;
        case 'pairing_completed':
          logger.info('[WS] Received pairing_completed message', { payload: message.payload });
          await this.handlePairingCompleted(message.payload as { success: boolean; linkedUserId?: string });
          break;
        case 'pairing_failed':
          this.handlePairingFailed(message.payload as { error: string });
          break;
        case 'device_status_changed':
        case 'device_presence':
          this.emitSystem((message.payload || message) as SystemMessage);
          break;
        case 'device_revoked':
          // Device has been revoked by another device - restore original identity
          await this.handleDeviceRevoked(message.payload as { reason?: string; timestamp?: number });
          break;
        case 'error':
          logger.error('Server error', undefined, { payload: message.payload });
          this.handleError(new Error(`Server error: ${JSON.stringify(message.payload)}`));
          break;
        default:
          // Handle gap detection (missing_events_request) - future protocol extension
          if ((message as any).type === 'missing_events_request') {
            await this.handleMissingEventsRequest((message as any).payload as { startSeq: number; endSeq: number });
          } else {
            logger.warn('Unknown message type', { type: message.type });
          }
      }
    } catch (error) {
      logger.error('Failed to parse message', error);
    }
  }

  /**
   * Handle incoming encrypted event
   */
  private async handleIncomingEvent(event: EncryptedEvent): Promise<void> {
    // DEBUG: Log all incoming events
    logger.info('[handleIncomingEvent] Received event', {
      type: event.type,
      eventId: event.event_id,
      deviceId: event.device_id,
      hasSessionKeys: !!this.sessionKeys,
    });

    if (!this.sessionKeys) {
      // Buffer events that arrive before session keys are ready
      // They will be processed once the session is established
      logger.warn('[handleIncomingEvent] No session keys yet, buffering event for later processing', {
        type: event.type,
        eventId: event.event_id,
        bufferSize: this.pendingEventsBuffer.length + 1,
      });
      this.pendingEventsBuffer.push(event);
      return;
    }

    // Store event in local database (encrypted)
    const queue = getEventQueue();
    await queue.enqueue(event);

    // Decrypt payload (if needed by feature handlers)
    // Note: Features handle decryption themselves

    // Notify handlers
    logger.info('[handleIncomingEvent] Notifying handlers', {
      type: event.type,
      handlerCount: this.eventHandlers.length,
    });
    this.eventHandlers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        logger.error('Event handler error', error);
      }
    });

    // Buffer file events so late-mounting pages (e.g., /files) can pick them up
    if (event.type.startsWith('file:')) {
      this.fileEventBuffer.push(event);
      // Cap buffer to prevent unbounded growth
      if (this.fileEventBuffer.length > 200) {
        this.fileEventBuffer = this.fileEventBuffer.slice(-100);
      }
    }

    // Send ACK
    this.send({
      type: 'ack',
      payload: { device_seq: event.device_seq },
    });
  }

  /**
   * Handle acknowledgment from server
   * Updates the queue's lastAckDeviceSeq (single source of truth)
   */
  private async handleAck(ack: { device_seq: number }): Promise<void> {
    // EventQueue is the single source of truth for lastAckDeviceSeq
    const queue = getEventQueue();
    await queue.acknowledge(this.deviceId, ack.device_seq);
  }

  /**
   * Send message via WebSocket
   */
  private send(message: WSMessage): void {
    const wsReady = this.ws && this.ws.readyState === WebSocket.OPEN;
    logger.info('[SEND] send() called', {
      messageType: message.type,
      wsReadyState: this.ws?.readyState ?? 'N/A',
      wsConnected: wsReady,
    });
    
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('[SEND] WebSocket not open, buffering message', {
        hasWs: !!this.ws,
        readyState: this.ws?.readyState ?? 'N/A',
      });
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
      logger.info('[SEND] Calling ws.send() for message type: ' + message.type);
      this.ws.send(JSON.stringify(safeMsg));
      logger.info('[SEND] ws.send() succeeded');
    } catch (err) {
      logger.error('[SEND] WebSocket send failed, buffering for retry', err);
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
      // Send ping message to keep connection alive
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.send({
            type: 'ping',
            payload: { timestamp: Date.now() },
          });
        } catch (error) {
          logger.debug('Heartbeat ping failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
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
   * Fast phase: exponential backoff 3s→30s for first 10 attempts
   * Slow phase: poll every 60s indefinitely until connection is restored
   */
  private scheduleReconnect(): void {
    this.stopReconnect();

    // Only reconnect if the previous WebSocket is fully closed
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      return;
    }

    // Update status to reconnecting
    this.updateStatus('reconnecting');

    let delay: number;
    if (this.reconnectAttempts < this.fastReconnectThreshold) {
      // Fast phase: exponential backoff 3s → 30s
      const baseDelay = WS_RECONNECT_DELAY;
      const minDelay = 1000;
      delay = Math.max(minDelay, Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay));
    } else {
      // Slow phase: poll every 60s, never give up
      delay = this.slowReconnectDelay;
    }

    this.reconnectAttempts++;

    logger.info('[WS] Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delay,
      phase: this.reconnectAttempts <= this.fastReconnectThreshold ? 'fast' : 'slow',
    });

    this.reconnectTimer = setTimeout(() => {
      // Double-check socket is still closed before reconnecting
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.connect();
      }
    }, delay);
  }

  /**
   * Reset handshake retry counter on successful connection
   */
  private resetHandshakeRetries(): void {
    this.handshakeRetries = 0;
  }
  
  /**
   * Handle handshake failure with retry logic
   */
  private handleHandshakeFailure(reason: string): void {
    this.handshakeRetries++;
    
    if (this.handshakeRetries >= this.maxHandshakeRetries) {
      logger.error('Max handshake retries reached', {
        retries: this.handshakeRetries,
        maxRetries: this.maxHandshakeRetries,
        reason,
      });
      
      this.updateStatus('error');
      const error = new Error(
        `Handshake failed after ${this.maxHandshakeRetries} attempts: ${reason}. Please try again later or contact support.`
      );
      this.errorHandlers.forEach(handler => {
        try {
          handler(error);
        } catch (err) {
          logger.error('Error handler error', err);
        }
      });
      
      // Close connection and stop retrying
      if (this.ws) {
        this.ws.close(1008, 'Handshake failed');
      }
      return;
    }
    
    logger.warn('Handshake failed, retrying...', {
      attempt: this.handshakeRetries,
      maxRetries: this.maxHandshakeRetries,
      reason,
    });
    
    // Wait a bit before retrying handshake
    setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendClientHello();
      } else {
        // Connection closed, trigger reconnect
        this.scheduleReconnect();
      }
    }, 2000 * this.handshakeRetries); // Exponential backoff: 2s, 4s, 6s
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
   * Handle device revoked message
   * Restores original identity and reloads the app
   *
   * Note: Device already completed onboarding with its original identity,
   * so we just restore it and reload - no need to onboard again.
   */
  private async handleDeviceRevoked(message: { reason?: string; timestamp?: number }): Promise<void> {
    logger.warn('Device has been revoked', {
      reason: message.reason || 'No reason provided',
      timestamp: message.timestamp,
    });

    // Stop reconnection attempts
    this.stopReconnect();
    this.stopHeartbeat();

    // Clear session state
    this.sessionKeys = null;
    this.handshakeState = {};

    // Restore original identity or generate new one
    try {
      const { restoreOrGenerateIdentity } = await import('@/lib/crypto/keys');
      const restoredIdentity = await restoreOrGenerateIdentity();
      this.userId = restoredIdentity.publicKeyHex;
      this.identityKeyPair = restoredIdentity;

      logger.info('Identity restored after revocation', {
        newUserId: this.userId.substring(0, 16) + '...',
      });
    } catch (error) {
      logger.error('Failed to restore identity after revocation', error);
    }

    // Clear event queue (remove events from the paired identity)
    // This clears events that were encrypted with the shared identity
    try {
      const queue = getEventQueue();
      await queue.clear();
      logger.info('Event queue cleared after revocation');
    } catch (error) {
      logger.error('Failed to clear event queue after revocation', error);
    }

    // Clear cached user profile so it gets re-fetched for the restored identity
    // The original identity's profile still exists on the server
    try {
      const { clearUserProfile } = await import('@/lib/utils/user-profile');
      clearUserProfile();
      logger.info('Cached user profile cleared (will re-fetch for restored identity)');
    } catch (error) {
      logger.error('Failed to clear cached user profile after revocation', error);
    }

    // Emit system message for UI updates
    this.emitSystem({
      type: 'device_revoked',
      payload: {
        reason: message.reason || 'Device has been removed',
        timestamp: message.timestamp || Date.now(),
      },
    });

    // Update status to disconnected
    this.updateStatus('disconnected');

    // Close WebSocket connection
    if (this.ws) {
      this.ws.close(1000, 'Device revoked');
      this.ws = null;
    }

    // Reload the page to re-initialize with restored identity
    // The app will fetch the profile for the original identity from the server
    // (which already has onboardingCompleted = true)
    if (typeof window !== 'undefined') {
      setTimeout(() => {
        logger.info('Reloading app after device revocation to use restored identity');
        window.location.reload();
      }, 500);
    }
  }

  /**
   * Handle pairing completed message
   */
  private async handlePairingCompleted(message: { success: boolean; linkedUserId?: string }): Promise<void> {
    if (message.success && message.linkedUserId) {
      logger.info('Pairing completed successfully', {
        linkedUserId: message.linkedUserId.substring(0, 16) + '...',
      });

      // Update local userId to match the linked account
      // This is critical - the backend has already updated sessionState.userId
      // so we need to match it on the client side
      this.userId = message.linkedUserId;

      // CRITICAL: Reset event queue and sequence counters
      // The server has reset last_ack_device_seq to 0 in the database,
      // so we must reset our local counters to prevent "Device sequence not monotonic" errors
      // EventQueue.reset() handles all state (it's the single source of truth)
      const queue = getEventQueue();
      await queue.reset();
      logger.info('Reset event queue after pairing', { linkedUserId: message.linkedUserId.substring(0, 16) + '...' });

      // Emit system message for UI updates
      this.emitSystem({
        type: 'pairing_completed',
        payload: {
          success: true,
          linkedUserId: message.linkedUserId,
        },
      });
    } else {
      logger.error('Pairing completed but no linkedUserId provided', { message });
    }
  }

  /**
   * Handle pairing failed message
   */
  private handlePairingFailed(message: { error: string }): void {
    logger.error('Pairing failed', undefined, { error: message.error });

    this.emitSystem({
      type: 'pairing_failed',
      payload: {
        error: message.error,
      },
    });

    this.handleError(new Error(`Pairing failed: ${message.error}`));
  }

  /**
   * Handle missing events request from server (gap detection)
   * Server detected a gap in sequence numbers and is requesting missing events
   */
  private async handleMissingEventsRequest(request: {
    startSeq: number;
    endSeq: number;
  }): Promise<void> {
    logger.warn('[GAP] Server detected sequence gap, requesting missing events', {
      startSeq: request.startSeq,
      endSeq: request.endSeq,
      gap: request.endSeq - request.startSeq + 1,
    });

    try {
      const { getEventsBySequenceRange } = await import('@/lib/sync');

      // Get events in the requested range from local storage
      const missingEvents = await getEventsBySequenceRange(
        this.deviceId,
        request.startSeq,
        request.endSeq
      );

      if (missingEvents.length === 0) {
        logger.error('[GAP] No events found in requested range - possible data loss', {
          startSeq: request.startSeq,
          endSeq: request.endSeq,
        });
        return;
      }

      logger.info('[GAP] Resending missing events to fill gap', {
        count: missingEvents.length,
        sequences: missingEvents.map(e => e.device_seq),
      });

      // Mark events as in-flight before resending
      const queue = getEventQueue();
      for (const event of missingEvents) {
        queue.markInFlight(event.event_id);
      }

      // Resend each missing event
      for (const event of missingEvents) {
        try {
          await this.sendEvent(event);
          logger.debug('[GAP] Resent event', {
            eventId: event.event_id.substring(0, 8),
            deviceSeq: event.device_seq,
          });
        } catch (error) {
          logger.error('[GAP] Failed to resend event', {
            eventId: event.event_id,
            deviceSeq: event.device_seq,
            error,
          });
          // Clear from in-flight on error
          queue.clearInFlight(event.event_id);
        }
      }

      logger.info('[GAP] Finished resending missing events', {
        requested: request.endSeq - request.startSeq + 1,
        found: missingEvents.length,
        sent: missingEvents.length,
      });
    } catch (error) {
      logger.error('[GAP] Failed to handle missing events request', {
        startSeq: request.startSeq,
        endSeq: request.endSeq,
        error,
      });
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
    // EventQueue.clear() calls reset() internally which handles lastAckDeviceSeq
    const queue = getEventQueue();
    queue.clear().then(() => {
      logger.info('Local state cleared, reconnecting');
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
    this.pendingEventsBuffer = []; // Clear buffered events on disconnect
    
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

  private emitSystem(message: SystemMessage): void {
    this.systemHandlers.forEach(handler => {
      try {
        handler(message);
      } catch (error) {
        logger.error('System handler error', error);
      }
    });
  }

  /**
   * Consume buffered file events (returns and clears the buffer).
   * Call this when a file-handling page mounts to pick up events
   * that arrived while the page was not mounted.
   */
  consumeBufferedFileEvents(): EncryptedEvent[] {
    const events = [...this.fileEventBuffer];
    this.fileEventBuffer = [];
    return events;
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

  onSystem(handler: SystemHandler): () => void {
    this.systemHandlers.push(handler);
    return () => {
      this.systemHandlers = this.systemHandlers.filter(h => h !== handler);
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

  /**
   * Get session expiration timestamp
   */
  getSessionExpiresAt(): number | null {
    return this.sessionExpiresAt;
  }
}

/**
 * Singleton WebSocket client instance
 */
let clientInstance: WebSocketClient | null = null;
let lastUrl: string | null = null;
let lastDeviceId: string | null = null;

export function getWebSocketClient(url?: string, deviceId?: string): WebSocketClient {
  // Resolve defaults when not provided (background jobs, hooks)
  const resolvedUrl = url || config.wsUrl;
  const resolvedDeviceId = deviceId || getOrCreateDeviceId();

  // If URL or deviceId changed, recreate the client
  if (clientInstance && (resolvedUrl !== lastUrl || resolvedDeviceId !== lastDeviceId)) {
    logger.info('WebSocket client parameters changed, creating new instance', { 
      oldUrl: lastUrl?.substring(0, 30), 
      newUrl: resolvedUrl?.substring(0, 30),
      oldDeviceId: lastDeviceId?.substring(0, 8),
      newDeviceId: resolvedDeviceId?.substring(0, 8),
    });
    clientInstance.disconnect();
    clientInstance = null;
  }

  if (!clientInstance) {
    clientInstance = new WebSocketClient(resolvedUrl, resolvedDeviceId);
    lastUrl = resolvedUrl;
    lastDeviceId = resolvedDeviceId;
  }

  return clientInstance;
}
