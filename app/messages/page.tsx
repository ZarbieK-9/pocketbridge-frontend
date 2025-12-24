"use client"

/**
 * Self-Destruct Messages Page - Phase 1
 * 
 * Send secure messages that expire after viewing
 * - TTL enforcement
 * - One-time view semantics
 */

import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { useCrypto } from '@/hooks/use-crypto';
import {
  sendSelfDestructMessage,
  getActiveMessages,
  deleteMessagePayload,
} from '@/lib/features/messages';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Send, Clock, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'wss://backend-production-7f7ab.up.railway.app/ws';

const TTL_OPTIONS = [
  { value: '30', label: '30 seconds' },
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '86400', label: '24 hours' },
];

export default function MessagesPage() {
  const deviceId = getOrCreateDeviceId();
  const { isInitialized: cryptoInitialized } = useCrypto();
  const { isConnected, sessionKeys, lastEvent } = useWebSocket({
    url: WS_URL,
    deviceId,
    autoConnect: cryptoInitialized,
  });

  const [messageText, setMessageText] = useState('');
  const [selectedTTL, setSelectedTTL] = useState('300');
  const [messages, setMessages] = useState<Array<{ eventId: string; text: string; expiresAt: number }>>([]);
  const [isSending, setIsSending] = useState(false);

  // Load messages on mount and when session keys available
  useEffect(() => {
    if (sessionKeys) {
      loadMessages();
      // Refresh messages every 5 seconds to check expiration
      const interval = setInterval(loadMessages, 5000);
      return () => clearInterval(interval);
    }
  }, [sessionKeys]);

  // Handle incoming messages
  useEffect(() => {
    if (lastEvent && lastEvent.type === 'message:self_destruct' && sessionKeys) {
      loadMessages();
    }
  }, [lastEvent, sessionKeys]);

  async function loadMessages() {
    if (!sessionKeys) return;

    try {
      const activeMessages = await getActiveMessages();
      setMessages(activeMessages);
    } catch (error) {
      console.error('[Messages] Failed to load messages:', error);
    }
  }

  async function handleSend() {
    if (!sessionKeys || !messageText.trim() || isSending) return;

    setIsSending(true);
    try {
      const ttlSeconds = parseInt(selectedTTL, 10);
      await sendSelfDestructMessage(messageText, ttlSeconds);
      setMessageText('');
      await loadMessages();
    } catch (error) {
      console.error('[Messages] Failed to send:', error);
      alert('Failed to send message. Please try again.');
    } finally {
      setIsSending(false);
    }
  }

  async function handleDelete(eventId: string) {
    try {
      await deleteMessagePayload(eventId);
      await loadMessages();
    } catch (error) {
      console.error('[Messages] Failed to delete:', error);
    }
  }

  if (!cryptoInitialized) {
    return (
      <div className="container mx-auto p-6">
        <Card className="p-6">
          <p>Initializing cryptography...</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Self-Destruct Messages</h1>
        <StatusBadge status={isConnected ? 'online' : 'offline'} />
      </div>

      {/* Send Message */}
      <Card>
        <CardHeader>
          <CardTitle>Send Message</CardTitle>
          <CardDescription>Create a message that will self-destruct after the timer expires</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="message-text">Message</Label>
            <Textarea
              id="message-text"
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Type your secure message here..."
              className="min-h-32"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="expiry">Self-Destruct Timer</Label>
            <Select value={selectedTTL} onValueChange={setSelectedTTL}>
              <SelectTrigger id="expiry">
                <SelectValue placeholder="Select expiry time" />
              </SelectTrigger>
              <SelectContent>
                {TTL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            className="w-full"
            onClick={handleSend}
            disabled={!messageText.trim() || isSending || !isConnected}
          >
            <Send className="mr-2 h-4 w-4" />
            {isSending ? 'Sending...' : 'Send Secure Message'}
          </Button>
        </CardContent>
      </Card>

      {/* Message History */}
      <Card>
        <CardHeader>
          <CardTitle>Active Messages</CardTitle>
          <CardDescription>Messages that haven't expired yet</CardDescription>
        </CardHeader>
        <CardContent>
          {messages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Clock className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-4 text-sm text-muted-foreground">No active messages</p>
              <p className="mt-2 text-xs text-muted-foreground">Messages will appear here once sent</p>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((msg) => (
                <div
                  key={msg.eventId}
                  className="rounded-lg border p-4 space-y-2"
                >
                  <div className="flex items-start justify-between">
                    <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(msg.eventId)}
                      className="ml-2"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    <span>
                      Expires {formatDistanceToNow(new Date(msg.expiresAt), { addSuffix: true })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
