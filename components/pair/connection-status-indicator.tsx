'use client';

import { useEffect, useState } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { Wifi, WifiOff, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ConnectionStatus } from '@/types';

interface ConnectionStatusIndicatorProps {
  status: ConnectionStatus;
  isConnected: boolean;
  error?: Error | null;
  className?: string;
  showDetails?: boolean;
}

export function ConnectionStatusIndicator({
  status,
  isConnected,
  error,
  className,
  showDetails = false,
}: ConnectionStatusIndicatorProps) {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const getStatusBadge = () => {
    if (!isOnline) return 'offline';
    if (isConnected) return 'online';
    if (status === 'connecting' || status === 'reconnecting') return 'syncing';
    if (status === 'error') return 'error';
    return 'offline';
  };

  const getStatusIcon = () => {
    if (!isOnline) {
      return <WifiOff className="h-4 w-4 text-gray-500" />;
    }
    if (isConnected) {
      return <CheckCircle2 className="h-4 w-4 text-green-600" />;
    }
    if (status === 'connecting' || status === 'reconnecting') {
      return <Loader2 className="h-4 w-4 text-yellow-600 animate-spin" />;
    }
    if (status === 'error') {
      return <AlertCircle className="h-4 w-4 text-red-600" />;
    }
    return <WifiOff className="h-4 w-4 text-gray-500" />;
  };

  const getStatusText = () => {
    if (!isOnline) return 'Offline';
    if (isConnected) return 'Connected';
    if (status === 'connecting') return 'Connecting';
    if (status === 'reconnecting') return 'Reconnecting';
    if (status === 'error') return 'Error';
    return 'Disconnected';
  };

  const getStatusColor = () => {
    if (!isOnline) return 'text-gray-600';
    if (isConnected) return 'text-green-600';
    if (status === 'connecting' || status === 'reconnecting') return 'text-yellow-600';
    if (status === 'error') return 'text-red-600';
    return 'text-gray-600';
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {getStatusIcon()}
      <StatusBadge status={getStatusBadge()} />
      {showDetails && (
        <span className={cn('text-sm font-medium', getStatusColor())}>
          {getStatusText()}
        </span>
      )}
      {error && showDetails && (
        <span className="text-xs text-red-600 ml-2" title={error.message}>
          {error.message.substring(0, 30)}...
        </span>
      )}
    </div>
  );
}

