/**
 * Pairing code utilities
 * Generates and parses 6-digit pairing codes
 * Includes identity keypair for cross-device encryption
 */

import { getWsUrl } from './storage';

export interface PairingData {
  wsUrl: string;
  userId: string;
  deviceId: string;
  deviceName: string;
  publicKeyHex: string;
  privateKeyHex: string;
}

/**
 * Get the backend API URL
 */
function getBackendApiUrl(): string {
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  }
  
  // First try explicit API URL env var
  if (process.env.NEXT_PUBLIC_API_URL) {
    console.log('[Pairing] Using NEXT_PUBLIC_API_URL:', process.env.NEXT_PUBLIC_API_URL);
    return process.env.NEXT_PUBLIC_API_URL;
  }
  
  // Try to get from storage utility or use default
  const wsUrl = getWsUrl() || process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001/ws';
  // Convert WebSocket URL to HTTP URL
  // Handle: ws://host:port/ws -> http://host:port
  // Handle: wss://host:port/ws -> https://host:port
  let httpUrl = wsUrl.replace(/^ws(s?):\/\//, 'http$1://');
  // Remove trailing /ws if present
  httpUrl = httpUrl.replace(/\/ws\/?$/, '');
  // Remove trailing slash
  httpUrl = httpUrl.replace(/\/$/, '');
  
  const apiUrl = httpUrl || 'http://localhost:3001';
  
  console.log('[Pairing] Backend API URL derived:', { 
    wsUrl, 
    httpUrl, 
    apiUrl,
    hasWsUrlStorage: !!getWsUrl(),
    envWsUrl: process.env.NEXT_PUBLIC_WS_URL,
    envApiUrl: process.env.NEXT_PUBLIC_API_URL
  });
  return apiUrl;
}

/**
 * Generate a 6-digit pairing code from connection data
 * Stores the code on the backend server
 * Returns code and expiration time
 */
export async function generatePairingCode(data: PairingData): Promise<{ code: string; expiresAt: Date }> {
  // Generate a random 6-digit code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  
  // Store on backend
  const apiUrl = getBackendApiUrl();
  const fullUrl = `${apiUrl}/api/pairing/store`;
  console.log('[Pairing] Storing pairing code on backend:', { apiUrl, fullUrl, code });
  
      try {
        // Add authentication header - use userId (public key hex) as X-User-ID
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        
        // Add X-User-ID header for authentication
        if (data.userId) {
          headers['X-User-ID'] = data.userId;
        }
        
        const response = await fetch(fullUrl, {
          method: 'POST',
          headers,
          mode: 'cors', // Explicitly set CORS mode
          body: JSON.stringify({
        code,
        data: {
          wsUrl: data.wsUrl,
          userId: data.userId,
          deviceId: data.deviceId,
          deviceName: data.deviceName,
          publicKeyHex: data.publicKeyHex,
          privateKeyHex: data.privateKeyHex,
        },
      }),
    });

    console.log('[Pairing] Response status:', response.status, response.statusText);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Pairing] API error response:', errorText);
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: errorText || 'Unknown error' };
      }
      throw new Error(errorData.error || `Failed to store pairing code: ${response.statusText}`);
    }

    const result = await response.json();
    console.log('[Pairing] Pairing code stored on backend:', code, result);
    
    // Return code with expiration time
    const expiresAt = result.expiresAt ? new Date(result.expiresAt) : new Date(Date.now() + 10 * 60 * 1000);
    return { code, expiresAt };
  } catch (error) {
    console.error('[Pairing] Failed to store pairing code on backend:', error);
    console.error('[Pairing] Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      apiUrl,
      fullUrl,
    });
    if (error instanceof TypeError && (error.message.includes('fetch') || error.message.includes('Failed to fetch'))) {
      throw new Error(`Network error: Cannot connect to backend at ${apiUrl}. Is the backend running? Check console for CORS errors.`);
    }
    throw error;
  }
}

