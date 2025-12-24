"use client"

/**
 * React hook for sync engine - Phase 1
 * Manages event queue and provides sync status
 */

import { useState, useEffect } from 'react';
import { getEventQueue } from '@/lib/sync';
import type { QueueStatus } from '@/types';

export function useSync() {
  const [status, setStatus] = useState<QueueStatus>({
    pending: 0,
    lastSync: null,
    lastAckDeviceSeq: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    let intervalId: ReturnType<typeof setInterval>;

    async function updateStatus() {
      try {
        const queue = getEventQueue();
        const newStatus = await queue.getStatus();

        if (mounted) {
          setStatus(newStatus);
          setIsLoading(false);
        }
      } catch (error) {
        console.error('[Phase1] Failed to update sync status:', error);
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    // Initial load
    updateStatus();

    // Poll every 5 seconds
    intervalId = setInterval(updateStatus, 5000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, []);

  return { status, isLoading };
}
