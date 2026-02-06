"use client";
 
/**
 * Dashboard page - overview of devices and quick actions
 * 
 * Journey Flow:
 * 1. User completes onboarding (onboardingCompleted = true)
 * 2. Shows pairing invitation or paired devices
 * 3. Displays connection status and device list
 * 4. Quick action buttons for all features
 * 5. No redirect to onboarding after completion
 */

import { MainLayout } from "@/components/layout/main-layout"
import { Header } from "@/components/layout/header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Clipboard, FileText, MessageSquare, FolderOpen, Plus, Smartphone, Check, AlertCircle, Download, File } from "lucide-react"
import { DevicePresenceList } from "@/components/device-presence"
import { useCrypto } from "@/hooks/use-crypto"
import { useWebSocket } from "@/hooks/use-websocket"
import { loadUserProfile, type UserProfile } from "@/lib/utils/user-profile"
import { getOrCreateDeviceId, getDeviceRole } from "@/lib/utils/device"
import { getWsUrl, loadPairedAccount, savePairedAccount, updatePairedDevices, type PairedAccountInfo } from "@/lib/utils/storage"
import { useEffect, useState, useRef } from "react"
import { logger } from "@/lib/utils/logger"
import Link from "next/link"

interface PairedDevice {
  device_id: string;
  device_name: string;
  user_id: string;
  user_display_name?: string; // User's display name from profile
  is_online: boolean;
  last_activity: string | null;
  updated_at: string;
  last_seen?: number;
}

interface DevicesResponse {
  devices: PairedDevice[];
  count: number;
  is_empty: boolean;
  user_display_name?: string;
  user_id: string;
}

interface ActivityEvent {
  event_id: string;
  device_id: string;
  type: string;
  created_at: string | number;
  payload_size?: number;
  stream_id?: string;
  stream_seq?: number;
  encrypted_payload?: string;
}

