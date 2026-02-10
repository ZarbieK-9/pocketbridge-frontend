/**
 * Storage Quota Monitor Component
 *
 * Displays real-time storage usage and warnings
 * Can be embedded in settings or shown as a toast notification
 */

'use client';

import { useEffect } from 'react';
import { useStorageQuota, useStorageQuotaExceeded } from '@/hooks/use-storage-quota';
import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';

interface StorageQuotaMonitorProps {
  /** Show detailed stats (default: false) */
  showDetails?: boolean;
  /** Auto-dismiss timeout in ms (0 = no auto-dismiss) */
  autoDismiss?: number;
  /** Callback when quota exceeded */
  onQuotaExceeded?: (message: string) => void;
  /** Callback when quota warning level changes */
  onWarningLevelChange?: (level: 'none' | 'low' | 'medium' | 'high' | 'critical') => void;
}

/**
 * Storage quota monitor with visual indicator
 *
 * @example
 * ```tsx
 * // In settings page
 * <StorageQuotaMonitor showDetails={true} />
 *
 * // As toast notification
 * <StorageQuotaMonitor
 *   autoDismiss={5000}
 *   onQuotaExceeded={(msg) => toast.error(msg)}
 * />
 * ```
 */
export function StorageQuotaMonitor({
  showDetails = false,
  autoDismiss = 0,
  onQuotaExceeded,
  onWarningLevelChange,
}: StorageQuotaMonitorProps) {
  const {
    quota,
    formatBytes,
    isHealthy,
    isLow,
    isMedium,
    isHigh,
    isCritical,
  } = useStorageQuota({
    enablePolling: true,
    pollInterval: 30000, // 30 seconds
    warningThreshold: 80,
    criticalThreshold: 90,
  });

  const { lastExceeded } = useStorageQuotaExceeded();

  // Notify on quota exceeded
  useEffect(() => {
    if (lastExceeded && onQuotaExceeded) {
      onQuotaExceeded(lastExceeded.message);
    }
  }, [lastExceeded, onQuotaExceeded]);

  // Notify on warning level change
  useEffect(() => {
    if (onWarningLevelChange) {
      onWarningLevelChange(quota.warningLevel);
    }
  }, [quota.warningLevel, onWarningLevelChange]);

  // Auto-dismiss
  useEffect(() => {
    if (autoDismiss > 0 && isHealthy) {
      const timer = setTimeout(() => {
        // Component will be unmounted by parent
      }, autoDismiss);

      return () => clearTimeout(timer);
    }
  }, [autoDismiss, isHealthy]);

  if (!quota.isSupported) {
    return null; // Storage API not supported
  }

  // Don't show if healthy and not showing details
  if (isHealthy && !showDetails) {
    return null;
  }

  return (
    <div
      className={`rounded-lg border p-4 ${
        isCritical
          ? 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950'
          : isHigh
          ? 'border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-950'
          : isMedium
          ? 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950'
          : isLow
          ? 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950'
          : 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="mt-0.5">
          {isCritical || isHigh ? (
            <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
          ) : isMedium || isLow ? (
            <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
          ) : (
            <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">
              {isCritical
                ? 'Storage Critical'
                : isHigh
                ? 'Storage Warning'
                : isMedium
                ? 'Storage Notice'
                : isLow
                ? 'Storage Info'
                : 'Storage Healthy'}
            </h3>
            <span className="text-sm font-mono font-medium">
              {Math.round(quota.usagePercent)}%
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                isCritical
                  ? 'bg-red-600'
                  : isHigh
                  ? 'bg-orange-500'
                  : isMedium
                  ? 'bg-yellow-500'
                  : isLow
                  ? 'bg-blue-500'
                  : 'bg-green-500'
              }`}
              style={{ width: `${Math.min(quota.usagePercent, 100)}%` }}
            />
          </div>

          {/* Message */}
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {isCritical
              ? 'Storage is critically low. Reconnect to sync data or clear browser storage.'
              : isHigh
              ? 'Storage is running low. Consider syncing your data soon.'
              : isMedium
              ? 'Storage usage is moderate. Keep an eye on it.'
              : isLow
              ? 'Storage usage is getting noticeable.'
              : 'Storage usage is healthy.'}
          </p>

          {/* Details */}
          {showDetails && (
            <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
              <div className="flex justify-between">
                <span>Used:</span>
                <span className="font-mono">{formatBytes(quota.usage)}</span>
              </div>
              <div className="flex justify-between">
                <span>Available:</span>
                <span className="font-mono">{formatBytes(quota.quota)}</span>
              </div>
              <div className="flex justify-between">
                <span>Remaining:</span>
                <span className="font-mono">
                  {formatBytes(quota.quota - quota.usage)}
                </span>
              </div>
            </div>
          )}

          {/* Last exceeded event */}
          {lastExceeded && (
            <div className="mt-2 rounded bg-red-100 dark:bg-red-900 p-2 text-xs text-red-800 dark:text-red-200">
              <strong>Quota Exceeded:</strong> {lastExceeded.message}
              <br />
              <span className="text-red-600 dark:text-red-400">
                {new Date(lastExceeded.timestamp).toLocaleString()}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact storage quota badge (for status bar)
 */
export function StorageQuotaBadge() {
  const { quota, isHealthy, isCritical, isHigh } = useStorageQuota({
    enablePolling: true,
    pollInterval: 60000, // 1 minute for badge
  });

  if (!quota.isSupported || isHealthy) {
    return null;
  }

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        isCritical
          ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
          : isHigh
          ? 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200'
          : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
      }`}
    >
      <AlertTriangle className="h-3 w-3" />
      <span>Storage {Math.round(quota.usagePercent)}%</span>
    </div>
  );
}
