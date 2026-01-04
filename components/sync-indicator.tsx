/**
 * Sync Indicator Component
 * Shows visual feedback when content is syncing across devices
 */

'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SyncStatus = 'idle' | 'sending' | 'synced' | 'error';

interface SyncIndicatorProps {
  status: SyncStatus;
  message?: string;
  className?: string;
}

export function SyncIndicator({ status, message, className }: SyncIndicatorProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (status === 'sending' || status === 'synced') {
      setShow(true);
      if (status === 'synced') {
        const timer = setTimeout(() => setShow(false), 2000);
        return () => clearTimeout(timer);
      }
    } else {
      setShow(false);
    }
  }, [status]);

  if (!show) return null;

  const icons: Record<Exclude<SyncStatus, 'idle'>, typeof Loader2> = {
    sending: Loader2,
    synced: CheckCircle2,
    error: Send,
  };

  const styles: Record<Exclude<SyncStatus, 'idle'>, string> = {
    sending: 'text-primary',
    synced: 'text-green-600',
    error: 'text-red-600',
  };

  const messages: Record<Exclude<SyncStatus, 'idle'>, string> = {
    sending: 'Syncing...',
    synced: 'Synced',
    error: 'Sync failed',
  };

  // Status is guaranteed to not be 'idle' here due to early return above
  const Icon = icons[status as Exclude<SyncStatus, 'idle'>] || Send;

  return (
    <div
      className={cn(
        'flex items-center gap-2 text-xs text-muted-foreground',
        className
      )}
    >
      <Icon
        className={cn(
          'h-3 w-3',
          status === 'sending' && 'animate-spin',
          styles[status as Exclude<SyncStatus, 'idle'>]
        )}
      />
      <span className={cn(styles[status as Exclude<SyncStatus, 'idle'>])}>
        {message || messages[status as Exclude<SyncStatus, 'idle'>]}
      </span>
    </div>
  );
}

