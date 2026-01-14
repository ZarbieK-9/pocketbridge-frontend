"use client"

/**
 * Service Worker Registration Component
 * Registers the service worker and handles updates
 */

import { useEffect } from 'react'

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      console.log('[SW] Service Workers not supported')
      return
    }

    let registration: ServiceWorkerRegistration | null = null

    async function register() {
      try {
        console.log('[SW] Registering service worker...')
        
        registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
        })

        console.log('[SW] Service Worker registered:', registration.scope)

        // Check for updates periodically
        registration.addEventListener('updatefound', () => {
          console.log('[SW] Update found, installing...')
          const newWorker = registration!.installing
          
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New service worker available, prompt user to reload
                console.log('[SW] New service worker installed, reload to activate')
                if (confirm('New version available! Reload to update?')) {
                  window.location.reload()
                }
              }
            })
          }
        })

        // Handle service worker messages
        navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
          const controller = navigator.serviceWorker.controller

          if (!event.isTrusted) {
            console.warn('[SW] Ignoring untrusted message event')
            return
          }

          const origin = event.origin || (event.source instanceof ServiceWorker ? new URL(event.source.scriptURL).origin : null)
          if (origin !== window.location.origin) {
            console.warn('[SW] Ignoring message from untrusted origin', origin)
            return
          }

          if (!controller || event.source !== controller) {
            console.warn('[SW] Ignoring message from unexpected source')
            return
          }

          const data = event.data
          if (!data || typeof data !== 'object') {
            console.warn('[SW] Ignoring message with invalid payload')
            return
          }

          console.log('[SW] Message from service worker:', data)
          
          if (data.type === 'SYNC_QUEUED_EVENTS') {
            // Trigger sync in the app
            window.dispatchEvent(new CustomEvent('sw-sync-request', {
              detail: { count: data.count },
            }))
          }
          
          if (data.type === 'CHECK_UPDATES') {
            // Check for updates
            window.dispatchEvent(new CustomEvent('sw-check-updates'))
          }
        })

        // Register for background sync (if supported)
        if ('sync' in registration) {
          console.log('[SW] Background Sync API available')
        }

        // Register for periodic background sync (if supported)
        if ('periodicSync' in registration) {
          console.log('[SW] Periodic Background Sync API available')
          
          try {
            // Request permission for periodic sync
            const status = await (registration as any).periodicSync.register('check-updates', {
              minInterval: 24 * 60 * 60 * 1000, // Once per day
            })
            console.log('[SW] Periodic sync registered:', status)
          } catch (error) {
            console.log('[SW] Periodic sync not available:', error)
          }
        }

      } catch (error) {
        console.error('[SW] Service Worker registration failed:', error)
      }
    }

    // Register on load
    if (document.readyState === 'complete') {
      register()
    } else {
      window.addEventListener('load', register)
    }

    // Cleanup
    return () => {
      // Service worker registration persists, no cleanup needed
    }
  }, [])

  return null
}

