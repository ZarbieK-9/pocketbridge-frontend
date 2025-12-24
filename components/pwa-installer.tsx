"use client"

/**
 * PWA Install Prompt Component
 * Shows install button when PWA is installable
 */

import { useState, useEffect } from 'react'
import { Download, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function PWAInstaller() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(false)
  const [isIOS, setIsIOS] = useState(false)

  useEffect(() => {
    // Check if already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setIsInstalled(true)
      return
    }

    // Check if iOS
    const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream
    setIsIOS(isIOSDevice)

    // Listen for beforeinstallprompt event
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)

    // Check if app is already installed
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((registration) => {
        if (registration) {
          // App might be installed
          setIsInstalled(window.matchMedia('(display-mode: standalone)').matches)
        }
      })
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    }
  }, [])

  const handleInstallClick = async () => {
    if (!deferredPrompt) {
      return
    }

    // Show install prompt
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice

    if (outcome === 'accepted') {
      console.log('User accepted the install prompt')
      setDeferredPrompt(null)
      setIsInstalled(true)
    } else {
      console.log('User dismissed the install prompt')
    }
  }

  // Don't show if already installed
  if (isInstalled) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Check className="h-4 w-4" />
        <span>App Installed</span>
      </div>
    )
  }

  // iOS install instructions
  if (isIOS) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">Install this app on your iOS device:</p>
        <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
          <li>Tap the Share button</li>
          <li>Select &quot;Add to Home Screen&quot;</li>
          <li>Tap &quot;Add&quot;</li>
        </ol>
      </div>
    )
  }

  // Android/Desktop install button
  if (deferredPrompt) {
    return (
      <Button
        onClick={handleInstallClick}
        variant="outline"
        size="sm"
        className="gap-2"
      >
        <Download className="h-4 w-4" />
        Install App
      </Button>
    )
  }

  return null
}

