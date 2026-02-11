"use client"

/**
 * Secret Chat Page
 *
 * Real-time encrypted chat between paired devices.
 * Chat bubble UI with auto-scroll, message input bar,
 * and browser notification support for incoming messages.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { useCrypto } from '@/hooks/use-crypto';
import { useNotifications } from '@/hooks/use-notifications';
import {
  sendChatMessage,
  loadChatHistory,
  decryptChatEvent,
  type ChatMessage,
} from '@/lib/features/messages';
import { getOrCreateDeviceId } from '@/lib/utils/device';
import { loadPairedAccount } from '@/lib/utils/storage';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Send, Bell, BellOff, ShieldCheck, MessageSquareLock } from 'lucide-react';
import { validateMessageText } from '@/lib/utils/validation';
import { checkRateLimit } from '@/lib/utils/rate-limit';
import { config } from '@/lib/config';
import { logger } from '@/lib/utils/logger';
import { ValidationError } from '@/lib/utils/errors';
import { analytics } from '@/lib/utils/analytics';
import { SyncIndicator } from '@/components/sync-indicator';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import type { EncryptedEvent } from '@/types';

const WS_URL = config.wsUrl;

export default function SecretChatPage() {
  const deviceId = getOrCreateDeviceId();
  const { isInitialized: cryptoInitialized } = useCrypto();
  const { isConnected, sessionKeys, lastEvent } = useWebSocket({
    url: WS_URL,
    deviceId,
    autoConnect: cryptoInitialized,
  });
  const {
    isSupported: notificationsSupported,
    permission: notificationPermission,
    isEnabled: notificationsEnabled,
    requestPermission,
    setEnabled: setNotificationsEnabled,
    showMessageNotification,
  } = useNotifications();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'sending' | 'synced' | 'error'>('idle');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastProcessedEventRef = useRef<string | null>(null);

  // Track page view
  useEffect(() => {
    analytics.page('Secret Chat');
  }, []);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Load chat history when session keys are ready
  useEffect(() => {
    if (sessionKeys) {
      loadChatHistory().then((history) => {
        setMessages(history);
        setTimeout(scrollToBottom, 100);
      });
    }
  }, [sessionKeys, scrollToBottom]);

  // Handle incoming messages
  useEffect(() => {
    if (!lastEvent || !sessionKeys) return;
    if (lastEvent.type !== 'message:text' && lastEvent.type !== 'message:self_destruct') return;

    const eventId = (lastEvent as EncryptedEvent).event_id;
    if (lastProcessedEventRef.current === eventId) return;
    lastProcessedEventRef.current = eventId;

    const isFromOtherDevice = (lastEvent as EncryptedEvent).device_id !== deviceId;

    decryptChatEvent(lastEvent as EncryptedEvent).then((msg) => {
      if (msg) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        setTimeout(scrollToBottom, 100);
        setSyncStatus('synced');

        if (isFromOtherDevice) {
          const remoteId = (lastEvent as EncryptedEvent).device_id;
          const senderName = getRemoteDeviceName(remoteId);
          showMessageNotification(senderName, msg.text, () => {
            window.focus();
          });
        }
      }
    }).catch((err) => {
      logger.warn('Failed to decrypt incoming message', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, [lastEvent, sessionKeys, deviceId, showMessageNotification, scrollToBottom]);

  // Scroll when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  async function handleSend() {
    if (!sessionKeys || !inputText.trim() || isSending) return;

    const rateLimit = checkRateLimit(`message:${deviceId}`, 'messageSend');
    if (!rateLimit.allowed) {
      const resetIn = Math.ceil((rateLimit.resetAt - Date.now()) / 1000);
      toast(`Rate limit. Wait ${resetIn}s.`, 'error');
      return;
    }

    setIsSending(true);
    setSyncStatus('sending');
    try {
      const sanitizedText = validateMessageText(inputText);
      await sendChatMessage(sanitizedText);

      // Optimistic local message
      const localMsg: ChatMessage = {
        id: `local-${Date.now()}`,
        text: sanitizedText,
        timestamp: Date.now(),
        deviceId,
        isLocal: true,
      };
      setMessages((prev) => [...prev, localMsg]);
      setInputText('');
      setSyncStatus('synced');
      inputRef.current?.focus();
      analytics.feature('messages', 'send');
    } catch (error) {
      logger.error('Failed to send message', error);
      if (error instanceof ValidationError) {
        toast(error.message, 'error');
      } else {
        toast('Failed to send message.', 'error');
      }
      setSyncStatus('error');
    } finally {
      setIsSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Look up a friendly device name from paired account info
  function getRemoteDeviceName(remoteDeviceId: string): string {
    const pairedAccount = loadPairedAccount();
    if (pairedAccount?.devices) {
      const device = pairedAccount.devices.find(d => d.device_id === remoteDeviceId);
      if (device?.device_name) return device.device_name;
    }
    return 'Other device';
  }

  function formatTime(timestamp: number) {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  if (!cryptoInitialized) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Initializing encryption...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <MessageSquareLock className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">Secret Chat</h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" />
              End-to-end encrypted
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {notificationsSupported && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (notificationPermission === 'default') {
                  await requestPermission();
                } else if (notificationPermission === 'granted') {
                  await setNotificationsEnabled(!notificationsEnabled);
                }
              }}
              title={
                notificationPermission === 'denied'
                  ? 'Notifications blocked in browser settings'
                  : notificationsEnabled
                  ? 'Disable notifications'
                  : 'Enable notifications'
              }
              disabled={notificationPermission === 'denied'}
            >
              {notificationsEnabled ? (
                <Bell className="h-4 w-4 text-primary" />
              ) : (
                <BellOff className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          )}
          <SyncIndicator status={syncStatus} />
          <StatusBadge status={isConnected ? 'online' : 'offline'} />
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <MessageSquareLock className="h-12 w-12 text-muted-foreground/50" />
            <p className="mt-4 text-sm font-medium text-muted-foreground">
              No messages yet
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Send a message to start the conversation across your devices
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  'flex',
                  msg.isLocal ? 'justify-end' : 'justify-start'
                )}
              >
                <div
                  className={cn(
                    'max-w-[75%] rounded-2xl px-4 py-2.5',
                    msg.isLocal
                      ? 'rounded-br-md bg-primary text-primary-foreground'
                      : 'rounded-bl-md bg-muted text-foreground'
                  )}
                >
                  <p className="text-sm whitespace-pre-wrap wrap-break-word">{msg.text}</p>
                  <p
                    className={cn(
                      'mt-1 text-[10px]',
                      msg.isLocal
                        ? 'text-primary-foreground/60'
                        : 'text-muted-foreground'
                    )}
                  >
                    {formatTime(msg.timestamp)}
                    {!msg.isLocal && (
                      <span className="ml-1.5">
                        {getRemoteDeviceName(msg.deviceId)}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isConnected ? 'Type a message...' : 'Connect to send messages'}
            disabled={!isConnected}
            rows={1}
            className={cn(
              'flex-1 resize-none rounded-xl border border-input bg-background px-4 py-2.5 text-sm',
              'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring',
              'max-h-32 min-h-10',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
            style={{
              height: 'auto',
              overflow: 'hidden',
            }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 128) + 'px';
            }}
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!inputText.trim() || isSending || !isConnected}
            className="h-10 w-10 shrink-0 rounded-xl"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
