/**
 * React hook for monitoring browser storage quota
 *
 * Features:
 * - Real-time quota monitoring
 * - Warning notifications at configurable thresholds
 * - Custom event listener for quota exceeded errors
 * - Automatic cleanup on unmount
 */

import { useState, useEffect, useCallback } from 'react';

export interface StorageQuotaStatus {
  /** Current storage usage in bytes */
  usage: number;
  /** Total quota in bytes */
  quota: number;
  /** Usage as percentage (0-100) */
  usagePercent: number;
  /** Whether storage is supported */
  isSupported: boolean;
  /** Whether quota is exceeded */
  isExceeded: boolean;
  /** Warning level: 'none' | 'low' | 'medium' | 'high' | 'critical' */
  warningLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

export interface UseStorageQuotaOptions {
  /** Polling interval in milliseconds (default: 30000 = 30s) */
  pollInterval?: number;
  /** Warning threshold percentage (default: 80) */
  warningThreshold?: number;
  /** Critical threshold percentage (default: 90) */
  criticalThreshold?: number;
  /** Enable automatic polling (default: true) */
  enablePolling?: boolean;
}

/**
 * Hook for monitoring storage quota status
 *
 * @example
 * ```tsx
 * const { quota, refresh } = useStorageQuota({
 *   warningThreshold: 80,
 *   criticalThreshold: 90,
 * });
 *
 * if (quota.warningLevel === 'critical') {
 *   toast.error(`Storage ${quota.usagePercent}% full`);
 * }
 * ```
 */
export function useStorageQuota(options: UseStorageQuotaOptions = {}) {
  const {
    pollInterval = 30000, // 30 seconds
    warningThreshold = 80,
    criticalThreshold = 90,
    enablePolling = true,
  } = options;

  const [quota, setQuota] = useState<StorageQuotaStatus>({
    usage: 0,
    quota: 0,
    usagePercent: 0,
    isSupported: false,
    isExceeded: false,
    warningLevel: 'none',
  });

  const [lastExceededEvent, setLastExceededEvent] = useState<{
    message: string;
    timestamp: number;
  } | null>(null);

  /**
   * Calculate warning level based on usage percentage
   */
  const calculateWarningLevel = useCallback((usagePercent: number): StorageQuotaStatus['warningLevel'] => {
    if (usagePercent >= criticalThreshold) return 'critical';
    if (usagePercent >= warningThreshold) return 'high';
    if (usagePercent >= warningThreshold - 10) return 'medium';
    if (usagePercent >= warningThreshold - 20) return 'low';
    return 'none';
  }, [warningThreshold, criticalThreshold]);

  /**
   * Fetch current storage quota status
   */
  const refresh = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
      setQuota({
        usage: 0,
        quota: 0,
        usagePercent: 0,
        isSupported: false,
        isExceeded: false,
        warningLevel: 'none',
      });
      return;
    }

    try {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage || 0;
      const quotaTotal = estimate.quota || 0;
      const usagePercent = quotaTotal > 0 ? (usage / quotaTotal) * 100 : 0;

      setQuota({
        usage,
        quota: quotaTotal,
        usagePercent,
        isSupported: true,
        isExceeded: usagePercent >= 100,
        warningLevel: calculateWarningLevel(usagePercent),
      });
    } catch (error) {
      console.error('[StorageQuota] Failed to estimate storage:', error);
    }
  }, [calculateWarningLevel]);

  /**
   * Handle storage quota exceeded event
   */
  useEffect(() => {
    const handleQuotaExceeded = (event: Event) => {
      const customEvent = event as CustomEvent<{
        message: string;
        timestamp: number;
      }>;

      console.error('[StorageQuota] Quota exceeded event received', customEvent.detail);

      setLastExceededEvent(customEvent.detail);

      // Force refresh quota status
      refresh();
    };

    window.addEventListener('pocketbridge-storage-quota-exceeded', handleQuotaExceeded);

    return () => {
      window.removeEventListener('pocketbridge-storage-quota-exceeded', handleQuotaExceeded);
    };
  }, [refresh]);

  /**
   * Set up polling for quota updates
   */
  useEffect(() => {
    if (!enablePolling) return;

    // Initial fetch
    refresh();

    // Set up polling
    const interval = setInterval(refresh, pollInterval);

    return () => {
      clearInterval(interval);
    };
  }, [enablePolling, pollInterval, refresh]);

  /**
   * Format bytes as human-readable string
   */
  const formatBytes = useCallback((bytes: number): string => {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
  }, []);

  return {
    quota,
    lastExceededEvent,
    refresh,
    formatBytes,
    // Helper getters
    isLow: quota.warningLevel === 'low',
    isMedium: quota.warningLevel === 'medium',
    isHigh: quota.warningLevel === 'high',
    isCritical: quota.warningLevel === 'critical',
    isHealthy: quota.warningLevel === 'none',
  };
}

/**
 * Hook variant that only listens for quota exceeded events
 * Lighter weight than full quota monitoring
 *
 * @example
 * ```tsx
 * const { lastExceeded } = useStorageQuotaExceeded();
 *
 * useEffect(() => {
 *   if (lastExceeded) {
 *     toast.error(lastExceeded.message);
 *   }
 * }, [lastExceeded]);
 * ```
 */
export function useStorageQuotaExceeded() {
  const [lastExceeded, setLastExceeded] = useState<{
    message: string;
    timestamp: number;
  } | null>(null);

  useEffect(() => {
    const handleQuotaExceeded = (event: Event) => {
      const customEvent = event as CustomEvent<{
        message: string;
        timestamp: number;
      }>;

      setLastExceeded(customEvent.detail);
    };

    window.addEventListener('pocketbridge-storage-quota-exceeded', handleQuotaExceeded);

    return () => {
      window.removeEventListener('pocketbridge-storage-quota-exceeded', handleQuotaExceeded);
    };
  }, []);

  return { lastExceeded };
}
