/**
 * Settings page
 */

"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { MainLayout } from "@/components/layout/main-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PWAInstaller } from "@/components/pwa-installer"
import { SessionTimeout } from "@/components/session-timeout"
import { useCrypto } from "@/hooks/use-crypto"
import { useWebSocket } from "@/hooks/use-websocket"
import { useNotifications } from "@/hooks/use-notifications"
import { getOrCreateDeviceId, getOrCreateDeviceName, updateDeviceName } from "@/lib/utils/device"
import { getWsUrl } from "@/lib/utils/storage"
import { config } from "@/lib/config"
import { validateDeviceName } from "@/lib/utils/validation"
import { logger } from "@/lib/utils/logger"
import { ValidationError } from "@/lib/utils/errors"
import { downloadBackup, importData, checkDataIntegrity, clearAllData } from "@/lib/utils/data-persistence"
import { clearUserProfile } from "@/lib/utils/user-profile"
import { analytics } from "@/lib/utils/analytics"
import { SyncStatus } from "@/components/sync-status"
import { StorageQuotaMonitor } from "@/components/storage-quota-monitor"
import { toast } from "sonner"
import { Settings, Smartphone, KeyRound, QrCode, ScanLine, Palette, Bell, BellOff, ShieldCheck, Database, Download, Upload, CheckCircle2, Trash2, KeySquare, UserX, RefreshCw, HardDrive, ChevronRight, Link2Off } from "lucide-react"
import { cn } from "@/lib/utils"

