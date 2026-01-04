"use client"

/**
 * Device Management Component
 * Allows users to rename and revoke devices
 */

import { useState } from 'react';
import { Monitor, Smartphone, Globe, Pencil, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DevicePresence } from './device-presence';

interface DeviceManagementProps {
  device: DevicePresence;
  apiUrl: string;
  userId: string;
  onDeviceUpdated?: () => void;
}

const deviceIcons = {
  mobile: Smartphone,
  desktop: Monitor,
  web: Globe,
};

export function DeviceManagement({ device, apiUrl, userId, onDeviceUpdated }: DeviceManagementProps) {
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isRevokeOpen, setIsRevokeOpen] = useState(false);
  const [newName, setNewName] = useState(device.device_name);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const Icon = deviceIcons[device.device_type] || Monitor;

  async function handleRename() {
    if (!newName.trim()) {
      setError('Device name cannot be empty');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${apiUrl}/api/devices/${device.device_id}/rename`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({ device_name: newName.trim() }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to rename device');
      }

      setIsRenameOpen(false);
      onDeviceUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${apiUrl}/api/devices/${device.device_id}`, {
        method: 'DELETE',
        headers: {
          'X-User-ID': userId,
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to revoke device');
      }

      setIsRevokeOpen(false);
      onDeviceUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex gap-2">
      {/* Rename Dialog */}
      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" disabled={device.is_current}>
            <Pencil className="h-4 w-4" />
            <span className="sr-only">Rename device</span>
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Device</DialogTitle>
            <DialogDescription>
              Give this device a memorable name
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-3 p-4 rounded-lg border bg-muted/50">
            <Icon className="h-8 w-8" />
            <div>
              <p className="font-medium">{device.device_name}</p>
              <p className="text-sm text-muted-foreground capitalize">{device.device_type}</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="device-name">New Name</Label>
            <Input
              id="device-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Enter device name"
              disabled={loading}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRenameOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={loading}>
              {loading ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Dialog */}
      <Dialog open={isRevokeOpen} onOpenChange={setIsRevokeOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" disabled={device.is_current}>
            <Trash2 className="h-4 w-4 text-destructive" />
            <span className="sr-only">Revoke device</span>
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke Device Access</DialogTitle>
            <DialogDescription>
              This device will be permanently disconnected and all data removed.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-3 p-4 rounded-lg border border-destructive bg-destructive/10">
            <Icon className="h-8 w-8 text-destructive" />
            <div>
              <p className="font-medium">{device.device_name}</p>
              <p className="text-sm text-muted-foreground capitalize">{device.device_type}</p>
            </div>
          </div>

          <div className="bg-muted p-4 rounded-lg">
            <p className="text-sm">
              <strong>Warning:</strong> This action cannot be undone. The device will need to pair again to reconnect.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRevokeOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRevoke} disabled={loading}>
              {loading ? 'Revoking...' : 'Revoke Access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
