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

export default function DashboardPage() {
  const { identityKeyPair } = useCrypto();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  return (
    <MainLayout>
      <Header title="Dashboard" description="Overview of your devices and recent activity" />

      <div className="p-6 space-y-6">
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
