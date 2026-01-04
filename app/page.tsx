"use client";
 
/**
 * Dashboard page - overview of devices and quick actions
 */

import { MainLayout } from "@/components/layout/main-layout"
import { Header } from "@/components/layout/header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Clipboard, FileText, MessageSquare, FolderOpen } from "lucide-react"
import { DevicePresenceList } from "@/components/device-presence"
import { useCrypto } from "@/hooks/use-crypto"
import { loadUserProfile } from "@/lib/utils/user-profile"
import { useEffect, useState } from "react"

export default function DashboardPage() {
  const { identityKeyPair, isInitialized } = useCrypto();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  const [userProfile, setUserProfile] = useState<ReturnType<typeof loadUserProfile>>(null);

  useEffect(() => {
    if (isInitialized && identityKeyPair) {
      const profile = loadUserProfile();
      if (profile && profile.userId === identityKeyPair.publicKeyHex) {
        setUserProfile(profile);
      }

      // Sync device count from API
      const syncDeviceCount = async () => {
        try {
          const response = await fetch(`${apiUrl}/api/devices`, {
            headers: { 'X-User-ID': identityKeyPair.publicKeyHex },
          });
          if (response.ok) {
            const data = await response.json();
            const deviceCount = data.devices?.length || 0;
            const currentProfile = loadUserProfile();
            if (currentProfile && currentProfile.deviceCount !== deviceCount) {
              const { updateUserProfile } = await import('@/lib/utils/user-profile');
              await updateUserProfile({ deviceCount }, identityKeyPair.publicKeyHex);
              const updatedProfile = loadUserProfile();
              if (updatedProfile) {
                setUserProfile(updatedProfile);
              }
            }
          }
        } catch (error) {
          // Silently fail - device count sync is not critical
          console.debug('Failed to sync device count', error);
        }
      };

      syncDeviceCount();
    }
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
                <div>
                  <h2 className="text-lg font-semibold">Welcome back, {userProfile.displayName}!</h2>
                  <p className="text-sm text-muted-foreground">
                    {userProfile.deviceCount ? `${userProfile.deviceCount} device(s) connected` : 'Getting started with PocketBridge'}
                  </p>
                </div>
              </div>
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
            <Button variant="outline" className="h-auto flex-col gap-2 py-4 bg-transparent" asChild>
              <a href="/clipboard" aria-label="Copy to Clipboard">
                <Clipboard className="h-6 w-6 text-primary" aria-hidden="true" />
                <span>Copy to Clipboard</span>
              </a>
            </Button>
            <Button variant="outline" className="h-auto flex-col gap-2 py-4 bg-transparent" asChild>
              <a href="/scratchpad" aria-label="Open Scratchpad">
                <FileText className="h-6 w-6 text-primary" aria-hidden="true" />
                <span>Open Scratchpad</span>
              </a>
            </Button>
            <Button variant="outline" className="h-auto flex-col gap-2 py-4 bg-transparent" asChild>
              <a href="/messages" aria-label="Send Message">
                <MessageSquare className="h-6 w-6 text-primary" aria-hidden="true" />
                <span>Send Message</span>
              </a>
            </Button>
            <Button variant="outline" className="h-auto flex-col gap-2 py-4 bg-transparent" asChild>
              <a href="/files" aria-label="Share File">
                <FolderOpen className="h-6 w-6 text-primary" aria-hidden="true" />
                <span>Share File</span>
              </a>
            </Button>
          </CardContent>
        </Card>

        {/* Connected Devices */}
        {identityKeyPair?.publicKeyHex ? (
          <DevicePresenceList 
            apiUrl={apiUrl}
            userId={identityKeyPair.publicKeyHex}
            className=""
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
