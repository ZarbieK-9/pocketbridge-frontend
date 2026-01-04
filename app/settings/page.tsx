/**
 * Settings page
 */

"use client"

import * as React from "react"
import { MainLayout } from "@/components/layout/main-layout"
import { Header } from "@/components/layout/header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { PWAInstaller } from "@/components/pwa-installer"
import { DevicePresenceList } from "@/components/device-presence"
import { SessionTimeout } from "@/components/session-timeout"
import { useCrypto } from "@/hooks/use-crypto"
import { useWebSocket } from "@/hooks/use-websocket"
import { getOrCreateDeviceId, getOrCreateDeviceName, updateDeviceName } from "@/lib/utils/device"
import { getWsUrl } from "@/lib/utils/storage"
import { config } from "@/lib/config"
import { validateDeviceName } from "@/lib/utils/validation"
import { logger } from "@/lib/utils/logger"
import { ValidationError } from "@/lib/utils/errors"
import { downloadBackup, importData, checkDataIntegrity, clearAllData } from "@/lib/utils/data-persistence"
import { analytics } from "@/lib/utils/analytics"

export default function SettingsPage() {
  const { identityKeyPair, isInitialized } = useCrypto();
  const deviceId = getOrCreateDeviceId();
  const [deviceName, setDeviceName] = React.useState('');
  const [sessionExpiresAt, setSessionExpiresAt] = React.useState<Date | null>(null);
  
  // Get WebSocket URL and derive API URL
  const wsUrl = getWsUrl() || config.wsUrl;
  const apiUrl = config.apiUrl;
  const userId = identityKeyPair?.publicKeyHex || null;

  // Get session expiration from WebSocket client
  const { sessionKeys } = useWebSocket({
    url: wsUrl,
    deviceId,
    autoConnect: isInitialized,
  });

  React.useEffect(() => {
    const currentDeviceName = getOrCreateDeviceName();
    setDeviceName(currentDeviceName);
  }, []);

  React.useEffect(() => {
    // Session expiration is managed by the WebSocket client
    // For now, we'll show a placeholder (24 hours from now)
    // In a real implementation, this would come from the session_established message
    setSessionExpiresAt(new Date(Date.now() + 24 * 60 * 60 * 1000));
  }, [sessionKeys]);

  const handleDeviceNameChange = async (newName: string) => {
    try {
      // Validate and sanitize device name
      const validatedName = validateDeviceName(newName);
      setDeviceName(validatedName);
      updateDeviceName(validatedName);
      
      // Update device name on backend via API
      try {
        if (!userId) {
          logger.warn('Cannot update device name: user ID not available');
          return;
        }
        const response = await fetch(`${apiUrl}/api/devices/${deviceId}/rename`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-ID': userId,
          },
          body: JSON.stringify({ device_name: validatedName }),
        });
        if (!response.ok) {
          logger.warn('Failed to update device name on backend', { status: response.status });
        } else {
          logger.info('Device name updated', { deviceId, name: validatedName });
        }
      } catch (error) {
        logger.error('Error updating device name on backend', error);
        // Non-blocking: device name is saved locally even if backend update fails
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        alert(error.message);
      } else {
        logger.error('Error validating device name', error);
        alert('Invalid device name. Please try again.');
      }
    }
  };

  const handleExportData = async () => {
    try {
      await downloadBackup();
      analytics.track('data_exported');
      alert('Data exported successfully!');
    } catch (error) {
      logger.error('Failed to export data', error);
      alert('Failed to export data. Please try again.');
    }
  };

  const handleImportData = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        await importData(text);
        analytics.track('data_imported');
        alert('Data imported successfully! Please refresh the page.');
        window.location.reload();
      } catch (error) {
        logger.error('Failed to import data', error);
        alert('Failed to import data. Please check the file format.');
      }
    };
    input.click();
  };

  const handleCheckIntegrity = async () => {
    try {
      const result = await checkDataIntegrity();
      if (result.healthy) {
        alert('Data integrity check passed! All data is healthy.');
      } else {
        alert(`Data integrity issues found:\n${result.issues.join('\n')}`);
      }
      analytics.track('integrity_check', { healthy: result.healthy, issueCount: result.issues.length });
    } catch (error) {
      logger.error('Failed to check data integrity', error);
      alert('Failed to check data integrity. Please try again.');
    }
  };

  const clearDatabase = async () => {
    if (!confirm('Are you sure you want to clear all local data? This cannot be undone.')) {
      return;
    }
    try {
      await clearAllData();
      alert('All local data cleared successfully. Please refresh the page.');
      analytics.track('data_cleared');
      window.location.reload();
    } catch (error) {
      logger.error('Failed to clear database', error);
      alert('Failed to clear database. Please try again.');
    }
  };

  const resetCryptoKeys = async () => {
    if (!confirm('Are you sure you want to reset your cryptographic keys? This will require re-pairing all devices. This cannot be undone.')) {
      return;
    }
    try {
      // Clear identity keypair from localStorage
      localStorage.removeItem('pocketbridge_identity_keypair');
      alert('Cryptographic keys reset. Please refresh the page and re-pair your devices.');
      analytics.track('keys_reset');
      window.location.reload();
    } catch (error) {
      logger.error('Failed to reset keys', error);
      alert('Failed to reset keys. Please try again.');
    }
  };

  return (
    <MainLayout>
      <Header title="Settings" description="Manage your PocketBridge preferences" />

      <div className="p-6 space-y-6">
        {/* Session Status */}
        {sessionExpiresAt && (
        <SessionTimeout 
          expiresAt={sessionExpiresAt}
          onRefresh={() => console.log('Refresh session')}
          onExpired={() => console.log('Session expired')}
        />)}

        {/* Connected Devices */}
        {userId ? (
          <DevicePresenceList 
            apiUrl={apiUrl}
            userId={userId}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Connected Devices</CardTitle>
              <CardDescription>Manage your synced devices</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <p className="text-sm text-muted-foreground">No user identity available</p>
                <p className="mt-2 text-xs text-muted-foreground">Pair or initialize crypto to connect devices</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pair Device */}
        <Card>
          <CardHeader>
            <CardTitle>Pair Device</CardTitle>
            <CardDescription>Connect to your desktop app by scanning a QR code</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <a href="/pair">Scan QR Code</a>
            </Button>
          </CardContent>
        </Card>

        {/* PWA Install */}
        <Card>
          <CardHeader>
            <CardTitle>Install App</CardTitle>
            <CardDescription>Install PocketBridge as a standalone app for better performance and background sync</CardDescription>
          </CardHeader>
          <CardContent>
            <PWAInstaller />
          </CardContent>
        </Card>

        {/* Device Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Device Settings</CardTitle>
            <CardDescription>Configure this device</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="device-name">Device Name</Label>
              <Input 
                id="device-name" 
                value={deviceName} 
                onChange={(e) => handleDeviceNameChange(e.target.value)}
                placeholder="Enter device name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-id">Device ID</Label>
              <Input id="device-id" value={deviceId} disabled className="font-mono text-sm" />
            </div>
          </CardContent>
        </Card>

        {/* Sync Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Sync Settings</CardTitle>
            <CardDescription>Control how data syncs between devices</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Auto-sync clipboard</Label>
                <p className="text-sm text-muted-foreground">Automatically sync clipboard content</p>
              </div>
              <Switch defaultChecked />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Sync on mobile data</Label>
                <p className="text-sm text-muted-foreground">Allow syncing over cellular connection</p>
              </div>
              <Switch />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Offline mode</Label>
                <p className="text-sm text-muted-foreground">Queue changes when offline</p>
              </div>
              <Switch defaultChecked />
            </div>
          </CardContent>
        </Card>

        {/* Security Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>Manage encryption and security settings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Public Key</Label>
              <Input 
                value={identityKeyPair?.publicKeyHex || 'Not available'} 
                disabled 
                className="font-mono text-xs" 
              />
              <p className="text-xs text-muted-foreground">Your device's public key for E2E encryption</p>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Require device verification</Label>
                <p className="text-sm text-muted-foreground">New devices must be approved</p>
              </div>
              <Switch defaultChecked />
            </div>
          </CardContent>
        </Card>

        {/* Data Management */}
        <Card>
          <CardHeader>
            <CardTitle>Data Management</CardTitle>
            <CardDescription>Backup, restore, and manage your data</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleExportData}>
                Export Data
              </Button>
              <Button variant="outline" onClick={handleImportData}>
                Import Data
              </Button>
              <Button variant="outline" onClick={handleCheckIntegrity}>
                Check Integrity
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Export your data as a backup, import from a backup, or check data integrity.
            </p>
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">Danger Zone</CardTitle>
            <CardDescription>Irreversible actions</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Clear all data</p>
                <p className="text-sm text-muted-foreground">Remove all synced data from this device</p>
              </div>
              <Button variant="destructive" onClick={clearDatabase}>Clear Data</Button>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Reset encryption keys</p>
                <p className="text-sm text-muted-foreground">Generate new keys (will disconnect devices)</p>
              </div>
              <Button variant="destructive" onClick={resetCryptoKeys}>Reset Keys</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  )
}
