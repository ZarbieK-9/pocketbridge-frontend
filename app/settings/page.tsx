/**
 * Settings page
 */

"use client"

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

// TODO: Get these from context/config
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const USER_ID = 'test-user-id'; // TODO: Get from auth context
const SESSION_EXPIRES = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

export default function SettingsPage() {
  return (
    <MainLayout>
      <Header title="Settings" description="Manage your PocketBridge preferences" />

      <div className="p-6 space-y-6">
        {/* Session Status */}
        <SessionTimeout 
          expiresAt={SESSION_EXPIRES}
          onRefresh={() => console.log('Refresh session')}
          onExpired={() => console.log('Session expired')}
        />

        {/* Connected Devices */}
        <DevicePresenceList 
          apiUrl={API_URL}
          userId={USER_ID}
        />

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
              <Input id="device-name" defaultValue={`Desktop - ${new Date().toLocaleDateString()}`} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-id">Device ID</Label>
              <Input id="device-id" value="xxxx-xxxx-xxxx-xxxx" disabled className="font-mono text-sm" />
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
              <Input value="xxxxxxxxxxxxxxxxxx" disabled className="font-mono text-xs" />
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
              <Button variant="destructive">Clear Data</Button>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Reset encryption keys</p>
                <p className="text-sm text-muted-foreground">Generate new keys (will disconnect devices)</p>
              </div>
              <Button variant="destructive">Reset Keys</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  )
}
