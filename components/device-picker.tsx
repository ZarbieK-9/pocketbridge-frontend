/**
 * Device Picker Component
 * Allows users to select specific devices for targeted sending
 * Default: Send to all devices (Apple-like behavior)
 */

'use client';

import { useEffect, useState } from 'react';
import { Check, Monitor, Smartphone, Globe, Send } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface Device {
  device_id: string;
  device_name: string;
  device_type: 'mobile' | 'desktop' | 'web';
  is_online: boolean;
  is_current?: boolean;
}

interface DevicePickerProps {
  devices: Device[];
  selectedDeviceIds?: string[];
  onSelectionChange?: (deviceIds: string[]) => void;
  onSend?: (deviceIds: string[]) => void;
  trigger?: React.ReactNode;
  defaultToAll?: boolean; // If true, "All Devices" is selected by default
}

const deviceIcons = {
  mobile: Smartphone,
  desktop: Monitor,
  web: Globe,
};

export function DevicePicker({
  devices,
  selectedDeviceIds = [],
  onSelectionChange,
  onSend,
  trigger,
  defaultToAll = true,
}: DevicePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(
    new Set(selectedDeviceIds)
  );
  const [selectAll, setSelectAll] = useState(defaultToAll);

  // Initialize selection
  useEffect(() => {
    if (defaultToAll && selection.size === 0) {
      const allIds = devices
        .filter((d) => d.is_online && !d.is_current)
        .map((d) => d.device_id);
      setSelection(new Set(allIds));
      setSelectAll(true);
    }
  }, [defaultToAll, devices]);

  const onlineDevices = devices.filter((d) => d.is_online && !d.is_current);

  const handleToggleAll = (checked: boolean) => {
    setSelectAll(checked);
    if (checked) {
      const allIds = onlineDevices.map((d) => d.device_id);
      setSelection(new Set(allIds));
      onSelectionChange?.(Array.from(allIds));
    } else {
      setSelection(new Set());
      onSelectionChange?.([]);
    }
  };

  const handleToggleDevice = (deviceId: string, checked: boolean) => {
    const newSelection = new Set(selection);
    if (checked) {
      newSelection.add(deviceId);
    } else {
      newSelection.delete(deviceId);
      setSelectAll(false);
    }
    setSelection(newSelection);
    onSelectionChange?.(Array.from(newSelection));
  };

  const handleSend = () => {
    if (selectAll || selection.size > 0) {
      const deviceIds = selectAll
        ? onlineDevices.map((d) => d.device_id)
        : Array.from(selection);
      onSend?.(deviceIds);
      setIsOpen(false);
    }
  };

  const selectedCount = selectAll ? onlineDevices.length : selection.size;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Send className="mr-2 h-4 w-4" />
            Send to Devices
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Select Devices</DialogTitle>
          <DialogDescription>
            Choose which devices to send to. Default: All devices (Apple-like)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Select All Option */}
          <div className="flex items-center space-x-2 p-3 rounded-lg border bg-muted/50">
            <Checkbox
              id="select-all"
              checked={selectAll}
              onCheckedChange={handleToggleAll}
            />
            <Label
              htmlFor="select-all"
              className="flex-1 cursor-pointer font-medium"
            >
              All Devices ({onlineDevices.length})
            </Label>
            {selectAll && (
              <Check className="h-4 w-4 text-green-600" />
            )}
          </div>

          {/* Individual Devices */}
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {onlineDevices.map((device) => {
              const Icon = deviceIcons[device.device_type] || Monitor;
              const isSelected =
                selectAll || selection.has(device.device_id);

              return (
                <div
                  key={device.device_id}
                  className={cn(
                    'flex items-center space-x-2 p-3 rounded-lg border transition-colors',
                    isSelected && 'bg-accent border-primary/20'
                  )}
                >
                  <Checkbox
                    id={device.device_id}
                    checked={isSelected}
                    onCheckedChange={(checked) =>
                      handleToggleDevice(device.device_id, checked as boolean)
                    }
                    disabled={selectAll}
                  />
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <Label
                    htmlFor={device.device_id}
                    className="flex-1 cursor-pointer"
                  >
                    {device.device_name}
                  </Label>
                  {isSelected && !selectAll && (
                    <Check className="h-4 w-4 text-green-600" />
                  )}
                </div>
              );
            })}
          </div>

          {onlineDevices.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No other devices online
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          {onSend && (
            <Button
              onClick={handleSend}
              disabled={!selectAll && selection.size === 0}
            >
              Send to {selectedCount} {selectedCount === 1 ? 'Device' : 'Devices'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

