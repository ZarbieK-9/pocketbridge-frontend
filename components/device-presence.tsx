"use client"

/**
 * Device Presence Component
 * Shows real-time list of connected devices with status indicators
 */

import { useEffect, useState } from 'react';
import { Monitor, Smartphone, Globe, Circle, Activity, Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DeviceManagement } from '@/components/device-management';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { useWebSocket } from '@/hooks/use-websocket';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { config } from '@/lib/config';

export interface Device {
  device_id: string;
  device_name: string;
  device_type: 'mobile' | 'desktop' | 'web';
  is_current: boolean;
  last_seen: string;
  created_at: string;
}

export interface DevicePresence extends Device {
  is_online: boolean;
  last_activity?: string; // Last activity timestamp
  event_count?: number; // Number of events sent/received
  registered_at?: number; // Unix timestamp when device was registered
}

interface DevicePresenceListProps {
  apiUrl: string;
  userId: string;
  className?: string;
}

const deviceIcons = {
  mobile: Smartphone,
  desktop: Monitor,
  web: Globe,
};

function getDeviceIcon(type: 'mobile' | 'desktop' | 'web') {
  const Icon = deviceIcons[type] || Monitor;
  return <Icon className="h-5 w-5" />;
}

function formatLastSeen(lastSeen: string | number): string {
  // Handle both string (ISO date) and number (Unix timestamp)
  const date = typeof lastSeen === 'number' ? new Date(lastSeen) : new Date(lastSeen);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function DevicePresenceList({ apiUrl, userId, className }: DevicePresenceListProps) {
  const [devices, setDevices] = useState<DevicePresence[]>([]);
  const [userDisplayName, setUserDisplayName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const deviceId = getOrCreateDeviceId();
  const wsUrl = config.wsUrl;
  const { isConnected, lastSystemMessage } = useWebSocket({
    url: wsUrl,
    deviceId,
    autoConnect: true,
  });

  const sortDevices = (list: DevicePresence[]) => {
    return [...list].sort((a, b) => {
      if (a.is_online !== b.is_online) {
        return b.is_online ? 1 : -1;
      }
      const aTime = typeof a.last_seen === 'number' ? a.last_seen : (typeof a.last_seen === 'string' ? new Date(a.last_seen).getTime() : 0);
      const bTime = typeof b.last_seen === 'number' ? b.last_seen : (typeof b.last_seen === 'string' ? new Date(b.last_seen).getTime() : 0);
      return bTime - aTime;
    });
  };

  // Fetch devices
  useEffect(() => {
    let isActive = true;
    async function fetchDevices() {
      try {
        const response = await fetch(`${apiUrl}/api/devices`, {
          headers: {
            'X-User-ID': userId,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to fetch devices');
        }

        const data = await response.json();
        const allDevices: DevicePresence[] = data.devices || [];
        const sortedDevices = sortDevices(allDevices);
        if (isActive) {
          setDevices(sortedDevices);
          setUserDisplayName(data.user_display_name || null);
          setError(null);
        }
      } catch (err) {
        if (isActive) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    }

    fetchDevices();

    // Use polling only when WebSocket presence is unavailable
    if (isConnected) {
      return () => {
        isActive = false;
      };
    }

    const interval = setInterval(fetchDevices, 10000);

    return () => {
      isActive = false;
      clearInterval(interval);
    };
  }, [apiUrl, userId, isConnected]);

  useEffect(() => {
    if (!lastSystemMessage || lastSystemMessage.type !== 'device_status_changed') {
      return;
    }

    if (lastSystemMessage.user_id && lastSystemMessage.user_id !== userId) {
      return;
    }

    setDevices(prev => {
      const updated = [...prev];
      const idx = updated.findIndex(d => d.device_id === lastSystemMessage.device_id);
      const lastSeen = lastSystemMessage.timestamp || Date.now();
      const baseDevice: DevicePresence = {
        device_id: lastSystemMessage.device_id,
        device_name: lastSystemMessage.device_name || 'Unknown Device',
        device_type: lastSystemMessage.device_type || 'web',
        is_current: lastSystemMessage.device_id === deviceId,
        last_seen: lastSeen.toString(),
        created_at: new Date(lastSeen).toISOString(),
        is_online: lastSystemMessage.is_online,
      };

      if (idx >= 0) {
        updated[idx] = {
          ...updated[idx],
          is_online: lastSystemMessage.is_online,
          last_seen: lastSeen.toString(),
          device_name: lastSystemMessage.device_name || updated[idx].device_name,
          device_type: lastSystemMessage.device_type || updated[idx].device_type,
        };
      } else {
        updated.push(baseDevice);
      }

      return sortDevices(updated);
    });
  }, [lastSystemMessage, deviceId, userId]);

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription>Loading devices...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription className="text-destructive">Error: {error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Devices</CardTitle>
        <CardDescription>
          {devices.length} {devices.length === 1 ? 'device' : 'devices'} registered
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {devices.map((device) => (
            <div
              key={device.device_id}
              className={cn(
                "flex items-center justify-between p-3 rounded-lg border",
                device.is_current && "bg-accent"
              )}
            >
              <div className="flex items-center gap-3 flex-1">
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
                  {getDeviceIcon(device.device_type)}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium truncate">
                      {device.device_name || 'Unknown Device'}
                      {device.is_current && (
                        <span className="ml-2 text-xs text-muted-foreground">(This device)</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      <span>{formatLastSeen(device.last_seen)}</span>
                    </div>
                    {device.last_activity && (
                      <div className="flex items-center gap-1">
                        <Activity className="h-3 w-3" />
                        <span>
                          Active {formatDistanceToNow(new Date(device.last_activity), { addSuffix: true })}
                        </span>
                      </div>
                    )}
                    {device.event_count !== undefined && (
                      <span className="text-xs">
                        {device.event_count} {device.event_count === 1 ? 'event' : 'events'}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Circle
                  className={cn(
                    "h-2.5 w-2.5 fill-current",
                    device.is_online ? "text-green-500" : "text-gray-400"
                  )}
                />
                <span className="text-xs text-muted-foreground">
                  {device.is_online ? 'Online' : 'Offline'}
                </span>
              </div>

              {!device.is_current && (
                <DeviceManagement 
                  device={device}
                  apiUrl={apiUrl}
                  userId={userId}
                  onDeviceUpdated={() => {
                    // Trigger re-fetch
                    window.location.reload();
                  }}
                />
              )}
            </div>
          ))}

          {devices.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No connected devices yet
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
