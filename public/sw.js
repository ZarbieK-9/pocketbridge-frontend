/**
 * Service Worker for PocketBridge PWA
 * Enables offline functionality, background sync, and push notifications
 */

const CACHE_NAME = 'pocketbridge-v1';
const WS_QUEUE_KEY = 'ws_event_queue';

// Install event - cache essential resources
self.addEventListener('install', (event) => {
  // Only log in development
  if (process.env.NODE_ENV === 'development') {
    console.log('[SW] Service Worker installing');
  }
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/manifest.json',
      ]);
    }).then(() => {
      return self.skipWaiting(); // Activate immediately
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Service Worker activating');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => {
      return self.clients.claim(); // Take control of all pages
    })
  );
});

// Fetch event - serve from cache when offline
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Skip service worker for API requests - let them go directly to network
  // This includes both /api/* routes and external backend APIs
  const isApiRequest = url.pathname.startsWith('/api/') || 
                       url.port === '3001' ||
                       (url.hostname === 'localhost' && url.port === '3001') ||
                       (url.hostname.match(/^192\.168\./) && url.port === '3001') ||
                       url.pathname.startsWith('/health') ||
                       url.pathname.includes('/pairing/');
  
  if (isApiRequest) {
    // Backend API request - don't intercept, let browser handle it directly
    // This prevents ServiceWorker from interfering with CORS or network errors
    return;
  }
  
  // Only handle GET requests for same-origin resources
  if (event.request.method !== 'GET') {
    return;
  }
  
  // Only handle same-origin requests (not cross-origin)
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      // Return cached version or fetch from network
      return response || fetch(event.request).then((fetchResponse) => {
        // Cache successful responses
        if (fetchResponse && fetchResponse.status === 200) {
          const responseToCache = fetchResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return fetchResponse;
      }).catch(() => {
        // If offline and not in cache, return offline page
        if (event.request.destination === 'document') {
          return caches.match('/offline.html') || caches.match('/');
        }
      });
    })
  );
});

// Background Sync - sync events when connection is restored
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync triggered:', event.tag);
  
  if (event.tag === 'sync-events') {
    event.waitUntil(syncEvents());
  }
});

// Periodic Background Sync - check for updates periodically
self.addEventListener('periodicsync', (event) => {
  console.log('[SW] Periodic sync triggered:', event.tag);
  
  if (event.tag === 'check-updates') {
    event.waitUntil(checkForUpdates());
  }
});

// Message event - handle messages from the app
self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'QUEUE_EVENT') {
    // Queue event for background sync
    queueEvent(event.data.event);
  }
  
  if (event.data && event.data.type === 'SYNC_NOW') {
    // Trigger immediate sync
    event.waitUntil(syncEvents());
  }
  
  if (event.data && event.data.type === 'CLIPBOARD_UPDATE') {
    // Handle clipboard update in background
    handleClipboardUpdate(event.data.text);
  }
});

// Handle clipboard updates in background
async function handleClipboardUpdate(text) {
  try {
    // Notify all clients about clipboard update
    const clients = await self.clients.matchAll({
      includeUncontrolled: true,
    });
    
    clients.forEach((client) => {
      client.postMessage({
        type: 'CLIPBOARD_UPDATED',
        text: text,
      });
    });
    
    console.log('[SW] Clipboard update handled:', text.substring(0, 50));
  } catch (error) {
    console.error('[SW] Failed to handle clipboard update:', error);
  }
}

// Queue event for later sync
async function queueEvent(event) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const existing = await cache.match(WS_QUEUE_KEY);
    let queue = [];
    
    if (existing) {
      const data = await existing.json();
      queue = data.queue || [];
    }
    
    queue.push({
      event,
      timestamp: Date.now(),
    });
    
    await cache.put(
      WS_QUEUE_KEY,
      new Response(JSON.stringify({ queue }))
    );
    
    console.log('[SW] Event queued, total:', queue.length);
  } catch (error) {
    console.error('[SW] Failed to queue event:', error);
  }
}

// Sync queued events
async function syncEvents() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(WS_QUEUE_KEY);
    
    if (!cached) {
      return;
    }
    
    const data = await cached.json();
    const queue = data.queue || [];
    
    if (queue.length === 0) {
      return;
    }
    
    console.log('[SW] Syncing', queue.length, 'queued events');
    
    // Notify all clients to sync
    const clients = await self.clients.matchAll({
      includeUncontrolled: true,
    });
    
    clients.forEach((client) => {
      client.postMessage({
        type: 'SYNC_QUEUED_EVENTS',
        count: queue.length,
      });
    });
    
    // Clear queue after notifying
    await cache.put(
      WS_QUEUE_KEY,
      new Response(JSON.stringify({ queue: [] }))
    );
  } catch (error) {
    console.error('[SW] Failed to sync events:', error);
  }
}

// Check for updates
async function checkForUpdates() {
  try {
    const clients = await self.clients.matchAll({
      includeUncontrolled: true,
    });
    
    clients.forEach((client) => {
      client.postMessage({
        type: 'CHECK_UPDATES',
      });
    });
  } catch (error) {
    console.error('[SW] Failed to check for updates:', error);
  }
}

// Push notification handler (for future use)
self.addEventListener('push', (event) => {
  console.log('[SW] Push notification received');
  
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'PocketBridge';
  const options = {
    body: data.body || 'New update available',
    icon: '/icon-192.jpg',
    badge: '/icon-192.jpg',
    tag: data.tag || 'default',
    data: data.data,
  };
  
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked');
  event.notification.close();
  
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      // Focus existing window or open new one
      if (clients.length > 0) {
        return clients[0].focus();
      }
      return self.clients.openWindow('/');
    })
  );
});

