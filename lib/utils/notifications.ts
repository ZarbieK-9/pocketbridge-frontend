/**
 * Browser Notification Utilities
 *
 * Handles native browser notifications for incoming messages and events.
 * Uses the Web Notifications API with permission management.
 */

import { logger } from './logger';
import { loadUserProfile } from './user-profile';

export type NotificationPermission = 'default' | 'granted' | 'denied';

/**
 * Check if browser notifications are supported
 */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Get the current notification permission status
 */
export function getNotificationPermission(): NotificationPermission {
  if (!isNotificationSupported()) return 'denied';
  return Notification.permission as NotificationPermission;
}

/**
 * Request permission to show notifications
 * Returns the new permission status
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationSupported()) {
    logger.warn('Notifications not supported in this browser');
    return 'denied';
  }

  try {
    const permission = await Notification.requestPermission();
    logger.info('Notification permission result', { permission });
    return permission as NotificationPermission;
  } catch (error) {
    logger.error('Failed to request notification permission', error);
    return 'denied';
  }
}

/**
 * Check if notifications are enabled (permission granted + user preference enabled)
 */
export function areNotificationsEnabled(): boolean {
  if (!isNotificationSupported()) return false;

  // Check browser permission
  if (Notification.permission !== 'granted') return false;

  // Check user preference
  const profile = loadUserProfile();
  return profile?.preferences?.notifications !== false; // Default to true if not set
}

export interface ShowNotificationOptions {
  title: string;
  body: string;
  icon?: string;
  tag?: string; // Prevents duplicate notifications with same tag
  data?: Record<string, unknown>;
  onClick?: () => void;
  requireInteraction?: boolean; // Keep notification visible until user interacts
}

/**
 * Show a browser notification
 * Returns the Notification object if successful, null otherwise
 */
export function showNotification(options: ShowNotificationOptions): Notification | null {
  if (!areNotificationsEnabled()) {
    logger.debug('Notifications disabled, skipping', { title: options.title });
    return null;
  }

  // Don't show notification if page is focused
  if (typeof document !== 'undefined' && document.hasFocus()) {
    logger.debug('Page is focused, skipping notification', { title: options.title });
    return null;
  }

  try {
    const notification = new Notification(options.title, {
      body: options.body,
      icon: options.icon || '/icon-192.jpg',
      tag: options.tag,
      data: options.data,
      requireInteraction: options.requireInteraction,
    });

    if (options.onClick) {
      notification.onclick = () => {
        options.onClick?.();
        notification.close();
        // Focus the window
        window.focus();
      };
    }

    logger.debug('Notification shown', { title: options.title });
    return notification;
  } catch (error) {
    logger.error('Failed to show notification', error);
    return null;
  }
}

/**
 * Show a notification for an incoming message
 */
export function showMessageNotification(
  senderName: string,
  messagePreview: string,
  options?: { onClick?: () => void }
): Notification | null {
  // Truncate preview if too long
  const truncatedPreview = messagePreview.length > 100
    ? messagePreview.substring(0, 97) + '...'
    : messagePreview;

  return showNotification({
    title: `New message from ${senderName}`,
    body: truncatedPreview,
    tag: 'message', // Replaces previous message notifications
    onClick: options?.onClick,
  });
}

/**
 * Show a notification for a file transfer
 */
export function showFileNotification(
  fileName: string,
  senderName: string,
  options?: { onClick?: () => void }
): Notification | null {
  return showNotification({
    title: `File received from ${senderName}`,
    body: fileName,
    tag: 'file-transfer',
    onClick: options?.onClick,
  });
}

/**
 * Show a notification for device connection
 */
export function showDeviceNotification(
  deviceName: string,
  isOnline: boolean,
  options?: { onClick?: () => void }
): Notification | null {
  return showNotification({
    title: isOnline ? 'Device connected' : 'Device disconnected',
    body: deviceName,
    tag: `device-${deviceName}`,
    onClick: options?.onClick,
  });
}

/**
 * Save notification preference to user profile
 */
export async function setNotificationPreference(enabled: boolean): Promise<void> {
  const profile = loadUserProfile();
  if (!profile) {
    logger.warn('No user profile found, cannot save notification preference');
    return;
  }

  // Import dynamically to avoid circular dependencies
  const { updateUserProfile } = await import('./user-profile');

  await updateUserProfile({
    preferences: {
      ...profile.preferences,
      notifications: enabled,
    },
  }, profile.userId);

  logger.info('Notification preference saved', { enabled });
}
