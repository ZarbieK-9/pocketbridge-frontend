/**
 * Sync Status Component
 *
 * Shows real-time sync progress and allows manual triggering
 * Displays pending events count, in-flight events, and last sync time
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { getEventQueue } from '@/lib/sync';
import { getWebSocketClient } from '@/lib/ws';

interface SyncStatus {
  pending: number;
  inFlight: number;
  lastSync: number | null;
  lastAckDeviceSeq: number;
  isConnected: boolean;
  isSyncing: boolean;
}

interface SyncStatusProps {
  /** Show detailed stats (default: false) */
  showDetails?: boolean;
  /** Auto-refresh interval in ms (default: 5000) */
  refreshInterval?: number;
  /** Callback when sync is triggered */
  onSyncTrigger?: () => void;
}

/**
 * Sync status indicator with manual trigger
 *
 * @example
 * ```tsx
 * // Compact status bar indicator
 * <SyncStatus />
 *
 * // Detailed status in settings
 * <SyncStatus showDetails={true} refreshInterval={3000} />
 * ```
 */
export function SyncStatus({
  showDetails = false,
  refreshInterval = 5000,
  onSyncTrigger,
}: SyncStatusProps) {
  const [status, setStatus] = useState<SyncStatus>({
    pending: 0,
    inFlight: 0,
    lastSync: null,
    lastAckDeviceSeq: 0,
    isConnected: false,
    isSyncing: false,
  });

  const [isRefreshing, setIsRefreshing] = useState(false);

  /**
   * Fetch current sync status from queue
   */
  const fetchStatus = useCallback(async () => {
    try {
      const queue = getEventQueue();
      const wsClient = getWebSocketClient();

      const queueStatus = await queue.getStatus();
      const wsStatus = wsClient.getStatus();

      setStatus({
        pending: queueStatus.pending,
        inFlight: queue.getInFlightCount(),
        lastSync: queueStatus.lastSync,
        lastAckDeviceSeq: queueStatus.lastAckDeviceSeq,
        isConnected: wsStatus === 'connected',
        isSyncing: queue.getInFlightCount() > 0,
      });
    } catch (error) {
      console.error('[SyncStatus] Failed to fetch status:', error);
    }
  }, []);

  /**
   * Manually trigger sync
   */
  const handleManualSync = useCallback(async () => {
    if (isRefreshing || !status.isConnected) return;

    setIsRefreshing(true);
    onSyncTrigger?.();

    try {
      const wsClient = getWebSocketClient();
      await wsClient.syncPending();

      // Refresh status after sync
      await new Promise(resolve => setTimeout(resolve, 1000));
      await fetchStatus();
    } catch (error) {
      console.error('[SyncStatus] Manual sync failed:', error);
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, status.isConnected, onSyncTrigger, fetchStatus]);

  /**
   * Auto-refresh status
   */
  useEffect(() => {
    fetchStatus();

    const interval = setInterval(fetchStatus, refreshInterval);

    return () => clearInterval(interval);
  }, [fetchStatus, refreshInterval]);

  /**
   * Format time ago
   */
  const formatTimeAgo = (timestamp: number | null): string => {
    if (!timestamp) return 'Never';

    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  /**
   * Get status indicator
   */
  const getStatusIndicator = () => {
    if (!status.isConnected) {
      return {
        icon: AlertCircle,
        color: 'text-red-600 dark:text-red-400',
        bgColor: 'bg-red-100 dark:bg-red-900',
        label: 'Offline',
      };
    }

    if (status.isSyncing) {
      return {
        icon: Loader2,
        color: 'text-blue-600 dark:text-blue-400',
        bgColor: 'bg-blue-100 dark:bg-blue-900',
        label: 'Syncing',
        spin: true,
      };
    }

    if (status.pending > 0) {
      return {
        icon: RefreshCw,
        color: 'text-yellow-600 dark:text-yellow-400',
        bgColor: 'bg-yellow-100 dark:bg-yellow-900',
        label: 'Pending',
      };
    }

    return {
      icon: CheckCircle,
      color: 'text-green-600 dark:text-green-400',
      bgColor: 'bg-green-100 dark:bg-green-900',
      label: 'Synced',
    };
  };

  const indicator = getStatusIndicator();
  const Icon = indicator.icon;

  // Compact mode (status bar)
  if (!showDetails) {
    return (
      <button
        onClick={handleManualSync}
        disabled={isRefreshing || !status.isConnected || status.pending === 0}
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
          indicator.bgColor
        } ${indicator.color} ${
          status.isConnected && status.pending > 0 && !isRefreshing
            ? 'cursor-pointer hover:opacity-80'
            : 'cursor-default'
        }`}
        title={
          !status.isConnected
            ? 'Offline'
            : status.pending === 0
            ? 'All synced'
            : `${status.pending} pending events - Click to sync`
        }
      >
        <Icon className={`h-3 w-3 ${indicator.spin ? 'animate-spin' : ''}`} />
        <span>
          {status.pending > 0 ? `${status.pending}` : indicator.label}
        </span>
      </button>
    );
  }

  // Detailed mode (settings page)
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon
            className={`h-5 w-5 ${indicator.color} ${indicator.spin ? 'animate-spin' : ''}`}
          />
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">
            Sync Status
          </h3>
        </div>

        {/* Manual Sync Button */}
        <button
          onClick={handleManualSync}
          disabled={isRefreshing || !status.isConnected}
          className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            isRefreshing || !status.isConnected
              ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer'
          }`}
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span>{isRefreshing ? 'Syncing...' : 'Sync Now'}</span>
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Pending Events */}
        <div className="rounded-md bg-gray-50 dark:bg-gray-800 p-3">
          <div className="text-xs text-gray-500 dark:text-gray-400">Pending</div>
          <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {status.pending}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {status.pending === 0 ? 'All synced' : 'events to sync'}
          </div>
        </div>

        {/* In-Flight Events */}
        <div className="rounded-md bg-gray-50 dark:bg-gray-800 p-3">
          <div className="text-xs text-gray-500 dark:text-gray-400">In-Flight</div>
          <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {status.inFlight}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {status.inFlight === 0 ? 'None sending' : 'currently sending'}
          </div>
        </div>

        {/* Last Synced */}
        <div className="rounded-md bg-gray-50 dark:bg-gray-800 p-3">
          <div className="text-xs text-gray-500 dark:text-gray-400">Last Sync</div>
          <div className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
            {formatTimeAgo(status.lastSync)}
          </div>
        </div>

        {/* Last Ack Seq */}
        <div className="rounded-md bg-gray-50 dark:bg-gray-800 p-3">
          <div className="text-xs text-gray-500 dark:text-gray-400">Last Ack Seq</div>
          <div className="mt-1 text-sm font-mono font-medium text-gray-900 dark:text-gray-100">
            {status.lastAckDeviceSeq}
          </div>
        </div>
      </div>

      {/* Connection Status */}
      <div className="flex items-center gap-2 text-sm">
        <div
          className={`h-2 w-2 rounded-full ${
            status.isConnected
              ? 'bg-green-500 animate-pulse'
              : 'bg-red-500'
          }`}
        />
        <span className="text-gray-700 dark:text-gray-300">
          {status.isConnected ? 'Connected' : 'Offline'}
        </span>
      </div>

      {/* Sync Progress Bar */}
      {status.isSyncing && status.pending > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
            <span>Syncing {status.inFlight} of {status.pending + status.inFlight} events</span>
            <span>
              {Math.round((status.inFlight / (status.pending + status.inFlight)) * 100)}%
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300 ease-out"
              style={{
                width: `${Math.round((status.inFlight / (status.pending + status.inFlight)) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Help Text */}
      {!status.isConnected && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Reconnect to the internet to sync pending events.
        </p>
      )}
    </div>
  );
}

/**
 * Compact sync badge for status bars
 */
export function SyncBadge() {
  return <SyncStatus showDetails={false} />;
}
