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
import { Clipboard, FileText, MessageSquare, FolderOpen, Plus, Smartphone, Check, AlertCircle } from "lucide-react"
import { DevicePresenceList } from "@/components/device-presence"
import { useCrypto } from "@/hooks/use-crypto"
import { useWebSocket } from "@/hooks/use-websocket"
import { loadUserProfile, type UserProfile } from "@/lib/utils/user-profile"
import { getOrCreateDeviceId } from "@/lib/utils/device"
import { getWsUrl } from "@/lib/utils/storage"
import { useEffect, useState, useRef } from "react"
import { logger } from "@/lib/utils/logger"
import Link from "next/link"

interface PairedDevice {
  device_id: string;
  device_name: string;
  user_id: string;
  is_online: boolean;
  last_activity: string | null;
  updated_at: string;
}

export default function DashboardPage() {
  const { identityKeyPair, isInitialized } = useCrypto();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  const deviceId = getOrCreateDeviceId();
  const wsUrl = getWsUrl() || 'ws://localhost:3001/ws';
  const { status: connectionStatus, isConnected } = useWebSocket({
    url: wsUrl,
    deviceId,
    autoConnect: isInitialized,
  });
  
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const lastDeviceCountRef = useRef<number>(0);
  const retryCountRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

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
          const data = await response.json();
          const devices = data.devices || [];
          
          if (!isMountedRef.current) return;
          
          setPairedDevices(devices);
          setFetchError(null);
          
          // Update profile with device count only if changed
          const profile = loadUserProfile();
          if (profile && profile.deviceCount !== devices.length && devices.length !== lastDeviceCountRef.current) {
            lastDeviceCountRef.current = devices.length;
            const { updateUserProfile } = await import('@/lib/utils/user-profile');
            await updateUserProfile({ deviceCount: devices.length }, identityKeyPair.publicKeyHex);
            
            if (!isMountedRef.current) return;
            
            const updatedProfile = loadUserProfile();
            if (updatedProfile) {
              setUserProfile(updatedProfile);
            }
          }

          logger.info('Paired devices loaded', {
            count: devices.length,
            onlineCount: devices.filter((d: PairedDevice) => d.is_online).length,
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

  return (
    <MainLayout>
      <Header title="Dashboard" description="Overview of your devices and recent activity" />

      <div className="p-6 space-y-6">
        {/* User Profile Welcome */}
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
                  <h2 className="text-lg font-semibold">Welcome back, {userProfile.displayName}!</h2>
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    {isConnected ? (
                      <>
                        <Check className="h-4 w-4 text-green-600" />
                        {pairedDevices.length > 0 
                          ? `${pairedDevices.length} device(s) connected • ${pairedDevices.filter(d => d.is_online).length} online`
                          : 'Ready to pair your devices'
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
        {pairedDevices.length === 0 ? (
          <Card className="border-2 border-dashed border-primary/50 bg-primary/5">
            <CardHeader>
              <CardTitle className="text-base">No Devices Paired Yet</CardTitle>
              <CardDescription>Pair your first device to get started</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                PocketBridge works best with multiple devices. Pair your smartphone, tablet, or another computer to sync across your workspace.
              </p>
              <Button asChild className="gap-2">
                <Link href="/pair">
                  <Plus className="h-4 w-4" />
                  Pair Your First Device
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Smartphone className="h-5 w-5" />
                Your Paired Devices ({pairedDevices.length})
              </CardTitle>
              <CardDescription>Click to view details or manage devices</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {pairedDevices.map((device: any) => (
                  <div key={device.device_id} className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
                    <div className="flex items-center gap-3 flex-1">
                      <div className={`h-3 w-3 rounded-full ${device.is_online ? 'bg-green-500' : 'bg-gray-400'}`} />
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{device.device_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {device.is_online ? 'Online now' : `Last seen ${new Date(device.last_activity || device.updated_at).toLocaleTimeString()}`}
                        </p>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href="/settings">Manage</Link>
                    </Button>
                  </div>
                ))}
              </div>
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
              <Link href="/messages" aria-label="Send Message">
                <MessageSquare className="h-6 w-6 text-primary" aria-hidden="true" />
                <span>Send Message</span>
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
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm text-muted-foreground">No recent activity</p>
              <p className="mt-2 text-xs text-muted-foreground">Start using features to see activity here</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  )
}