export default function DashboardPage() {
  const { identityKeyPair, isInitialized } = useCrypto();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://pocketbridge.duckdns.org';
  const deviceId = getOrCreateDeviceId();
  const wsUrl = getWsUrl() || 'ws://pocketbridge.duckdns.org/ws';
  const { status: connectionStatus, isConnected, lastSystemMessage } = useWebSocket({
    url: wsUrl,
    deviceId,
    autoConnect: isInitialized,
  });
  
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [pairedAccount, setPairedAccount] = useState<PairedAccountInfo | null>(null);
  const [deviceRole, setDeviceRole] = useState<'sharer' | 'receiver' | null>(null);
  const [recentActivity, setRecentActivity] = useState<ActivityEvent[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const lastDeviceCountRef = useRef<number>(0);
  const retryCountRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

  // Load persistent paired account info on mount
  useEffect(() => {
    const savedAccount = loadPairedAccount();
    if (savedAccount) {
      setPairedAccount(savedAccount);
      if (savedAccount.deviceRole) {
        setDeviceRole(savedAccount.deviceRole);
      }
      // Also restore devices from persistent storage
      if (savedAccount.devices && savedAccount.devices.length > 0) {
        setPairedDevices(savedAccount.devices.map(d => ({
          device_id: d.device_id,
          device_name: d.device_name || 'Unknown Device',
          user_id: savedAccount.userId,
          is_online: d.is_online,
          last_activity: null,
          updated_at: new Date(d.last_seen).toISOString(),
          last_seen: d.last_seen,
        })));
      }
      logger.info('Loaded persistent paired account', {
        userId: savedAccount.userId?.substring(0, 16) + '...',
        displayName: savedAccount.displayName,
        deviceCount: savedAccount.devices?.length || 0,
        deviceRole: savedAccount.deviceRole,
      });
    }
    
    // Also load device role from storage if available
    const storedRole = getDeviceRole();
    if (storedRole && isMountedRef.current) {
      setDeviceRole(storedRole);
    }
  }, []);

  // Load user profile and verify onboarding
  useEffect(() => {
    if (isInitialized && identityKeyPair) {
      const profile = loadUserProfile();
      if (profile && profile.userId === identityKeyPair.publicKeyHex && profile.onboardingCompleted) {
        setUserProfile(profile);
        logger.info('User profile loaded from dashboard', {
          userId: profile.userId?.substring(0, 16) + '...',
          onboardingCompleted: profile.onboardingCompleted,
        });
      }
    }
  }, [isInitialized, identityKeyPair]);

  // Fetch paired devices from backend API
  useEffect(() => {
    isMountedRef.current = true;
    
    const fetchPairedDevices = async () => {
      if (!identityKeyPair?.publicKeyHex) {
        if (isMountedRef.current) {
          setPairedDevices([]);
        }
        return;
      }

      // Check backend health before attempting to fetch devices
      const { checkBackendHealth } = await import('@/lib/utils/pairing-code');
      const healthCheck = await checkBackendHealth(apiUrl);
      
      if (!healthCheck.reachable) {
        logger.warn('Backend health check failed', { error: healthCheck.error });
        if (isMountedRef.current) {
          setIsLoadingDevices(false);
          const errorMessage = `Backend not reachable: ${healthCheck.error || 'Unknown error'}`;
          setFetchError(errorMessage);
          
          // Log error for user visibility
          logger.error('Cannot connect to backend', { error: healthCheck.error });
        }
        return;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        if (isMountedRef.current) {
          setIsLoadingDevices(true);
        }
        
        const response = await fetch(`${apiUrl}/api/devices`, {
          method: 'GET',
          headers: {
            'X-User-ID': identityKeyPair.publicKeyHex,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!isMountedRef.current) return;

        if (response.ok) {
          const data: DevicesResponse = await response.json();
          const devices = data.devices || [];

          if (!isMountedRef.current) return;

          // Filter out the current device - only show other paired devices
          const otherDevices = devices.filter((d: PairedDevice) => d.device_id !== deviceId);
          setPairedDevices(otherDevices);
          setFetchError(null);

          // Update persistent paired account with latest device info and display name
          if (otherDevices.length > 0 || data.user_display_name) {
            const persistentDevices = otherDevices.map((d: PairedDevice) => ({
              device_id: d.device_id,
              device_name: d.device_name,
              device_type: undefined as 'mobile' | 'desktop' | 'web' | undefined,
              is_online: d.is_online,
              last_seen: d.last_seen || Date.now(),
            }));

            // Update or create paired account info
            const existingAccount = loadPairedAccount();
            const updatedAccount: PairedAccountInfo = {
              userId: data.user_id || identityKeyPair.publicKeyHex,
              displayName: data.user_display_name || existingAccount?.displayName,
              pairedAt: existingAccount?.pairedAt || Date.now(),
              devices: persistentDevices,
            };
            savePairedAccount(updatedAccount);
            setPairedAccount(updatedAccount);
          }

          // Update profile with device count only if changed
          const profile = loadUserProfile();
          if (profile && profile.deviceCount !== otherDevices.length && otherDevices.length !== lastDeviceCountRef.current) {
            lastDeviceCountRef.current = otherDevices.length;
            const { updateUserProfile } = await import('@/lib/utils/user-profile');
            await updateUserProfile({ deviceCount: otherDevices.length }, identityKeyPair.publicKeyHex);

            if (!isMountedRef.current) return;

            const updatedProfile = loadUserProfile();
            if (updatedProfile) {
              setUserProfile(updatedProfile);
            }
          }

          logger.info('Paired devices loaded', {
            count: otherDevices.length,
            onlineCount: otherDevices.filter((d: PairedDevice) => d.is_online).length,
          });
        } else {
          logger.warn('Failed to fetch devices', { status: response.status });
          
          if (!isMountedRef.current) return;
          
          setPairedDevices([]);
          setFetchError('Failed to load devices');
        }
      } catch (error) {
        clearTimeout(timeoutId);
        
        if (!isMountedRef.current) return;
        
        logger.error('Failed to fetch paired devices', error);
        setPairedDevices([]);
        setFetchError('Network error - retrying...');
        
        // Retry with exponential backoff
        if (retryCountRef.current < 3) {
          retryCountRef.current++;
          const retryDelay = Math.min(1000 * Math.pow(2, retryCountRef.current - 1), 8000);
          setTimeout(() => {
            if (isMountedRef.current) {
              fetchPairedDevices();
            }
          }, retryDelay);
        }
      } finally {
        if (isMountedRef.current) {
          setIsLoadingDevices(false);
        }
      }
    };

    // Online/Offline detection
    const handleOnline = () => {
      if (isMountedRef.current) {
        retryCountRef.current = 0;
        fetchPairedDevices();
      }
    };

    window.addEventListener('online', handleOnline);

    // Fetch immediately and then periodically
    fetchPairedDevices();
    const interval = setInterval(() => {
      if (navigator.onLine && isMountedRef.current) {
        fetchPairedDevices();
      }
    }, 10000); // Refresh every 10 seconds
    
    return () => {
      isMountedRef.current = false;
      clearInterval(interval);
      window.removeEventListener('online', handleOnline);
    };
  }, [isInitialized, identityKeyPair, apiUrl]);

  // Fetch recent activity from backend API on initial load only
  useEffect(() => {
    const fetchInitialActivity = async () => {
      if (!identityKeyPair?.publicKeyHex) {
        return;
      }

      try {
        if (isMountedRef.current) {
          setIsLoadingActivity(true);
        }

        const response = await fetch(`${apiUrl}/api/events/files?limit=5`, {
          method: 'GET',
          headers: {
            'X-User-ID': identityKeyPair.publicKeyHex,
            'Content-Type': 'application/json',
          },
        });

        if (!isMountedRef.current) return;

        if (response.ok) {
          const data = await response.json();
          setRecentActivity(data.events || []);
          logger.info('Recent activity loaded', {
            count: data.events?.length || 0,
          });
        } else {
          logger.warn('Failed to fetch activity', { status: response.status });
        }
      } catch (error) {
        if (isMountedRef.current) {
          logger.error('Failed to fetch recent activity', error);
        }
      } finally {
        if (isMountedRef.current) {
          setIsLoadingActivity(false);
        }
      }
    };

    // Fetch initial activity on mount only
    fetchInitialActivity();
  }, [isInitialized, identityKeyPair, apiUrl]);

  // Listen for real-time activity events via WebSocket
  useEffect(() => {
    // Listen for activity:event system messages from WebSocket
    if (!lastSystemMessage) return;

    if (lastSystemMessage.type === 'activity:event') {
      const activityEvent = lastSystemMessage.payload;
      setRecentActivity(prev => {
        // Prepend the new event and keep only 5 most recent
        const updated = [activityEvent, ...prev].slice(0, 5);
        logger.info('Activity event received and added to list', {
          eventId: activityEvent.event_id,
          type: activityEvent.type,
        });
        return updated;
      });
    }
  }, [lastSystemMessage]);

  return (
    <MainLayout>
      <Header title="Dashboard" description="Overview of your devices and recent activity" />

      <div className="p-6 space-y-6">
        {/* Error Banner */}
        {fetchError && (
          <Card className="border-red-500 bg-red-50 dark:bg-red-950/20">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
                <div className="flex-1">
                  <h3 className="font-semibold text-red-900 dark:text-red-100">Connection Error</h3>
                  <p className="text-sm text-red-700 dark:text-red-200 mt-1">{fetchError}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Unpaired Device Warning */}
        {userProfile?.onboardingCompleted && pairedDevices.length === 0 && !pairedAccount && (
          <Card className="border-amber-500 bg-amber-50 dark:bg-amber-950/20">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
                <div className="flex-1">
                  <h3 className="font-semibold text-amber-900 dark:text-amber-100">Pair First, Then Upload</h3>
                  <p className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                    Files uploaded now will only be stored on this device and won't sync to other devices. 
                    <Link href="/pair" className="font-semibold underline ml-1 hover:opacity-80">
                      Pair another device first
                    </Link>
                    to enable cross-device sync.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* User Profile Welcome - Always show username */}
        {userProfile && userProfile.displayName && (
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-lg font-semibold text-primary">
                    {userProfile.displayName.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1">
                  {/* Device-specific welcome messages */}
                  {deviceRole === 'sharer' && (
                    <h2 className="text-lg font-semibold">Welcome back, {userProfile.displayName}! (Device A - Sharer)</h2>
                  )}
                  {deviceRole === 'receiver' && (
                    <h2 className="text-lg font-semibold">Welcome back, {userProfile.displayName}! (Device B - Receiver)</h2>
                  )}
                  {!deviceRole && (
                    <h2 className="text-lg font-semibold">Welcome back, {userProfile.displayName}!</h2>
                  )}
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    {isConnected ? (
                      <>
                        <Check className="h-4 w-4 text-green-600" />
                        {pairedDevices.filter(d => d.is_online).length > 0 
                          ? `${pairedDevices.filter(d => d.is_online).length} device${pairedDevices.filter(d => d.is_online).length > 1 ? 's' : ''} online`
                          : 'No devices online'
                        }
                      </>
                    ) : (
                      <>
                        <AlertCircle className="h-4 w-4 text-yellow-600" />
                        Connecting to backend...
                      </>
                    )}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Connection Status */}
        <Card className="border-l-4 border-l-blue-500">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Smartphone className="h-5 w-5" />
              Connection Status
              {deviceRole && (
                <span className="ml-2 text-xs font-normal bg-primary/10 text-primary px-2 py-1 rounded">
                  {deviceRole === 'sharer' ? 'Device A (Sharer)' : 'Device B (Receiver)'}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">WebSocket Connection</span>
              <span className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-yellow-500'}`} />
                <span className="text-sm font-medium">{isConnected ? 'Connected' : 'Connecting'}</span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Onboarding Status</span>
              <span className="flex items-center gap-2">
                {userProfile?.onboardingCompleted ? (
                  <>
                    <Check className="h-4 w-4 text-green-600" />
                    <span className="text-sm font-medium text-green-600">Completed</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-4 w-4 text-yellow-600" />
                    <span className="text-sm font-medium text-yellow-600">Incomplete</span>
                  </>
                )}
              </span>
            </div>
            {pairedDevices.length > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Paired Devices</span>
                <span className="text-sm font-medium">{pairedDevices.length}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pairing Status & Call to Action */}
        {pairedDevices.length === 0 && !pairedAccount ? (
          <Card className="border-2 border-dashed border-primary/50 bg-primary/5">
            <CardHeader>
              <CardTitle className="text-base">No Other Devices Paired</CardTitle>
              <CardDescription>Pair another device to sync across your workspace</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                PocketBridge works by connecting multiple devices. Pair your smartphone, tablet, or another computer to start syncing.
              </p>
              <Button asChild className="gap-2">
                <Link href="/pair">
                  <Plus className="h-4 w-4" />
                  Pair Another Device
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Smartphone className="h-5 w-5" />
                Connected Devices
              </CardTitle>
              <CardDescription>
                {pairedDevices.filter(d => d.is_online).length > 0
                  ? `${pairedDevices.filter(d => d.is_online).length} device${pairedDevices.filter(d => d.is_online).length > 1 ? 's' : ''} online`
                  : 'No devices currently online'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Show paired account status even if no other devices online */}
              {pairedAccount && pairedDevices.length === 0 && (
                <div className="mb-4 p-3 rounded-lg border bg-muted/50">
                  <div className="flex items-center gap-2 text-sm">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>Account synced since {new Date(pairedAccount.pairedAt).toLocaleDateString()}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Other devices will appear here when they come online
                  </p>
                </div>
              )}

              <div className="space-y-3">
                {pairedDevices.filter(d => d.is_online).map((device: PairedDevice) => {
                  // Show the device's user's display name instead of device name
                  const displayName = device.user_display_name || device.device_name || 'Connected User';

                  return (
                    <div key={device.device_id} className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
                      <div className="flex items-center gap-3 flex-1">
                        {/* Status indicator with pulse animation for online */}
                        <div className="relative">
                          <div className="h-3 w-3 rounded-full bg-green-500" />
                          <div className="absolute inset-0 h-3 w-3 rounded-full bg-green-500 animate-ping opacity-75" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{displayName}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <span className="text-green-600 font-medium">
                              ● Online
                            </span>
                          </p>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" asChild>
                        <Link href="/settings">Manage</Link>
                      </Button>
                    </div>
                  );
                })}
              </div>

              {pairedDevices.filter(d => d.is_online).length === 0 && pairedDevices.length > 0 && (
                <div className="text-center py-8">
                  <p className="text-sm text-muted-foreground">No devices currently online</p>
                  <p className="text-xs text-muted-foreground mt-1">{pairedDevices.length} device{pairedDevices.length > 1 ? 's' : ''} paired but offline</p>
                </div>
              )}

              <Button variant="outline" className="w-full mt-4 gap-2" asChild>
                <Link href="/pair">
                  <Plus className="h-4 w-4" />
                  Pair Another Device
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Common tasks across your devices</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Button variant="outline" className="h-auto flex-col gap-2 py-4 bg-transparent hover:bg-primary/5" asChild>
              <Link href="/clipboard" aria-label="Copy to Clipboard">
                <Clipboard className="h-6 w-6 text-primary" aria-hidden="true" />
                <span>Copy to Clipboard</span>
              </Link>
            </Button>
            <Button variant="outline" className="h-auto flex-col gap-2 py-4 bg-transparent hover:bg-primary/5" asChild>
              <Link href="/scratchpad" aria-label="Open Scratchpad">
                <FileText className="h-6 w-6 text-primary" aria-hidden="true" />
                <span>Open Scratchpad</span>
              </Link>
            </Button>
            <Button variant="outline" className="h-auto flex-col gap-2 py-4 bg-transparent hover:bg-primary/5" asChild>
              <Link href="/messages" aria-label="Secret Chat">
                <MessageSquare className="h-6 w-6 text-primary" aria-hidden="true" />
                <span>Secret Chat</span>
              </Link>
            </Button>
            <Button variant="outline" className="h-auto flex-col gap-2 py-4 bg-transparent hover:bg-primary/5" asChild>
              <Link href="/files" aria-label="Share File">
                <FolderOpen className="h-6 w-6 text-primary" aria-hidden="true" />
                <span>Share File</span>
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* Connected Devices Panel */}
        {identityKeyPair?.publicKeyHex ? (
          <DevicePresenceList 
            apiUrl={apiUrl}
            userId={identityKeyPair.publicKeyHex}
            className=""
          />
        ) : null}

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest synced events across devices</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingActivity ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary"></div>
              </div>
            ) : recentActivity.length > 0 ? (
              <div className="space-y-3">
                {recentActivity.map((event: ActivityEvent) => {
                  // Handle both API response (string ISO date) and WebSocket (number timestamp)
                  let eventDate: Date;
                  if (typeof event.created_at === 'string') {
                    eventDate = new Date(event.created_at);
                  } else if (typeof event.created_at === 'number') {
                    eventDate = new Date(event.created_at);
                  } else {
                    eventDate = new Date();
                  }
                  
                  const formattedTime = eventDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  const formattedDate = eventDate.toLocaleDateString();
                  
                  // Format file size
                  const formatSize = (bytes?: number) => {
                    if (!bytes) return '';
                    if (bytes < 1024) return `${bytes}B`;
                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
                    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
                  };

                  return (
                    <div key={event.event_id} className="flex items-start gap-3 p-3 rounded-lg border bg-card/50">
                      <Download className="h-4 w-4 text-primary mt-1 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">File Synced</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {formattedTime} • {formattedDate}
                          {event.payload_size && ` • ${formatSize(event.payload_size)}`}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <File className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
                <p className="text-sm text-muted-foreground">No recent activity</p>
                <p className="text-xs text-muted-foreground mt-1">Start using features to see activity here</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  )
}