/**
 * Parse a pairing code to get connection data
 * Retrieves the code from the backend server
 * Returns null if code is invalid or expired
 * Automatically saves identity keypair if present
 */
export async function parsePairingCode(code: string): Promise<PairingData | null> {
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    return null;
  }

  // Retrieve from backend
  const apiUrl = getBackendApiUrl();
  const fullUrl = `${apiUrl}/api/pairing/lookup/${code}`;
  console.log('[Pairing] Looking up pairing code on backend:', { apiUrl, fullUrl, code });
  
      try {
        const response = await fetch(fullUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
          mode: 'cors', // Explicitly set CORS mode
        });

    console.log('[Pairing] Lookup response status:', response.status, response.statusText);
    
    if (!response.ok) {
      if (response.status === 404) {
        console.warn('[Pairing] Pairing code not found or expired:', code);
        return null;
      }
      const errorText = await response.text();
      console.error('[Pairing] API error response:', errorText);
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: errorText || 'Unknown error' };
      }
      throw new Error(errorData.error || `Failed to lookup pairing code: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.success || !result.data) {
      return null;
    }

    const pairingData: PairingData = {
      wsUrl: result.data.wsUrl,
      userId: result.data.userId,
      deviceId: result.data.deviceId,
      deviceName: result.data.deviceName,
      publicKeyHex: result.data.publicKeyHex,
      privateKeyHex: result.data.privateKeyHex,
    };

    // If identity keypair is present, save it
    if (pairingData.privateKeyHex && pairingData.publicKeyHex) {
      const { saveIdentityKeyPair } = await import('@/lib/crypto/keys');
      const { loadIdentityKeyPair } = await import('@/lib/crypto/keys');
      
      // Check if we already have an identity keypair
      const existing = await loadIdentityKeyPair();
      
      // Only save if we don't have one, or if it's different (user wants to switch accounts)
      if (!existing || existing.publicKeyHex !== pairingData.publicKeyHex) {
        await saveIdentityKeyPair({
          publicKey: new Uint8Array(
            pairingData.publicKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
          ),
          privateKey: new Uint8Array(
            pairingData.privateKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
          ),
          publicKeyHex: pairingData.publicKeyHex,
          privateKeyHex: pairingData.privateKeyHex,
        });
        console.log('[Pairing] Identity keypair saved from pairing code');
      }
    }
    
    return pairingData;
  } catch (error) {
    console.error('[Pairing] Failed to parse pairing code:', error);
    console.error('[Pairing] Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      apiUrl,
      fullUrl,
      code,
    });
    if (error instanceof TypeError && (error.message.includes('fetch') || error.message.includes('Failed to fetch'))) {
      console.error('[Pairing] Network error - backend may not be running or CORS issue');
      console.error('[Pairing] Attempting to diagnose the issue...');
      
      // Try to fetch the health endpoint to see if backend is reachable
      try {
        const healthUrl = `${apiUrl}/health`;
        console.log('[Pairing] Testing backend connectivity at:', healthUrl);
        const healthResponse = await fetch(healthUrl, { 
          method: 'GET',
          mode: 'cors',
        });
        console.log('[Pairing] Health check response:', {
          status: healthResponse.status,
          statusText: healthResponse.statusText,
          ok: healthResponse.ok,
        });
        if (healthResponse.ok) {
          throw new Error(`Backend is reachable but pairing API failed. Check CORS configuration. Backend URL: ${apiUrl}`);
        }
      } catch (healthError) {
        console.error('[Pairing] Health check also failed:', healthError);
      }
      
      throw new Error(`Network error: Cannot connect to backend at ${apiUrl}. Is the backend running? Check console for CORS errors.`);
    }
    throw error;
  }
}

/**
 * Generate a simple 6-digit code (for display/testing)
 * In production, this would be generated server-side
 */
export function generateSimpleCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

