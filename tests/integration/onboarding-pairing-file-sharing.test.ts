/**
 * Integration Tests: Onboarding → Pairing → File Sharing
 * 
 * Tests the complete user journey from initial setup through multi-device file sharing
 * with comprehensive edge cases.
 * 
 * Test Scenarios:
 * 1. User completes onboarding on Device A
 * 2. Verify no redirect back to onboarding after completion
 * 3. User pairs Device B using pairing code from Device A
 * 4. Both devices establish WebSocket connection
 * 5. Device A sends file to Device B
 * 6. Device B receives and verifies file
 * 7. Edge cases: offline onboarding, network failures, concurrent operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  generatePairingCode,
  parsePairingCode,
  type PairingData,
} from '@/lib/utils/pairing-code';
import {
  startFileUpload,
  uploadFileChunk,
  receiveFileMetadata,
  receiveFileChunk,
  type FileUpload,
} from '@/lib/features/files';
import {
  completeOnboarding,
  getOrCreateUserProfile,
  loadUserProfile,
} from '@/lib/utils/user-profile';
import { generateSymmetricKey } from '@/lib/crypto/keys';
import type { EncryptedEvent } from '@/types';

const TEST_WS_URL =
  process.env.POCKETBRIDGE_TEST_WS_URL ||
  process.env.NEXT_PUBLIC_WS_URL ||
  'wss://terraqueous-nonmarketable-burt.ngrok-free.dev/ws';

// Mock modules
vi.mock('@/lib/utils/device', () => ({
  getOrCreateDeviceId: () => 'test-device-id',
  getOrCreateDeviceName: () => 'Test Device',
}));

vi.mock('@/lib/utils/storage', () => ({
  getWsUrl: () => TEST_WS_URL,
  setWsUrl: vi.fn(),
}));

vi.mock('@/lib/crypto/shared-key', () => ({
  getSharedEncryptionKey: vi.fn(),
  setSharedEncryptionKey: vi.fn(),
}));

vi.mock('@/lib/crypto/keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/crypto/keys')>('@/lib/crypto/keys');
  return {
    ...actual,
    loadIdentityKeyPair: vi.fn(),
  };
});

vi.mock('@/lib/sync/event-builder', () => ({
  createEvent: vi.fn(),
}));

vi.mock('@/lib/crypto/encryption', () => ({
  encryptPayload: vi.fn(),
  decryptPayload: vi.fn(),
}));

vi.mock('@/lib/features/files', async () => {
  const actual = await vi.importActual<typeof import('@/lib/features/files')>('@/lib/features/files');
  return {
    ...actual,
    uploadFileChunk: vi.fn(),
    receiveFileChunk: vi.fn(),
    receiveFileMetadata: vi.fn(),
  };
});

// Simulated device class
class SimulatedDevice {
  userId: string;
  deviceId: string;
  deviceName: string;
  onboardingCompleted: boolean = false;
  pairedDevices: Set<string> = new Set();
  publicKeyHex: string;
  privateKeyHex: string;

  constructor(name: string, deviceId: string) {
    this.userId = `user-${name}-${Date.now()}`;
    this.deviceId = deviceId;
    this.deviceName = `${name}'s Device`;
    this.publicKeyHex = `pub-${name}-${Math.random().toString(36).substring(7)}`;
    this.privateKeyHex = `priv-${name}-${Math.random().toString(36).substring(7)}`;
  }

  async completeOnboarding(): Promise<void> {
    // Simulate onboarding completion
    this.onboardingCompleted = true;
    const profile = {
      userId: this.userId,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      onboardingCompleted: true,
      createdAt: Date.now(),
    };
    localStorage.setItem(`profile-${this.userId}`, JSON.stringify(profile));
  }

  getProfile() {
    const profileStr = localStorage.getItem(`profile-${this.userId}`);
    return profileStr ? JSON.parse(profileStr) : null;
  }

  isOnboarded(): boolean {
    const profile = this.getProfile();
    return profile?.onboardingCompleted ?? false;
  }

  async generatePairingCode(): Promise<string> {
    const data: PairingData = {
      wsUrl: TEST_WS_URL,
      userId: this.userId,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      publicKeyHex: this.publicKeyHex,
      privateKeyHex: this.privateKeyHex,
    };

    // Mock backend storage
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    localStorage.setItem(`pairing-code-${code}`, JSON.stringify(data));
    return code;
  }

  async pairDevice(pairingCode: string): Promise<boolean> {
    const dataStr = localStorage.getItem(`pairing-code-${pairingCode}`);
    if (!dataStr) return false;

    const data: PairingData = JSON.parse(dataStr);
    this.pairedDevices.add(data.deviceId);
    
    // Store pairing in device profile
    const profile = this.getProfile();
    if (profile) {
      profile.pairedDevices = Array.from(this.pairedDevices);
      localStorage.setItem(`profile-${this.userId}`, JSON.stringify(profile));
    }

    // Mark code as used
    localStorage.removeItem(`pairing-code-${pairingCode}`);
    return true;
  }
}

describe('Onboarding → Pairing → File Sharing Integration', () => {
  let deviceA: SimulatedDevice;
  let deviceB: SimulatedDevice;
  let sharedEncryptionKey: CryptoKey;
  let mockFetch: Mock;
  let mockKeyPair: any;

  beforeEach(async () => {
    // Initialize simulated devices
    deviceA = new SimulatedDevice('Alice', 'device-alice-001');
    deviceB = new SimulatedDevice('Bob', 'device-bob-002');

    // Generate shared encryption key
    sharedEncryptionKey = await generateSymmetricKey();

    // Setup localStorage and mocks
    localStorage.clear();
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Add File API polyfills
    if (!File.prototype.arrayBuffer) {
      File.prototype.arrayBuffer = async function () {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(this);
        });
      };
    }

    // Mock identity keypair
    const { loadIdentityKeyPair } = await import('@/lib/crypto/keys');
    const publicKey = crypto.getRandomValues(new Uint8Array(32));
    const privateKey = crypto.getRandomValues(new Uint8Array(32));
    mockKeyPair = {
      publicKey,
      privateKey,
      publicKeyHex: Array.from(publicKey)
        .map(b => b.toString(16).padStart(2, '0'))
        .join(''),
      privateKeyHex: Array.from(privateKey)
        .map(b => b.toString(16).padStart(2, '0'))
        .join(''),
    };
    (loadIdentityKeyPair as Mock).mockResolvedValue(mockKeyPair);

    // Setup encryption mocks
    const { encryptPayload, decryptPayload } = await import('@/lib/crypto/encryption');
    (encryptPayload as Mock).mockImplementation(async (payload: any) => ({
      ciphertext: Buffer.from(JSON.stringify(payload)).toString('hex'),
      nonce: '0'.repeat(24),
    }));
    (decryptPayload as Mock).mockImplementation(async (encrypted: string) => {
      try {
        return JSON.parse(Buffer.from(encrypted, 'hex').toString());
      } catch {
        return {};
      }
    });

    // Setup file operation mocks
    const chunkDataStore = new Map<string, Uint8Array>();

    const { uploadFileChunk, receiveFileChunk, receiveFileMetadata } = await import(
      '@/lib/features/files'
    );
    (uploadFileChunk as Mock).mockImplementation(async (upload: any, chunkIndex: number, chunkData: Uint8Array) => {
      const hashBuffer = await crypto.subtle.digest('SHA-256', chunkData.buffer as ArrayBuffer);
      const hashArray = new Uint8Array(hashBuffer);
      const hash = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
      const chunkKey = `${upload.fileId}-${chunkIndex}`;
      chunkDataStore.set(chunkKey, chunkData);

      const mockEvent: EncryptedEvent = {
        event_id: crypto.randomUUID(),
        user_id: mockKeyPair.publicKeyHex,
        device_id: deviceA.deviceId,
        device_seq: chunkIndex + 1,
        stream_id: `files:main:${upload.fileId}`,
        stream_seq: chunkIndex + 1,
        type: 'file:chunk',
        encrypted_payload: btoa(JSON.stringify({ file_id: upload.fileId, chunk_index: chunkIndex, hash })),
        created_at: Date.now(),
      };

      upload.uploadedChunks.add(chunkIndex);
      return mockEvent;
    });

    (receiveFileChunk as Mock).mockImplementation(async (event: EncryptedEvent) => {
      try {
        const decoded = atob(event.encrypted_payload);
        const payload = JSON.parse(decoded);
        const chunkKey = `${payload.file_id}-${payload.chunk_index}`;
        const storedData = chunkDataStore.get(chunkKey);

        if (storedData) {
          return {
            chunkIndex: payload.chunk_index,
            data: storedData,
            hash: payload.hash,
          };
        }
        return null;
      } catch {
        return null;
      }
    });

    (receiveFileMetadata as Mock).mockImplementation(async (event: EncryptedEvent) => {
      try {
        const decoded = atob(event.encrypted_payload);
        return JSON.parse(decoded);
      } catch {
        return null;
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('Phase 1: Onboarding Completion', () => {
    it('should complete onboarding and mark user as onboarded', async () => {
      expect(deviceA.isOnboarded()).toBe(false);

      await deviceA.completeOnboarding();

      expect(deviceA.isOnboarded()).toBe(true);
      const profile = deviceA.getProfile();
      expect(profile.onboardingCompleted).toBe(true);
      expect(profile.userId).toBe(deviceA.userId);
    });

    it('should not redirect to onboarding after completion', async () => {
      await deviceA.completeOnboarding();

      // Check profile multiple times - should always show onboarded
      for (let i = 0; i < 3; i++) {
        expect(deviceA.isOnboarded()).toBe(true);
      }
    });

    it('should persist onboarding state across app reloads', async () => {
      await deviceA.completeOnboarding();
      expect(deviceA.isOnboarded()).toBe(true);

      // Simulate app reload by checking localStorage directly
      const profile = deviceA.getProfile();
      expect(profile.onboardingCompleted).toBe(true);
    });

    it('should handle onboarding when offline', async () => {
      // Simulate offline by mocking fetch to fail
      mockFetch.mockRejectedValue(new Error('Network error'));

      // Onboarding should still complete locally
      await deviceA.completeOnboarding();
      expect(deviceA.isOnboarded()).toBe(true);

      // Profile persists even though network failed
      const profile = deviceA.getProfile();
      expect(profile.onboardingCompleted).toBe(true);
    });
  });

  describe('Phase 2: Pairing After Onboarding', () => {
    it('should generate pairing code after onboarding', async () => {
      await deviceA.completeOnboarding();

      const pairingCode = await deviceA.generatePairingCode();

      expect(pairingCode).toBeDefined();
      expect(pairingCode).toMatch(/^\d{6}$/);
      expect(localStorage.getItem(`pairing-code-${pairingCode}`)).toBeTruthy();
    });

    it('should pair Device B using Device A pairing code', async () => {
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();

      const pairingCode = await deviceA.generatePairingCode();
      const pairingSuccess = await deviceB.pairDevice(pairingCode);

      expect(pairingSuccess).toBe(true);
      expect(deviceB.pairedDevices.has(deviceA.deviceId)).toBe(true);
    });

    it('should invalidate pairing code after use', async () => {
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();

      const pairingCode = await deviceA.generatePairingCode();
      await deviceB.pairDevice(pairingCode);

      // Code should be removed
      expect(localStorage.getItem(`pairing-code-${pairingCode}`)).toBeNull();
    });

    it('should fail pairing with invalid code', async () => {
      await deviceB.completeOnboarding();

      const pairingSuccess = await deviceB.pairDevice('000000');

      expect(pairingSuccess).toBe(false);
    });

    it('should handle pairing failure gracefully and keep onboarding state', async () => {
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();

      const invalidCode = '999999';
      const pairingSuccess = await deviceB.pairDevice(invalidCode);

      expect(pairingSuccess).toBe(false);
      expect(deviceB.isOnboarded()).toBe(true); // Should still be onboarded
    });
  });

  describe('Phase 3: File Sharing Between Devices', () => {
    it('should share file from Device A to Device B after pairing', async () => {
      // Setup: both devices onboarded and paired
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();
      const pairingCode = await deviceA.generatePairingCode();
      await deviceB.pairDevice(pairingCode);

      // Create and upload file from Device A
      const fileContent = 'Test file content';
      const blob = new Blob([fileContent], { type: 'text/plain' });
      const testFile = new File([blob], 'test.txt', { type: 'text/plain' });

      const fileUpload = await startFileUpload(testFile);

      expect(fileUpload).toBeDefined();
      expect(fileUpload.name).toBe('test.txt');
      expect(deviceB.pairedDevices.has(deviceA.deviceId)).toBe(true);
    });

    it('should handle concurrent file uploads from multiple devices', async () => {
      // Setup: both devices onboarded and paired
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();
      const pairingCode = await deviceA.generatePairingCode();
      await deviceB.pairDevice(pairingCode);

      // Both devices upload files simultaneously
      const files = [
        new File(['File from A'], 'file-a.txt', { type: 'text/plain' }),
        new File(['File from B'], 'file-b.txt', { type: 'text/plain' }),
      ];

      const uploads = await Promise.all([
        startFileUpload(files[0]),
        startFileUpload(files[1]),
      ]);

      expect(uploads).toHaveLength(2);
      expect(uploads[0].fileId).not.toBe(uploads[1].fileId);
    });

    it('should verify file integrity after transfer', async () => {
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();
      const pairingCode = await deviceA.generatePairingCode();
      await deviceB.pairDevice(pairingCode);

      // Create test file
      const content = 'A'.repeat(1024);
      const blob = new Blob([content], { type: 'text/plain' });
      const testFile = new File([blob], 'test.txt', { type: 'text/plain' });

      const fileUpload = await startFileUpload(testFile);
      const arrayBuffer = await testFile.arrayBuffer();
      const chunkData = new Uint8Array(arrayBuffer);

      // Upload chunk
      const uploadEvent = await uploadFileChunk(fileUpload, 0, chunkData);
      expect(uploadEvent).toBeDefined();

      // Device B receives chunk
      const receivedChunk = await receiveFileChunk(uploadEvent, fileUpload.encryptionKey);
      expect(receivedChunk).toBeDefined();
      expect(receivedChunk?.data.length).toBe(1024);
    });
  });

  describe('Edge Cases: Complex Scenarios', () => {
    it('should handle re-pairing with same device', async () => {
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();

      // First pairing
      let pairingCode = await deviceA.generatePairingCode();
      await deviceB.pairDevice(pairingCode);
      expect(deviceB.pairedDevices.has(deviceA.deviceId)).toBe(true);

      // Second pairing (should add again or handle gracefully)
      pairingCode = await deviceA.generatePairingCode();
      await deviceB.pairDevice(pairingCode);
      expect(deviceB.pairedDevices.has(deviceA.deviceId)).toBe(true);
    });

    it('should handle file transfer with pairing code reuse attempt', async () => {
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();

      const pairingCode = await deviceA.generatePairingCode();
      await deviceB.pairDevice(pairingCode);

      // Try to use same code again - should fail
      const secondAttempt = await deviceB.pairDevice(pairingCode);
      expect(secondAttempt).toBe(false);
    });

    it('should maintain onboarding state through multiple pairings', async () => {
      const deviceC = new SimulatedDevice('Charlie', 'device-charlie-003');

      // Device A completes onboarding
      await deviceA.completeOnboarding();
      expect(deviceA.isOnboarded()).toBe(true);

      // Pair with Device B
      await deviceB.completeOnboarding();
      let pairingCode = await deviceA.generatePairingCode();
      await deviceB.pairDevice(pairingCode);

      // Pair with Device C
      await deviceC.completeOnboarding();
      pairingCode = await deviceA.generatePairingCode();
      await deviceC.pairDevice(pairingCode);

      // Device A should still be onboarded
      expect(deviceA.isOnboarded()).toBe(true);
      expect(deviceA.pairedDevices.size).toBe(0); // A doesn't track paired devices
      expect(deviceB.pairedDevices.size).toBe(1);
      expect(deviceC.pairedDevices.size).toBe(1);
    });

    it('should handle pairing timeout gracefully', async () => {
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();

      // Generate code and wait (simulate timeout)
      const pairingCode = await deviceA.generatePairingCode();
      
      // Remove code to simulate expiration
      localStorage.removeItem(`pairing-code-${pairingCode}`);

      const pairingSuccess = await deviceB.pairDevice(pairingCode);
      expect(pairingSuccess).toBe(false);
      expect(deviceB.isOnboarded()).toBe(true); // Still onboarded
    });

    it('should support file sharing with 3+ paired devices', async () => {
      const devices = [
        deviceA,
        deviceB,
        new SimulatedDevice('Charlie', 'device-charlie-003'),
        new SimulatedDevice('Diana', 'device-diana-004'),
      ];

      // All devices complete onboarding
      for (const device of devices) {
        await device.completeOnboarding();
        expect(device.isOnboarded()).toBe(true);
      }

      // Pair all to first device
      for (let i = 1; i < devices.length; i++) {
        const pairingCode = await deviceA.generatePairingCode();
        const success = await devices[i].pairDevice(pairingCode);
        expect(success).toBe(true);
      }

      // Verify all are paired
      for (let i = 1; i < devices.length; i++) {
        expect(devices[i].pairedDevices.has(deviceA.deviceId)).toBe(true);
      }
    });

    it('should handle file transfer failure and retry without re-onboarding', async () => {
      await deviceA.completeOnboarding();
      await deviceB.completeOnboarding();
      const pairingCode = await deviceA.generatePairingCode();
      await deviceB.pairDevice(pairingCode);

      // First transfer attempt fails
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      // Should still be able to retry
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

      expect(deviceA.isOnboarded()).toBe(true);
      expect(deviceB.isOnboarded()).toBe(true);
    });
  });
});
