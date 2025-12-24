"use client"

/**
 * Device Presence Component
 * Shows real-time list of connected devices with status indicators
 */

import { useEffect, useState } from 'react';
import { Monitor, Smartphone, Globe, Circle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DeviceManagement } from '@/components/device-management';
import { cn } from '@/lib/utils';

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

function formatLastSeen(lastSeen: string): string {
  const date = new Date(lastSeen);
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch devices
  useEffect(() => {
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
        const onlineDevices = allDevices.filter((d) => d.is_online);
        setDevices(onlineDevices);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    fetchDevices();

    // Poll every 10 seconds for presence updates
    const interval = setInterval(fetchDevices, 10000);

    return () => clearInterval(interval);
  }, [apiUrl, userId]);

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
          {devices.length} {devices.length === 1 ? 'device' : 'devices'} connected
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
                      {device.device_name}
                      {device.is_current && (
                        <span className="ml-2 text-xs text-muted-foreground">(This device)</span>
                      )}
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {formatLastSeen(device.last_seen)}
                  </p>
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
