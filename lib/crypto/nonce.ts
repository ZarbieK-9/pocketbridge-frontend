/**
 * Nonce generation and replay protection
 * Generates cryptographically secure 96-bit nonces for AES-GCM
 */

import { NONCE_LENGTH } from "@/lib/constants"

/**
 * Generate a cryptographically secure 96-bit nonce for AES-GCM encryption
 * Returns base64-encoded nonce string (12 bytes = 96 bits)
 */
export function generateNonce(): string {
  const nonceBuffer = new Uint8Array(NONCE_LENGTH)
  crypto.getRandomValues(nonceBuffer)

  // Convert to base64
  let binary = ""
  for (let i = 0; i < nonceBuffer.length; i++) {
    binary += String.fromCharCode(nonceBuffer[i])
  }
  return btoa(binary)
}

/**
 * Generate a cryptographically secure 32-byte nonce for handshake protocol
 * Returns hex-encoded nonce string (32 bytes = 256 bits = 64 hex chars)
 * This is used for WebSocket handshake, not for encryption
 */
export function generateHandshakeNonce(): string {
  const nonceBuffer = new Uint8Array(32) // 32 bytes for handshake
  crypto.getRandomValues(nonceBuffer)

  // Convert to hex
  return Array.from(nonceBuffer)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Nonce registry for replay protection
 * Tracks used nonces within a time window
 */
export class NonceRegistry {
  private usedNonces: Set<string>
  private nonceTimestamps: Map<string, number>
  private readonly maxAge: number // milliseconds

  constructor(maxAge = 3600000) {
    // Default 1 hour
    this.usedNonces = new Set()
    this.nonceTimestamps = new Map()
    this.maxAge = maxAge
  }

  /**
   * Check if a nonce has been used recently
   */
  hasUsed(nonce: string): boolean {
    this.cleanup()
    return this.usedNonces.has(nonce)
  }

  /**
   * Mark a nonce as used
   */
  markUsed(nonce: string): void {
    this.usedNonces.add(nonce)
    this.nonceTimestamps.set(nonce, Date.now())
  }

  /**
   * Remove expired nonces from registry
   */
  private cleanup(): void {
    const now = Date.now()
    const expiredNonces: string[] = []

    this.nonceTimestamps.forEach((timestamp, nonce) => {
      if (now - timestamp > this.maxAge) {
        expiredNonces.push(nonce)
      }
    })

    expiredNonces.forEach((nonce) => {
      this.usedNonces.delete(nonce)
      this.nonceTimestamps.delete(nonce)
    })
  }

  /**
   * Clear all nonces
   */
  clear(): void {
    this.usedNonces.clear()
    this.nonceTimestamps.clear()
  }

  /**
   * Get current nonce count
   */
  size(): number {
    this.cleanup()
    return this.usedNonces.size
  }
}
