/**
 * User Profile API Client
 * 
 * Client-side utilities for interacting with user profile API
 * Includes signature generation for secure profile updates
 */

import { signEd25519, loadIdentityKeyPair } from '@/lib/crypto/keys';
import { getBackendApiUrl } from './pairing-code';
import { logger } from './logger';
import type { UserProfile } from './user-profile';

/**
 * Hash data for signature (must match backend)
 */
async function hashForSignature(...parts: string[]): Promise<string> {
  // Use Web Crypto API for SHA-256
  const encoder = new TextEncoder();
  const combined = parts.join('');
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(combined));
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Server response type (snake_case)
 */
interface ServerUserProfile {
  user_id: string;
  display_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  preferences?: Record<string, any>;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
  last_seen: string;
}

/**
 * Get user profile from server
 */
export async function fetchUserProfile(userId: string): Promise<ServerUserProfile | null> {
  try {
    const apiUrl = getBackendApiUrl();
    const response = await fetch(`${apiUrl}/api/user/profile`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-User-ID': userId,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch profile: ${response.statusText}`);
    }

    const data = await response.json();
    // Backend returns { profile: {...} } or just the profile object
    const profile = (data.profile || data) as ServerUserProfile;
    return profile;
  } catch (error) {
    logger.error('Failed to fetch user profile', error);
    return null;
  }
}

/**
 * Update user profile with signature verification
 */
export async function updateUserProfileOnServer(
  updates: Partial<Pick<UserProfile, 'displayName' | 'email' | 'preferences'>>,
  userId: string
): Promise<ServerUserProfile | null> {
  try {
    const identityKeyPair = await loadIdentityKeyPair();
    if (!identityKeyPair) {
      throw new Error('Identity keypair not found. Initialize crypto first.');
    }

    // Convert camelCase to snake_case for server
    const serverUpdates: Record<string, any> = {};
    if (updates.displayName !== undefined) {
      serverUpdates.display_name = updates.displayName;
    }
    if (updates.email !== undefined) {
      serverUpdates.email = updates.email;
    }
    if (updates.preferences !== undefined) {
      serverUpdates.preferences = updates.preferences;
    }

    // Generate timestamp right before creating signature (to minimize time gap)
    const timestamp = Date.now();

    // Create signature data: SHA256(user_id || timestamp || JSON.stringify(updates))
    const signatureDataHex = await hashForSignature(
      userId,
      timestamp.toString(),
      JSON.stringify(serverUpdates)
    );

    // Sign with private key
    const signature = await signEd25519(identityKeyPair.privateKey, signatureDataHex);
    const signatureHex = typeof signature === 'string' 
      ? signature 
      : Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');

    // Send request immediately after generating signature (timestamp is still fresh)
    const apiUrl = getBackendApiUrl();
    const response = await fetch(`${apiUrl}/api/user/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-ID': userId,
      },
      body: JSON.stringify({
        ...serverUpdates,
        signature: signatureHex,
        timestamp,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `Failed to update profile: ${response.statusText}`);
    }

    const data = await response.json();
    return data.profile as ServerUserProfile;
  } catch (error) {
    logger.error('Failed to update user profile on server', error);
    throw error;
  }
}

/**
 * Mark onboarding as completed with signature verification
 */
export async function markOnboardingCompleteOnServer(userId: string): Promise<boolean> {
  try {
    const identityKeyPair = await loadIdentityKeyPair();
    if (!identityKeyPair) {
      throw new Error('Identity keypair not found. Initialize crypto first.');
    }

    // Generate timestamp right before creating signature
    const timestamp = Date.now();

    // Create signature data: SHA256(user_id || timestamp || "onboarding_complete")
    const signatureDataHex = await hashForSignature(
      userId,
      timestamp.toString(),
      'onboarding_complete'
    );

    // Sign with private key
    const signature = await signEd25519(identityKeyPair.privateKey, signatureDataHex);
    const signatureHex = typeof signature === 'string' 
      ? signature 
      : Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');

    // Send request immediately after generating signature
    const apiUrl = getBackendApiUrl();
    const response = await fetch(`${apiUrl}/api/user/profile/onboarding-complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-ID': userId,
      },
      body: JSON.stringify({
        signature: signatureHex,
        timestamp,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `Failed to mark onboarding complete: ${response.statusText}`);
    }

    return true;
  } catch (error) {
    logger.error('Failed to mark onboarding complete on server', error);
    throw error;
  }
}

