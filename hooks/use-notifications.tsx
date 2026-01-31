'use client';

/**
 * Notification Hook
 *
 * Provides access to browser notification functionality with permission management.
 * Automatically handles permission state and user preferences.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  isNotificationSupported,
  getNotificationPermission,
  requestNotificationPermission,
  areNotificationsEnabled,
  showNotification,
  showMessageNotification,
  showFileNotification,
  showDeviceNotification,
  setNotificationPreference,
  type NotificationPermission,
  type ShowNotificationOptions,
} from '@/lib/utils/notifications';
import { loadUserProfile } from '@/lib/utils/user-profile';
import { logger } from '@/lib/utils/logger';

export interface UseNotificationsReturn {
  /** Whether the browser supports notifications */
  isSupported: boolean;
  /** Current permission state: 'default' | 'granted' | 'denied' */
  permission: NotificationPermission;
  /** Whether notifications are fully enabled (permission + user preference) */
  isEnabled: boolean;
  /** Whether the user preference is enabled (regardless of permission) */
  preferenceEnabled: boolean;
  /** Request notification permission from the browser */
  requestPermission: () => Promise<NotificationPermission>;
  /** Toggle notification preference */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Show a custom notification */
  showNotification: (options: ShowNotificationOptions) => Notification | null;
  /** Show a message notification */
  showMessageNotification: (senderName: string, preview: string, onClick?: () => void) => Notification | null;
  /** Show a file notification */
  showFileNotification: (fileName: string, senderName: string, onClick?: () => void) => Notification | null;
  /** Show a device notification */
  showDeviceNotification: (deviceName: string, isOnline: boolean, onClick?: () => void) => Notification | null;
}

export function useNotifications(): UseNotificationsReturn {
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [preferenceEnabled, setPreferenceEnabled] = useState(true);
  const [isSupported, setIsSupported] = useState(false);

  // Initialize state on mount (client-side only)
  useEffect(() => {
    setIsSupported(isNotificationSupported());
    setPermission(getNotificationPermission());

    const profile = loadUserProfile();
    setPreferenceEnabled(profile?.preferences?.notifications !== false);
  }, []);

  // Listen for visibility changes to update permission (in case user changed it in browser settings)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        setPermission(getNotificationPermission());
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const requestPermission = useCallback(async (): Promise<NotificationPermission> => {
    const result = await requestNotificationPermission();
    setPermission(result);
    return result;
  }, []);

  const setEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    // If enabling and permission not granted, request it first
    if (enabled && permission !== 'granted') {
      const newPermission = await requestNotificationPermission();
      setPermission(newPermission);
      if (newPermission !== 'granted') {
        logger.warn('Cannot enable notifications without permission');
        return;
      }
    }

    await setNotificationPreference(enabled);
    setPreferenceEnabled(enabled);
  }, [permission]);

  const handleShowNotification = useCallback((options: ShowNotificationOptions): Notification | null => {
    return showNotification(options);
  }, []);

  const handleShowMessageNotification = useCallback(
    (senderName: string, preview: string, onClick?: () => void): Notification | null => {
      return showMessageNotification(senderName, preview, { onClick });
    },
    []
  );

  const handleShowFileNotification = useCallback(
    (fileName: string, senderName: string, onClick?: () => void): Notification | null => {
      return showFileNotification(fileName, senderName, { onClick });
    },
    []
  );

  const handleShowDeviceNotification = useCallback(
    (deviceName: string, isOnline: boolean, onClick?: () => void): Notification | null => {
      return showDeviceNotification(deviceName, isOnline, { onClick });
    },
    []
  );

  const isEnabled = isSupported && permission === 'granted' && preferenceEnabled;

  return {
    isSupported,
    permission,
    isEnabled,
    preferenceEnabled,
    requestPermission,
    setEnabled,
    showNotification: handleShowNotification,
    showMessageNotification: handleShowMessageNotification,
    showFileNotification: handleShowFileNotification,
    showDeviceNotification: handleShowDeviceNotification,
  };
}
