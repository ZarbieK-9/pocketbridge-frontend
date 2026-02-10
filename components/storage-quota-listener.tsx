/**
 * Storage Quota Listener
 *
 * Client component that listens for storage quota exceeded events
 * and shows toast notifications. Meant to be included in the root layout.
 */

'use client';

import { useEffect } from 'react';
import { useStorageQuotaExceeded } from '@/hooks/use-storage-quota';
import { toast } from 'sonner';
import { getWebSocketClient } from '@/lib/ws';

export function StorageQuotaListener() {
  const { lastExceeded } = useStorageQuotaExceeded();

  useEffect(() => {
    if (lastExceeded) {
      toast.error('Storage Full', {
        description: lastExceeded.message,
        duration: 10000,
        action: {
          label: 'Sync Now',
          onClick: async () => {
            try {
              const wsClient = getWebSocketClient();
              await wsClient.syncPending();
              toast.success('Sync completed!');
            } catch (error) {
              toast.error('Sync failed');
              console.error('[StorageQuota] Manual sync failed:', error);
            }
          },
        },
      });
    }
  }, [lastExceeded]);

  return null; // This component doesn't render anything
}
