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
import { Button } from "@/components/ui/button"
import { FileText, MessageSquare, FolderOpen, Plus, Smartphone, Check, AlertCircle, Download, File, Trash2, ShieldCheck, ShieldAlert, ShieldOff, Shield } from "lucide-react"
import { useCrypto } from "@/hooks/use-crypto"
import { useWebSocket } from "@/hooks/use-websocket"
import { loadUserProfile, type UserProfile } from "@/lib/utils/user-profile"
import { getOrCreateDeviceId, getOrCreateDeviceName, getDeviceRole } from "@/lib/utils/device"
import { getWsUrl, loadPairedAccount, savePairedAccount, clearPairedAccount, updatePairedDevices, type PairedAccountInfo } from "@/lib/utils/storage"
import { useEffect, useState, useRef, useMemo } from "react"
import { logger } from "@/lib/utils/logger"
import Link from "next/link"

function getGreeting(): { greeting: string; emoji: string } {
  const hour = new Date().getHours();
  if (hour < 6) return { greeting: 'Good night', emoji: '🌙' };
  if (hour < 12) return { greeting: 'Good morning', emoji: '☀️' };
  if (hour < 17) return { greeting: 'Good afternoon', emoji: '🌤️' };
  if (hour < 21) return { greeting: 'Good evening', emoji: '🌅' };
  return { greeting: 'Good night', emoji: '🌙' };
}

