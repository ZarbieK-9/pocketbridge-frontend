/**
 * Feature API Utilities
 * 
 * Centralized API calls for all PocketBridge features
 * Ensures proper authentication, error handling, and state management
 */

import { logger } from './logger';

export interface FeatureApiConfig {
  apiUrl: string;
  userId: string;
  deviceId: string;
}

export interface ClipboardItem {
  id: string;
  content: string;
  type: string;
  created_at: string;
  device_id: string;
}

export interface Message {
  id: string;
  content: string;
  sender_device_id: string;
  recipient_device_id: string;
  created_at: string;
  read: boolean;
}

export interface SharedFile {
  id: string;
  filename: string;
  size: number;
  mime_type: string;
  device_id: string;
  created_at: string;
  download_url?: string;
}

export interface ConnectedDevice {
  device_id: string;
  device_name: string;
  is_online: boolean;
  last_activity: string | null;
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  device_count: number;
  created_at: string;
}

/**
 * Creates an AbortController with timeout
 */
function createTimeoutController(timeoutMs: number = 10000): { controller: AbortController; timeoutId: NodeJS.Timeout } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeoutId };
}

/**
 * Clipboard Feature APIs
 */
export async function getClipboardHistory(config: FeatureApiConfig): Promise<ClipboardItem[]> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/clipboard/history`, {
      method: 'GET',
      headers: {
        'X-User-ID': config.userId,
        'X-Device-ID': config.deviceId,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.items || [];
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to fetch clipboard history', error);
    return [];
  }
}

/**
 * Scratchpad Feature APIs
 */
export async function getScratchpadContent(config: FeatureApiConfig): Promise<string> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/scratchpad`, {
      method: 'GET',
      headers: {
        'X-User-ID': config.userId,
        'X-Device-ID': config.deviceId,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 404) {
        return ''; // Empty scratchpad
      }
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.content || '';
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to fetch scratchpad content', error);
    return '';
  }
}

export async function updateScratchpadContent(
  config: FeatureApiConfig,
  content: string
): Promise<boolean> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/scratchpad`, {
      method: 'POST',
      headers: {
        'X-User-ID': config.userId,
        'X-Device-ID': config.deviceId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    logger.info('Scratchpad updated successfully');
    return true;
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to update scratchpad', error);
    return false;
  }
}

/**
 * Messages Feature APIs
 */
export async function getActiveMessages(config: FeatureApiConfig): Promise<Message[]> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/messages/active`, {
      method: 'GET',
      headers: {
        'X-User-ID': config.userId,
        'X-Device-ID': config.deviceId,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.messages || [];
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to fetch active messages', error);
    return [];
  }
}

export async function sendMessage(
  config: FeatureApiConfig,
  message: string,
  expiresIn: number
): Promise<boolean> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/messages`, {
      method: 'POST',
      headers: {
        'X-User-ID': config.userId,
        'X-Device-ID': config.deviceId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        expires_in: expiresIn,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    logger.info('Message sent successfully');
    return true;
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to send message', error);
    return false;
  }
}

/**
 * Files Feature APIs
 */
export async function getSharedFiles(config: FeatureApiConfig): Promise<SharedFile[]> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/files/shared`, {
      method: 'GET',
      headers: {
        'X-User-ID': config.userId,
        'X-Device-ID': config.deviceId,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.files || [];
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to fetch shared files', error);
    return [];
  }
}

export async function deleteFile(
  config: FeatureApiConfig,
  fileId: string
): Promise<boolean> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/files/${fileId}`, {
      method: 'DELETE',
      headers: {
        'X-User-ID': config.userId,
        'X-Device-ID': config.deviceId,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    logger.info('File deleted successfully', { fileId });
    return true;
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to delete file', error);
    return false;
  }
}

/**
 * Device APIs
 */
export async function getConnectedDevices(config: FeatureApiConfig): Promise<ConnectedDevice[]> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/devices`, {
      method: 'GET',
      headers: {
        'X-User-ID': config.userId,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.devices || [];
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to fetch connected devices', error);
    return [];
  }
}

export async function revokeDevice(
  config: FeatureApiConfig,
  deviceId: string
): Promise<boolean> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/devices/${deviceId}/revoke`, {
      method: 'POST',
      headers: {
        'X-User-ID': config.userId,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    logger.info('Device revoked successfully', { deviceId });
    return true;
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to revoke device', error);
    return false;
  }
}

/**
 * User Profile APIs
 */
export async function getUserProfile(config: Pick<FeatureApiConfig, 'apiUrl' | 'userId'>): Promise<UserProfile | null> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/user/profile`, {
      method: 'GET',
      headers: {
        'X-User-ID': config.userId,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.profile || data;
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to fetch user profile', error);
    return null;
  }
}

export async function updateUserProfileApi(
  config: Pick<FeatureApiConfig, 'apiUrl' | 'userId'>,
  updates: Record<string, any>
): Promise<boolean> {
  const { controller, timeoutId } = createTimeoutController();
  
  try {
    const response = await fetch(`${config.apiUrl}/api/user/profile`, {
      method: 'POST',
      headers: {
        'X-User-ID': config.userId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    logger.info('User profile updated successfully');
    return true;
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error('Failed to update user profile', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
