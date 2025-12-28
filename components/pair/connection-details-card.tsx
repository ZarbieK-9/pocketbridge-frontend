'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { getOrCreateDeviceName } from '@/lib/utils/device';
import { getWsUrl } from '@/lib/utils/storage';
import { config } from '@/lib/config';
import { Wifi, WifiOff, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type { ConnectionStatus } from '@/types';

interface ConnectionDetailsCardProps {
  deviceName?: string;
  wsUrl?: string;
  connectionStatus: ConnectionStatus;
  isConnected: boolean;
  connectionError?: Error | null;
}

export function ConnectionDetailsCard({
  deviceName,
  wsUrl,
  connectionStatus,
  isConnected,
  connectionError,
}: ConnectionDetailsCardProps) {
  // Use useState to avoid hydration mismatches - only get values on client
  const [displayDeviceName, setDisplayDeviceName] = useState<string>('Loading...');
  const [displayWsUrl, setDisplayWsUrl] = useState<string>('Loading...');
  
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setDisplayDeviceName(deviceName || getOrCreateDeviceName() || 'Unknown Device');
      setDisplayWsUrl(wsUrl || getWsUrl() || config.wsUrl || 'Not configured');
    }
  }, [deviceName, wsUrl]);

  const getStatusBadge = () => {
    if (isConnected) return 'online';
    if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') return 'syncing';
    if (connectionStatus === 'error') return 'error';
    return 'offline';
  };

  const getStatusIcon = () => {
    if (isConnected) {
      return <CheckCircle2 className="h-4 w-4 text-green-600" />;
    }
    if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') {
      return <Loader2 className="h-4 w-4 text-yellow-600 animate-spin" />;
    }
    if (connectionStatus === 'error') {
      return <AlertCircle className="h-4 w-4 text-red-600" />;
    }
    return <WifiOff className="h-4 w-4 text-gray-600" />;
  };

  const getStatusText = () => {
    if (isConnected) return 'Connected';
    if (connectionStatus === 'connecting') return 'Connecting...';
    if (connectionStatus === 'reconnecting') return 'Reconnecting...';
    if (connectionStatus === 'error') return 'Connection Error';
    return 'Disconnected';
  };

  const getStatusDescription = () => {
    if (isConnected) return 'Successfully connected to backend server';
    if (connectionStatus === 'connecting') return 'Establishing secure connection...';
    if (connectionStatus === 'reconnecting') return 'Attempting to reconnect...';
    if (connectionStatus === 'error') return 'Failed to connect to server';
    return 'Not connected to backend server';
  };

  return (
    <Card className="bg-muted">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Connection Details</CardTitle>
          <StatusBadge status={getStatusBadge()} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-left">
        <div className="text-sm">
          <span className="font-medium">Device:</span>{' '}
          <span className="text-muted-foreground">{displayDeviceName}</span>
        </div>
        <div className="text-sm">
          <span className="font-medium">Server:</span>{' '}
          <span className="text-muted-foreground font-mono text-xs">{displayWsUrl}</span>
        </div>
        
        {/* Enhanced Status Section */}
        <div className="pt-2 border-t border-border">
          <div className="flex items-center gap-2 mb-1">
            {getStatusIcon()}
            <span className="text-sm font-medium">{getStatusText()}</span>
          </div>
          <p className="text-xs text-muted-foreground ml-6">
            {getStatusDescription()}
          </p>
        </div>

        {connectionError && (
          <div className="text-xs text-red-600 mt-2 p-2 bg-red-50 border border-red-200 rounded" role="alert">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Error Details</p>
                <p className="mt-1">{connectionError.message}</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

