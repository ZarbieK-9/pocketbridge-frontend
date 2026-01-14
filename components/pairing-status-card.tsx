'use client';

/**
 * Pairing Status Card
 * 
 * Shows current pairing state and next steps
 * - If not paired: Shows invitation to pair
 * - If paired: Shows connected devices
 * - Shows connection status and device count
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Smartphone,
  Plus,
  CheckCircle2,
  AlertCircle,
  WifiOff,
  Link as LinkIcon,
} from 'lucide-react';
import Link from 'next/link';

interface PairingStatusCardProps {
  isPaired: boolean;
  pairedDevicesCount: number;
  onlineDevicesCount: number;
  isConnected: boolean;
  isLoading?: boolean;
}

export function PairingStatusCard({
  isPaired,
  pairedDevicesCount,
  onlineDevicesCount,
  isConnected,
  isLoading = false,
}: PairingStatusCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="h-6 w-32 bg-muted rounded animate-pulse" />
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="h-4 w-full bg-muted rounded animate-pulse" />
            <div className="h-4 w-3/4 bg-muted rounded animate-pulse" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!isPaired) {
    return (
      <Card className="border-2 border-dashed border-blue-400 bg-blue-50/50 dark:bg-blue-950/20">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-blue-600" />
            No Devices Paired
          </CardTitle>
          <CardDescription>Get started by pairing your first device</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-medium text-sm">How it works:</h4>
            <ol className="text-xs text-muted-foreground space-y-1 ml-4">
              <li>1. Generate a pairing code on your main device</li>
              <li>2. Scan the QR code from another device</li>
              <li>3. Devices sync automatically with end-to-end encryption</li>
            </ol>
          </div>
          <Button asChild className="w-full gap-2 bg-blue-600 hover:bg-blue-700">
            <Link href="/pair">
              <Plus className="h-4 w-4" />
              Pair Your First Device
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
            <CardTitle className="text-base">
              {pairedDevicesCount} Device{pairedDevicesCount !== 1 ? 's' : ''} Connected
            </CardTitle>
          </div>
          <StatusBadge status={isConnected ? 'online' : 'offline'} />
        </div>
        <CardDescription>
          {onlineDevicesCount} device{onlineDevicesCount !== 1 ? 's' : ''} active now
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="p-3 rounded-lg bg-muted/50 space-y-2">
          {isConnected ? (
            <div className="flex items-center gap-2 text-sm">
              <div className="h-2 w-2 rounded-full bg-green-500" />
              <span className="text-muted-foreground">
                Connected to backend • All devices syncing
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <WifiOff className="h-4 w-4 text-yellow-600" />
              <span className="text-muted-foreground">
                Offline mode • Local changes will sync when back online
              </span>
            </div>
          )}
        </div>
        <Button variant="outline" className="w-full gap-2" asChild>
          <Link href="/pair">
            <Plus className="h-4 w-4" />
            Pair Another Device
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