export default function SettingsPage() {
  const { identityKeyPair, isInitialized } = useCrypto();
  const deviceId = getOrCreateDeviceId();
  const [deviceName, setDeviceName] = React.useState('');
  const [isDeletingAccount, setIsDeletingAccount] = React.useState(false);

  // Theme settings
  const { theme, setTheme } = useTheme();

  // Notification settings
  const {
    isSupported: notificationsSupported,
    permission: notificationPermission,
    isEnabled: notificationsEnabled,
    requestPermission,
    setEnabled: setNotificationsEnabled,
  } = useNotifications();

  // Get WebSocket URL and derive API URL
  const wsUrl = getWsUrl() || config.wsUrl;
  const apiUrl = config.apiUrl;
  const userId = identityKeyPair?.publicKeyHex || null;

  // Get session expiration from WebSocket client
  const { sessionKeys, sessionExpiresAt: wsSessionExpiresAt } = useWebSocket({
    url: wsUrl,
    deviceId,
    autoConnect: isInitialized,
  });

  // Convert session expiration timestamp to Date
  const sessionExpiresAt = React.useMemo(() => {
    if (wsSessionExpiresAt) {
      return new Date(wsSessionExpiresAt);
    }
    // Fallback to 24 hours from now if not available yet
    return sessionKeys ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;
  }, [wsSessionExpiresAt, sessionKeys]);

  React.useEffect(() => {
    const currentDeviceName = getOrCreateDeviceName();
    setDeviceName(currentDeviceName);
  }, []);

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

  const deleteAccount = async () => {
    if (!userId) {
      alert('No user identity available. Cannot delete account.');
      return;
    }

    const confirmed = confirm(
      'Are you sure you want to delete your account?\n\n' +
      'This will permanently delete:\n' +
      '- All your devices\n' +
      '- All synced data\n' +
      '- Your user profile\n\n' +
      'This action cannot be undone!'
    );

    if (!confirmed) return;

    // Double confirmation for destructive action
    const doubleConfirmed = confirm(
      'This is your final warning.\n\n' +
      'Type "DELETE" in your mind and click OK to permanently delete your account.'
    );

    if (!doubleConfirmed) return;

    setIsDeletingAccount(true);
    try {
      const response = await fetch(`${apiUrl}/api/user`, {
        method: 'DELETE',
        headers: {
          'X-User-ID': userId,
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete account');
      }

      // Clear all local data
      await clearAllData();
      clearUserProfile();
      localStorage.removeItem('pocketbridge_identity_keypair');

      analytics.track('account_deleted');
      alert('Your account has been deleted. You will be redirected to the home page.');
      window.location.href = '/';
    } catch (error) {
      logger.error('Failed to delete account', error);
      alert('Failed to delete account. Please try again.');
    } finally {
      setIsDeletingAccount(false);
    }
  };

  return (
    <MainLayout>
      {/* Gradient Header */}
      <div className="border-b border-border bg-linear-to-b from-blue-50/60 to-card dark:from-blue-950/20 dark:to-card animate-in fade-in duration-400">
        <div className="px-6 py-5">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-1">
          {/* Session Status */}
          {sessionExpiresAt && (
            <div className="mb-4">
              <SessionTimeout
                expiresAt={sessionExpiresAt}
                onRefresh={() => logger.info('Session refresh requested')}
                onExpired={() => logger.warn('Session expired')}
              />
            </div>
          )}

          {/* DEVICE INFORMATION */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '100ms', animationFillMode: 'backwards' }}>
            <h2 className="mb-2 ml-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Device Information</h2>
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="flex items-center gap-3.5 px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/40">
                  <Smartphone className="h-4 w-4 text-blue-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <Label htmlFor="device-name" className="text-sm">Device Name</Label>
                </div>
                <Input
                  id="device-name"
                  value={deviceName}
                  onChange={(e) => handleDeviceNameChange(e.target.value)}
                  placeholder="Enter device name"
                  className="w-40 h-8 text-sm text-right border-0 shadow-none focus-visible:ring-0"
                />
              </div>
              <div className="mx-4 h-px bg-border" />
              <div className="flex items-center gap-3.5 px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">Device ID</p>
                </div>
                <p className="text-xs font-mono text-muted-foreground">{deviceId.substring(0, 8)}...</p>
              </div>
              {identityKeyPair?.publicKeyHex && (
                <>
                  <div className="mx-4 h-px bg-border" />
                  <div className="flex items-center gap-3.5 px-4 py-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-950/40">
                      <ShieldCheck className="h-4 w-4 text-emerald-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground">Public Key</p>
                    </div>
                    <p className="text-xs font-mono text-muted-foreground">{identityKeyPair.publicKeyHex.substring(0, 12)}...</p>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* DEVICE PAIRING */}
          <div className="pt-5 animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '200ms', animationFillMode: 'backwards' }}>
            <h2 className="mb-2 ml-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Device Pairing</h2>
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <a href="/pair" className="flex items-center gap-3.5 px-4 py-3 transition-colors hover:bg-muted/50">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/40">
                  <QrCode className="h-4 w-4 text-blue-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Pair Device</p>
                  <p className="text-xs text-muted-foreground">Generate or scan a pairing code</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </a>
            </div>
          </div>

          {/* APPEARANCE */}
          <div className="pt-5 animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '250ms', animationFillMode: 'backwards' }}>
            <h2 className="mb-2 ml-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Appearance</h2>
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="flex items-center gap-3.5 px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-950/40">
                  <Palette className="h-4 w-4 text-violet-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Theme</p>
                  <p className="text-xs text-muted-foreground">Color scheme preference</p>
                </div>
                <Select value={theme} onValueChange={setTheme}>
                  <SelectTrigger className="w-28 h-8 text-xs border-0 shadow-none">
                    <SelectValue placeholder="Select theme" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* INSTALL APP */}
          <div className="pt-5 animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '300ms', animationFillMode: 'backwards' }}>
            <h2 className="mb-2 ml-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Install App</h2>
            <div className="rounded-2xl border border-border bg-card overflow-hidden px-4 py-3">
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-950/40">
                  <Smartphone className="h-4 w-4 text-emerald-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Download Android APK</p>
                  <p className="text-xs text-muted-foreground">Open the link to get the latest build</p>
                </div>
                <a
                  href="https://expo.dev/accounts/zarbiek-9/projects/mobile-agent/builds/6f51f580-daf3-401a-b536-5792c5c1e5db"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-blue-600 hover:text-blue-700"
                >
                  Download
                </a>
              </div>
            </div>
          </div>

          {/* PREFERENCES */}
          <div className="pt-5 animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '350ms', animationFillMode: 'backwards' }}>
            <h2 className="mb-2 ml-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Preferences</h2>
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="flex items-center gap-3.5 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Sync on mobile data</p>
                  <p className="text-xs text-muted-foreground">Allow syncing over cellular</p>
                </div>
                <Switch />
              </div>
              <div className="mx-4 h-px bg-border" />
              <div className="flex items-center gap-3.5 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Offline mode</p>
                  <p className="text-xs text-muted-foreground">Queue changes when offline</p>
                </div>
                <Switch defaultChecked />
              </div>
              <div className="mx-4 h-px bg-border" />
              <div className="flex items-center gap-3.5 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Require device verification</p>
                  <p className="text-xs text-muted-foreground">New devices must be approved</p>
                </div>
                <Switch defaultChecked />
              </div>
              {/* Notifications */}
              {notificationsSupported && (
                <>
                  <div className="mx-4 h-px bg-border" />
                  <div className="flex items-center gap-3.5 px-4 py-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-950/40">
                      {notificationsEnabled ? (
                        <Bell className="h-4 w-4 text-amber-500" />
                      ) : (
                        <BellOff className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">Push notifications</p>
                      <p className="text-xs text-muted-foreground">
                        {notificationPermission === 'denied'
                          ? 'Blocked in browser settings'
                          : 'Get notified on new messages'}
                      </p>
                    </div>
                    {notificationPermission === 'default' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs rounded-lg"
                        onClick={async () => {
                          const result = await requestPermission();
                          if (result === 'granted') {
                            await setNotificationsEnabled(true);
                          }
                        }}
                      >
                        Enable
                      </Button>
                    ) : (
                      <Switch
                        checked={notificationsEnabled}
                        onCheckedChange={setNotificationsEnabled}
                        disabled={notificationPermission === 'denied'}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* SYNC & STORAGE */}
          <div className="pt-5 animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '400ms', animationFillMode: 'backwards' }}>
            <h2 className="mb-2 ml-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sync & Storage</h2>
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-3">
                <SyncStatus
                  showDetails={true}
                  refreshInterval={3000}
                  onSyncTrigger={() => {
                    toast.info('Syncing pending events...', { duration: 2000 });
                    analytics.track('manual_sync_triggered');
                  }}
                />
              </div>
              <div className="mx-4 h-px bg-border" />
              <div className="px-4 py-3">
                <StorageQuotaMonitor
                  showDetails={true}
                  onQuotaExceeded={(msg) => {
                    console.error('[Settings] Storage quota exceeded:', msg);
                    analytics.track('storage_quota_exceeded');
                  }}
                  onWarningLevelChange={(level) => {
                    if (level === 'critical') {
                      toast.warning('Storage critically low!', {
                        description: 'Consider syncing your data soon to free up space.',
                      });
                      analytics.track('storage_warning', { level });
                    }
                  }}
                />
              </div>
            </div>
          </div>

          {/* DATA MANAGEMENT */}
          <div className="pt-5 animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '450ms', animationFillMode: 'backwards' }}>
            <h2 className="mb-2 ml-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Data Management</h2>
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <button onClick={handleExportData} className="flex w-full items-center gap-3.5 px-4 py-3 transition-colors hover:bg-muted/50">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/40">
                  <Download className="h-4 w-4 text-blue-500" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-sm font-medium text-foreground">Export Data</p>
                  <p className="text-xs text-muted-foreground">Download a backup of your data</p>
                </div>
              </button>
              <div className="mx-4 h-px bg-border" />
              <button onClick={handleImportData} className="flex w-full items-center gap-3.5 px-4 py-3 transition-colors hover:bg-muted/50">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-950/40">
                  <Upload className="h-4 w-4 text-emerald-500" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-sm font-medium text-foreground">Import Data</p>
                  <p className="text-xs text-muted-foreground">Restore from a backup file</p>
                </div>
              </button>
            </div>
          </div>

          {/* Security trust note */}
          <div className="flex items-center gap-2 px-1 pt-4 animate-in fade-in duration-400" style={{ animationDelay: '500ms', animationFillMode: 'backwards' }}>
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            <p className="text-xs text-muted-foreground">All data is end-to-end encrypted. Your keys never leave this device.</p>
          </div>

          {/* DANGER ZONE */}
          <div className="pt-5 animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '550ms', animationFillMode: 'backwards' }}>
            <h2 className="mb-2 ml-1 text-xs font-semibold uppercase tracking-wider text-red-500">Danger Zone</h2>
            <div className="rounded-2xl border border-red-200 dark:border-red-900/50 bg-card overflow-hidden">
              <button onClick={clearDatabase} className="flex w-full items-center gap-3.5 px-4 py-3 transition-colors hover:bg-red-50/50 dark:hover:bg-red-950/20">
                <Trash2 className="h-5 w-5 text-red-500" />
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">Clear all data</p>
                  <p className="text-xs text-muted-foreground">Remove all synced data from this device</p>
                </div>
              </button>
              <div className="mx-4 h-px bg-red-200 dark:bg-red-900/50" />
              <button onClick={resetCryptoKeys} className="flex w-full items-center gap-3.5 px-4 py-3 transition-colors hover:bg-red-50/50 dark:hover:bg-red-950/20">
                <KeySquare className="h-5 w-5 text-red-500" />
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">Reset encryption keys</p>
                  <p className="text-xs text-muted-foreground">Generate new keys (will disconnect devices)</p>
                </div>
              </button>
              <div className="mx-4 h-px bg-red-200 dark:bg-red-900/50" />
              <button
                onClick={deleteAccount}
                disabled={isDeletingAccount || !userId}
                className="flex w-full items-center gap-3.5 px-4 py-3 transition-colors hover:bg-red-50/50 dark:hover:bg-red-950/20 disabled:opacity-50"
              >
                <UserX className="h-5 w-5 text-red-500" />
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">
                    {isDeletingAccount ? 'Deleting account...' : 'Delete account'}
                  </p>
                  <p className="text-xs text-muted-foreground">Permanently delete your account and all data</p>
                </div>
              </button>
            </div>
          </div>

          {/* Footer */}
          <p className="pt-6 pb-4 text-center text-xs text-muted-foreground">PocketBridge Web v0.1.0</p>
        </div>
      </div>
    </MainLayout>
  )
}
