/**
 * User Profile Management
 * 
 * Stores and retrieves user profile data for persistent user experience
 * Profile is tied to identity keypair (user_id = publicKeyHex)
 * 
 * SECURITY: Profile updates require Ed25519 signature verification on the server
 * to prevent unauthorized modifications.
 */

import { STORAGE_KEYS } from '@/lib/constants';
import type { Ed25519KeyPair } from '@/types';
import { fetchUserProfile, updateUserProfileOnServer, markOnboardingCompleteOnServer } from './user-profile-api';
import { logger } from './logger';

export interface UserProfile {
  userId: string; // Ed25519 public key (hex) - primary identifier
  displayName?: string; // User's display name
  email?: string; // Optional email
  avatar?: string; // Optional avatar URL or data
  preferences?: {
    theme?: 'light' | 'dark' | 'auto';
    notifications?: boolean;
    autoSync?: boolean;
  };
  createdAt: number; // Timestamp when profile was created
  lastSeen: number; // Timestamp of last activity
  deviceCount?: number; // Number of devices (synced from backend)
  onboardingCompleted: boolean; // Whether user completed onboarding
}

const PROFILE_STORAGE_KEY = 'pocketbridge_user_profile';

/**
 * Save user profile to localStorage
 */
export function saveUserProfile(profile: UserProfile): void {
  if (typeof window === 'undefined') return;
  
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch (error) {
    console.error('[UserProfile] Failed to save profile:', error);
  }
}

/**
 * Load user profile from localStorage
 */
export function loadUserProfile(): UserProfile | null {
  if (typeof window === 'undefined') return null;
  
  try {
    const profileStr = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!profileStr) return null;
    
    const profile = JSON.parse(profileStr) as UserProfile;
    return profile;
  } catch (error) {
    console.error('[UserProfile] Failed to load profile:', error);
    return null;
  }
}

/**
 * Get or create user profile from identity keypair
 * 
 * SECURITY: Attempts to fetch profile from server first to ensure consistency.
 * Falls back to local storage if server is unavailable.
 */
export async function getOrCreateUserProfile(identityKeyPair: Ed25519KeyPair): Promise<UserProfile> {
  const userId = identityKeyPair.publicKeyHex;
  
    // Try to fetch from server first (authoritative source)
    try {
      const serverProfile = await fetchUserProfile(userId);
      if (serverProfile) {
        // Server returns snake_case, convert to camelCase for local storage
        const localProfile: UserProfile = {
          userId: serverProfile.user_id || userId,
          displayName: serverProfile.display_name || undefined,
          email: serverProfile.email || undefined,
          preferences: serverProfile.preferences || {},
          createdAt: new Date(serverProfile.created_at).getTime(),
          lastSeen: new Date(serverProfile.last_seen).getTime(),
          onboardingCompleted: serverProfile.onboarding_completed || false,
        };
        saveUserProfile(localProfile);
        return localProfile;
      }
    } catch (error) {
      // Network errors are expected when offline - don't log as warning
      const isNetworkError = error instanceof TypeError && 
        (error.message.includes('fetch') || 
         error.message.includes('NetworkError') ||
         error.message.includes('Failed to fetch'));
      
      if (!isNetworkError) {
        logger.warn('Failed to fetch profile from server, using local storage', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Silently fall back to local storage for network errors
    }

  // Fallback to local storage
  const existing = loadUserProfile();
  
  // If profile exists and matches current user, return it
  if (existing && existing.userId === userId) {
    // Update last seen
    existing.lastSeen = Date.now();
    saveUserProfile(existing);
    return existing;
  }
  
  // Create new profile
  const newProfile: UserProfile = {
    userId,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    onboardingCompleted: false,
  };
  
  saveUserProfile(newProfile);
  return newProfile;
}

/**
 * Update user profile
 * 
 * SECURITY: Updates are synced to server with Ed25519 signature verification.
 * Local storage is updated immediately, server sync happens in background.
 */
export async function updateUserProfile(
  updates: Partial<Omit<UserProfile, 'userId' | 'createdAt' | 'lastSeen'>>,
  userId: string
): Promise<void> {
  // Ensure profile exists before updating
  let existing = loadUserProfile();
  if (!existing || existing.userId !== userId) {
    // Create profile if it doesn't exist
    existing = {
      userId,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      onboardingCompleted: false,
    };
    saveUserProfile(existing);
  }
  
  // Filter out lastSeen - it's not a valid update field (updated automatically on server)
  const validUpdates = { ...updates };
  delete (validUpdates as any).lastSeen;
  
  // If no valid updates after filtering, skip server sync
  if (Object.keys(validUpdates).length === 0) {
    // Only update lastSeen locally
    const updated: UserProfile = {
      ...existing,
      lastSeen: Date.now(),
    };
    saveUserProfile(updated);
    return;
  }
  
  // Update local storage immediately
  const updated: UserProfile = {
    ...existing,
    ...validUpdates,
    lastSeen: Date.now(),
  };
  
  saveUserProfile(updated);

  // Sync to server with signature verification (non-blocking)
  try {
    await updateUserProfileOnServer(validUpdates, userId);
    logger.info('User profile synced to server', { userId: userId.substring(0, 16) + '...' });
  } catch (error) {
    logger.error('Failed to sync profile to server', error);
    // Non-blocking: local update still succeeds
  }
}

/**
 * Check if user has completed onboarding
 */
export function hasCompletedOnboarding(userId: string): boolean {
  const profile = loadUserProfile();
  return profile?.userId === userId && profile?.onboardingCompleted === true;
}

/**
 * Mark onboarding as completed
 * 
 * SECURITY: Requires signature verification on server
 */
export async function completeOnboarding(userId: string): Promise<void> {
  // Ensure profile exists before marking as complete
  let existing = loadUserProfile();
  if (!existing || existing.userId !== userId) {
    // Create profile if it doesn't exist
    existing = {
      userId,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      onboardingCompleted: false,
    };
  }
  
  // Update local storage
  existing.onboardingCompleted = true;
  existing.lastSeen = Date.now();
  saveUserProfile(existing);

  // Sync to server with signature verification (non-blocking)
  try {
    await markOnboardingCompleteOnServer(userId);
    logger.info('Onboarding completion synced to server', { userId: userId.substring(0, 16) + '...' });
  } catch (error) {
    logger.error('Failed to sync onboarding completion to server', error);
    // Non-blocking: local update still succeeds
    throw error; // Re-throw so caller knows server sync failed
  }
}

/**
 * Clear user profile (for logout/account switch)
 */
export function clearUserProfile(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(PROFILE_STORAGE_KEY);
}

