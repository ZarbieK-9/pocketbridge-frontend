/**
 * HMAC-SHA256 utilities for message integrity
 * Provides authentication and integrity verification
 */

/**
 * Compute HMAC-SHA256 for a message
 * Returns base64-encoded HMAC
 */
export async function computeHMAC(message: string, key: CryptoKey): Promise<string> {
  const messageBuffer = new TextEncoder().encode(message)

  // Import key for HMAC if it's an AES key
  let hmacKey: CryptoKey
  try {
    // Export the AES key and re-import as HMAC key
    const keyBuffer = await crypto.subtle.exportKey("raw", key)
    hmacKey = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["sign", "verify"],
    )
  } catch {
    // If key is already an HMAC key, use it directly
    hmacKey = key
  }

  // Compute HMAC
  const hmacBuffer = await crypto.subtle.sign("HMAC", hmacKey, messageBuffer)

  return bufferToBase64(hmacBuffer)
}

/**
 * Verify HMAC-SHA256 for a message
 * Returns true if HMAC is valid
 */
export async function verifyHMAC(message: string, hmac: string, key: CryptoKey): Promise<boolean> {
  const messageBuffer = new TextEncoder().encode(message)
  const hmacBuffer = base64ToBuffer(hmac)

  // Import key for HMAC if it's an AES key
  let hmacKey: CryptoKey
  try {
    const keyBuffer = await crypto.subtle.exportKey("raw", key)
    hmacKey = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["sign", "verify"],
    )
  } catch {
    hmacKey = key
  }

  try {
    return await crypto.subtle.verify("HMAC", hmacKey, hmacBuffer, messageBuffer)
  } catch (error) {
    console.error("[PocketBridge] HMAC verification failed:", error)
    return false
  }
}

/**
 * Convert ArrayBuffer to Base64 string
 */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Convert Base64 string to ArrayBuffer
 */
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
