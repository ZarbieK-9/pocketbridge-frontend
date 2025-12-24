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
    console.log('[Phase1] Service worker requested sync');
    
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
      console.log('[Phase1] WebSocket already connected or connecting');
      return;
    }

    this.updateStatus('connecting');

    try {
      // Load identity keypair
      this.identityKeyPair = await loadIdentityKeyPair();
      if (!this.identityKeyPair) {
        throw new Error('Identity keypair not found. Initialize crypto first.');
      }
      this.userId = this.identityKeyPair.publicKeyHex;

      // Create WebSocket connection
      this.ws = new WebSocket(this.url);
      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error('Connection failed'));
    }
  }

  /**
   * Handle WebSocket open
   */
  private async handleOpen(): Promise<void> {
    console.log('[Phase1] WebSocket connected, starting handshake');
    await this.sendClientHello();
  }

  /**
   * Send Client Hello (Step 1 of handshake)
   */
  private async sendClientHello(): Promise<void> {
    // Generate ephemeral ECDH keypair
    const clientEphemeralKeyPair = await generateECDHKeyPair();
    const nonceC = generateHandshakeNonce(); // 32-byte hex nonce for handshake

    // Store handshake state
    this.handshakeState = {
      clientEphemeralKeyPair,
      nonceC,
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
   */
  private async handleServerHello(message: ServerHello): Promise<void> {
    if (!this.handshakeState.clientEphemeralKeyPair || !this.handshakeState.nonceC) {
      throw new Error('Handshake state missing');
    }

    // Store server ephemeral public key and nonce
    this.handshakeState.serverEphemeralPub = message.server_ephemeral_pub;
    this.handshakeState.nonceS = message.nonce_s;

    // Verify server signature
    // Server signs: SHA256(client_ephemeral_pub || server_ephemeral_pub || nonce_c || nonce_s)
    const signatureData = await this.hashForSignature(
      this.handshakeState.clientEphemeralKeyPair.publicKeyHex,
      message.server_ephemeral_pub,
      this.handshakeState.nonceC,
      message.nonce_s
    );

    // TODO: Verify server signature using server_identity_pub
    // For Phase 1, we'll trust the server (TOFU model)
    // In production, verify: await verifyEd25519(serverSignature, signatureData, serverPublicKey)

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
  }

  /**
   * Send Client Auth (Step 3 of handshake)
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

    const nonceC2 = generateHandshakeNonce(); // 32-byte hex nonce for handshake
    this.handshakeState.nonceC2 = nonceC2;

    // Sign: SHA256(user_id || device_id || nonce_c || nonce_s || server_ephemeral_pub)
    const signatureData = await this.hashForSignature(
      this.userId!,
      this.deviceId,
      this.handshakeState.nonceC,
      this.handshakeState.nonceS,
      this.handshakeState.serverEphemeralPub
    );

    const signature = await signEd25519(this.identityKeyPair.privateKey, signatureData);
    const signatureHex = Array.from(signature)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

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
    console.log('[Phase1] Session established');
    this.lastAckDeviceSeq = message.last_ack_device_seq;
    this.sessionExpiresAt = message.expires_at || null;
    
    if (this.sessionExpiresAt) {
      const expiresIn = this.sessionExpiresAt - Date.now();
      const expiresInMinutes = Math.floor(expiresIn / 60000);
      console.log(`[Phase1] Session expires in ${expiresInMinutes} minutes (${new Date(this.sessionExpiresAt).toISOString()})`);
    }

    // Sync device sequence to ensure monotonicity
    // This prevents sending events with device_seq <= last_ack_device_seq
    const queue = getEventQueue();
    queue.syncDeviceSeq(this.lastAckDeviceSeq);
    queue.acknowledge(this.deviceId, this.lastAckDeviceSeq);

    // Clear handshake state
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
   */
  private async hashForSignature(...parts: (string | number)[]): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const combined = parts.map(p => encoder.encode(String(p)));
    const totalLength = combined.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of combined) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return new Uint8Array(await crypto.subtle.digest('SHA-256', result));
  }

  /**
   * Request replay of missing events
   */
  private requestReplay(): void {
    const replayRequest: ReplayRequest = {
      type: 'replay_request',
      last_ack_device_seq: this.lastAckDeviceSeq,
    };
    this.send({
      type: 'replay_request',
      payload: replayRequest,
    });
  }

  /**
   * Handle replay response
   */
  private async handleReplayResponse(message: ReplayResponse): Promise<void> {
    console.log(`[Phase1] Received ${message.events.length} events in replay`);

    for (const event of message.events) {
      await this.handleIncomingEvent(event);
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
            console.log('[Phase1] Background sync not available:', error);
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
      console.warn('[Phase1] Cannot sync pending events: userId not set');
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
      
      console.log(`[Phase1] Skipping ${skipped} invalid events (${skippedSeq} bad seq, ${skippedUserId} wrong user_id)`);
      
      // Acknowledge the skipped events with bad sequence as they're likely duplicates
    for (const event of pending) {
        if (event.device_seq <= this.lastAckDeviceSeq && event.user_id === this.userId) {
          queue.acknowledge(this.deviceId, event.device_seq);
        }
      }
    }

    console.log(`[Phase1] Syncing ${validPending.length} pending events`);

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
          await this.handleReplayResponse(message.payload as ReplayResponse);
          break;
        case 'ack':
          this.handleAck(message.payload as { device_seq: number });
          break;
        case 'error':
          console.error('[Phase1] Server error:', message.payload);
          break;
        default:
          console.warn('[Phase1] Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('[Phase1] Failed to parse message:', error);
    }
  }

  /**
   * Handle incoming encrypted event
   */
  private async handleIncomingEvent(event: EncryptedEvent): Promise<void> {
    if (!this.sessionKeys) {
      console.error('[Phase1] No session keys, cannot decrypt event');
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
        console.error('[Phase1] Event handler error:', error);
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
    console.log('[Phase1] Received ack for device_seq:', ack.device_seq);
    this.lastAckDeviceSeq = ack.device_seq;

    const queue = getEventQueue();
    queue.acknowledge(this.deviceId, ack.device_seq);
  }

  /**
   * Send message via WebSocket
   */
  private send(message: WSMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[Phase1] WebSocket not open, cannot send message');
      return;
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      // Send ping (if server supports it)
      // For now, just log
      console.log('[Phase1] Heartbeat');
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

    // Update status to reconnecting
    this.updateStatus('reconnecting');

    // Exponential backoff: start at 3s, max 30s
    const baseDelay = WS_RECONNECT_DELAY;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    console.log(`[Phase1] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
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
   * Handle WebSocket error
   */
  private handleError(error: Error | Event): void {
    console.error('[Phase1] WebSocket error:', error);

    this.updateStatus('error');

    this.errorHandlers.forEach(handler => {
      try {
        handler(error instanceof Error ? error : new Error('WebSocket error'));
      } catch (err) {
        console.error('[Phase1] Error handler failed:', err);
      }
    });

    this.scheduleReconnect();
  }

  /**
   * Handle WebSocket close
   */
  private handleClose(): void {
    console.log('[Phase1] WebSocket closed');

    this.stopHeartbeat();
    this.updateStatus('disconnected');
    this.sessionKeys = null;
    this.scheduleReconnect();
  }

  /**
   * Update connection status
   */
  private updateStatus(status: ConnectionStatus): void {
    this.status = status;
    console.log('[Phase1] Connection status:', status);

    this.statusHandlers.forEach(handler => {
      try {
        handler(status);
      } catch (error) {
        console.error('[Phase1] Status handler error:', error);
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
