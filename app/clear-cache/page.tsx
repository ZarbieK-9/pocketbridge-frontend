'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function ClearCachePage() {
  const handleClearAll = () => {
    // Clear all localStorage
    localStorage.clear();
    
    // Clear all sessionStorage
    sessionStorage.clear();
    
    // Clear IndexedDB (if any)
    if (window.indexedDB) {
      window.indexedDB.databases().then((dbs) => {
        dbs.forEach((db) => {
          if (db.name) {
            window.indexedDB.deleteDatabase(db.name);
          }
        });
      });
    }
    
    alert('Cache cleared! The page will reload.');
    window.location.href = '/';
  };

  const handleClearWebSocket = () => {
    // Clear WebSocket related items
    localStorage.removeItem('pocketbridge_ws_url');
    localStorage.removeItem('pocketbridge_api_url');
    localStorage.removeItem('pocketbridge_server_key_pin');
    
    alert('WebSocket cache cleared! The page will reload.');
    window.location.reload();
  };

  const handleClearIdentity = () => {
    // Clear identity keypair
    localStorage.removeItem('pocketbridge_identity_keypair');
    
    alert('Identity cleared! The page will reload.');
    window.location.reload();
  };

  return (
    <div className="container max-w-2xl mx-auto py-8">
      <Card>
        <CardHeader>
          <CardTitle>Clear Cache & Reset</CardTitle>
          <CardDescription>
            Clear cached data and reset application state
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">Current Storage:</h3>
            <pre className="bg-muted p-4 rounded text-xs overflow-auto">
              {typeof window !== 'undefined' && JSON.stringify({
                localStorage: Object.keys(localStorage),
                count: localStorage.length,
                wsUrl: localStorage.getItem('pocketbridge_ws_url'),
                apiUrl: localStorage.getItem('pocketbridge_api_url'),
              }, null, 2)}
            </pre>
          </div>

          <div className="space-y-2">
            <Button onClick={handleClearWebSocket} variant="outline" className="w-full">
              Clear WebSocket Settings
            </Button>
            
            <Button onClick={handleClearIdentity} variant="outline" className="w-full">
              Clear Identity (Reset Device)
            </Button>
            
            <Button onClick={handleClearAll} variant="destructive" className="w-full">
              Clear All Cache & Storage
            </Button>
          </div>

          <div className="text-sm text-muted-foreground">
            <p><strong>Environment Variables:</strong></p>
            <ul className="list-disc list-inside space-y-1">
              <li>WS URL: {process.env.NEXT_PUBLIC_WS_URL || 'Not set'}</li>
              <li>API URL: {process.env.NEXT_PUBLIC_API_URL || 'Not set'}</li>
              <li>NODE_ENV: {process.env.NODE_ENV}</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