function getTrustMessage(isConnected: boolean, deviceCount: number): string {
  if (isConnected && deviceCount > 0) return 'Secure connection active · End-to-end encrypted';
  if (isConnected) return 'Connected securely · Ready to pair devices';
  return 'Establishing secure connection...';
}

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
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://terraqueous-nonmarketable-burt.ngrok-free.dev';
  const deviceId = getOrCreateDeviceId();
  const wsUrl = getWsUrl() || 'wss://terraqueous-nonmarketable-burt.ngrok-free.dev/ws';
  const { status: connectionStatus, isConnected, lastSystemMessage } = useWebSocket({
    url: wsUrl,
    deviceId,
    autoConnect: isInitialized,
  });
  
  const [deviceName, setDeviceName] = useState<string>('PocketBridge');
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [pairedAccount, setPairedAccount] = useState<PairedAccountInfo | null>(null);
  const [deviceRole, setDeviceRole] = useState<'sharer' | 'receiver' | null>(null);
  const [recentActivity, setRecentActivity] = useState<ActivityEvent[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [removingDeviceId, setRemovingDeviceId] = useState<string | null>(null);
  const lastDeviceCountRef = useRef<number>(0);
  const retryCountRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

  // Initialize device name on client only (avoid SSR hydration mismatch)
  useEffect(() => {
    setDeviceName(getOrCreateDeviceName() || 'PocketBridge');
  }, []);

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

  const handleRemoveDevice = async (device: PairedDevice) => {
    const confirmed = confirm(
      `Remove "${device.device_name || 'Unknown Device'}"?\n\nThis device will be disconnected and syncing will stop. You'll need to pair again to reconnect.`
    );
    if (!confirmed) return;

    setRemovingDeviceId(device.device_id);
    try {
      const response = await fetch(`${apiUrl}/api/devices/${device.device_id}`, {
        method: 'DELETE',
        headers: {
          'X-User-ID': identityKeyPair?.publicKeyHex || '',
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to remove device (${response.status})`);
      }

      // Remove device from local state
      setPairedDevices(prev => prev.filter(d => d.device_id !== device.device_id));

      // If no paired devices left, clear paired account
      const remaining = pairedDevices.filter(d => d.device_id !== device.device_id);
      if (remaining.length === 0) {
        clearPairedAccount();
        setPairedAccount(null);
      } else {
        // Update persistent storage with remaining devices
        const updated = loadPairedAccount();
        if (updated) {
          updated.devices = remaining.map(d => ({
            device_id: d.device_id,
            device_name: d.device_name,
            device_type: undefined as 'mobile' | 'desktop' | 'web' | undefined,
            is_online: d.is_online,
            last_seen: d.last_seen || Date.now(),
          }));
          savePairedAccount(updated);
        }
      }

      logger.info('Device removed successfully', { deviceId: device.device_id });
    } catch (error) {
      logger.error('Failed to remove device', error);
      alert('Failed to remove device. Please try again.');
    } finally {
      setRemovingDeviceId(null);
    }
  };

  const [greetingData, setGreetingData] = useState({ greeting: '', emoji: '' });
  useEffect(() => {
    setGreetingData(getGreeting());
  }, []);
  const { greeting, emoji } = greetingData;
  const trustMsg = useMemo(() => getTrustMessage(isConnected, pairedDevices.length), [isConnected, pairedDevices.length]);
  const onlineCount = pairedDevices.filter(d => d.is_online).length;

  const getStatusIcon = () => {
    if (isConnected && onlineCount > 0) return { Icon: ShieldCheck, color: 'text-green-500', bg: 'bg-green-50 dark:bg-green-950/30' };
    if (isConnected) return { Icon: Shield, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' };
    return { Icon: ShieldAlert, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-950/30' };
  };
  const statusIcon = getStatusIcon();

  return (
    <MainLayout>
      {/* Welcome Header with gradient */}
      <div className="bg-linear-to-br from-blue-50/80 to-violet-50/40 dark:from-blue-950/30 dark:to-violet-950/20 px-6 py-6 border-b border-border animate-in fade-in duration-500">
        <p className="text-2xl mb-1">{emoji}</p>
        <p className="text-sm font-medium text-muted-foreground">{greeting}</p>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">
          {deviceName}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {userProfile ? 'Your bridge is ready.' : 'Welcome to PocketBridge'}
        </p>
      </div>

      <div className="p-6 space-y-6">
        {/* Error Banner */}
        {fetchError && (
          <div className="flex items-start gap-3 p-4 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 animate-in fade-in duration-300">
            <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <h3 className="font-semibold text-red-900 dark:text-red-100">Connection Error</h3>
              <p className="text-sm text-red-700 dark:text-red-200 mt-1">{fetchError}</p>
            </div>
          </div>
        )}

        {/* Unpaired Device Warning */}
        {userProfile?.onboardingCompleted && pairedDevices.length === 0 && !pairedAccount && (
          <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 animate-in fade-in duration-300">
            <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <h3 className="font-semibold text-amber-900 dark:text-amber-100">Pair First, Then Upload</h3>
              <p className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                Files uploaded now won&apos;t sync to other devices.{' '}
                <Link href="/pair" className="font-semibold underline hover:opacity-80">
                  Pair another device first
                </Link>
              </p>
            </div>
          </div>
        )}

        {/* Connection Status */}
        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase animate-in fade-in slide-in-from-bottom-1 duration-300" style={{ animationDelay: '100ms', animationFillMode: 'backwards' }}>
          Connection
        </p>
        <div className="rounded-xl border bg-linear-to-br from-card to-blue-50/30 dark:to-blue-950/10 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '150ms', animationFillMode: 'backwards' }}>
          <div className="flex items-center gap-3.5 px-4 py-3.5">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${statusIcon.bg}`}>
              <statusIcon.Icon className={`h-5 w-5 ${statusIcon.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-medium text-foreground">
                {isConnected ? 'Connected' : 'Connecting...'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{trustMsg}</p>
            </div>
            {deviceRole && (
              <span className="text-[11px] font-medium bg-primary/10 text-primary px-2 py-1 rounded-md shrink-0">
                {deviceRole === 'sharer' ? 'Sharer' : 'Receiver'}
              </span>
            )}
          </div>
        </div>

        {/* Your Devices */}
        {(pairedDevices.length > 0 || pairedAccount) && (
          <>
            <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase animate-in fade-in slide-in-from-bottom-1 duration-300" style={{ animationDelay: '200ms', animationFillMode: 'backwards' }}>
              Your Devices
            </p>
            <div className="rounded-xl border bg-linear-to-br from-card to-emerald-50/20 dark:to-emerald-950/10 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '250ms', animationFillMode: 'backwards' }}>
              {pairedAccount && pairedDevices.length === 0 && (
                <div className="px-4 py-3.5">
                  <div className="flex items-center gap-2 text-sm">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>Account synced since {new Date(pairedAccount.pairedAt).toLocaleDateString()}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Other devices will appear here when they come online
                  </p>
                </div>
              )}

              {pairedDevices.filter(d => d.is_online).map((device: PairedDevice, index: number) => (
                <div key={device.device_id}>
                  {index > 0 && <div className="h-px bg-border ml-14" />}
                  <div className="flex items-center gap-3.5 px-4 py-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-50 dark:bg-green-950/30">
                      <Smartphone className="h-5 w-5 text-green-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-medium text-foreground truncate">{device.device_name || 'Other Device'}</p>
                      <p className="text-xs text-green-600 font-medium">Online · Syncing</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemoveDevice(device)}
                      disabled={removingDeviceId === device.device_id}
                    >
                      {removingDeviceId === device.device_id ? (
                        <span className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}

              {onlineCount === 0 && pairedDevices.length > 0 && (
                <div className="text-center py-6">
                  <p className="text-sm text-muted-foreground">No devices currently online</p>
                  <p className="text-xs text-muted-foreground mt-1">{pairedDevices.length} device{pairedDevices.length > 1 ? 's' : ''} paired but offline</p>
                </div>
              )}
            </div>
          </>
        )}

        {/* No devices CTA */}
        {pairedDevices.length === 0 && !pairedAccount && (
          <div className="rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 p-6 text-center animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '200ms', animationFillMode: 'backwards' }}>
            <Smartphone className="h-8 w-8 text-primary mx-auto mb-3 opacity-60" />
            <p className="text-sm font-semibold text-foreground">No Other Devices Paired</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">Pair your smartphone or another computer to start syncing</p>
            <Button asChild className="gap-2">
              <Link href="/pair">
                <Plus className="h-4 w-4" />
                Pair Another Device
              </Link>
            </Button>
          </div>
        )}

        {/* Quick Actions */}
        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase animate-in fade-in slide-in-from-bottom-1 duration-300" style={{ animationDelay: '300ms', animationFillMode: 'backwards' }}>
          Quick Actions
        </p>
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: FolderOpen, label: 'Send File', color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30', route: '/files' },
            { icon: FileText, label: 'Scratchpad', color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/30', route: '/scratchpad' },
            { icon: MessageSquare, label: 'Messages', color: 'text-violet-500', bg: 'bg-violet-50 dark:bg-violet-950/30', route: '/messages' },
          ].map((action, i) => {
            const ActionIcon = action.icon;
            return (
              <Link
                key={action.label}
                href={action.route}
                className="flex flex-col items-center gap-2 rounded-xl border bg-card py-4 px-2 transition-colors hover:bg-accent/50 animate-in fade-in slide-in-from-bottom-3 duration-400"
                style={{ animationDelay: `${350 + i * 80}ms`, animationFillMode: 'backwards' }}
              >
                <div className={`flex h-11 w-11 items-center justify-center rounded-lg ${action.bg}`}>
                  <ActionIcon className={`h-5 w-5 ${action.color}`} />
                </div>
                <span className="text-xs font-medium text-foreground">{action.label}</span>
              </Link>
            );
          })}
        </div>

        {/* Pair Another Device button (when already paired) */}
        {(pairedDevices.length > 0 || pairedAccount) && (
          <Button variant="outline" className="w-full gap-2" asChild>
            <Link href="/pair">
              <Plus className="h-4 w-4" />
              Pair Another Device
            </Link>
          </Button>
        )}

        {/* Recent Activity */}
        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase animate-in fade-in slide-in-from-bottom-1 duration-300" style={{ animationDelay: '500ms', animationFillMode: 'backwards' }}>
          Recent Activity
        </p>
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-400" style={{ animationDelay: '550ms', animationFillMode: 'backwards' }}>
          {isLoadingActivity ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl border bg-card">
                  <div className="h-9 w-9 rounded-lg bg-muted animate-shimmer" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-24 rounded bg-muted animate-shimmer" />
                    <div className="h-2.5 w-40 rounded bg-muted animate-shimmer" />
                  </div>
                </div>
              ))}
            </div>
          ) : recentActivity.length > 0 ? (
            <div className="space-y-2.5">
              {recentActivity.map((event: ActivityEvent) => {
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

                const formatSize = (bytes?: number) => {
                  if (!bytes) return '';
                  if (bytes < 1024) return `${bytes}B`;
                  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
                  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
                };

                return (
                  <div key={event.event_id} className="flex items-center gap-3 p-3 rounded-xl border bg-linear-to-r from-card to-blue-50/20 dark:to-blue-950/10">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/30">
                      <Download className="h-4 w-4 text-blue-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">File Synced</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formattedTime} · {formattedDate}
                        {event.payload_size && ` · ${formatSize(event.payload_size)}`}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <File className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-40" />
              <p className="text-sm text-muted-foreground">No recent activity</p>
              <p className="text-xs text-muted-foreground mt-1">Start using features to see activity here</p>
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  )
}
