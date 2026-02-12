"use client"

/**
 * Secret Chat Page
 *
 * Real-time encrypted chat between paired devices.
 * Chat bubble UI with auto-scroll, message input bar,
 * and browser notification support for incoming messages.
 */

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
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
import { Send, Bell, BellOff, ShieldCheck, MessageSquareLock, CheckCheck, ArrowUp } from 'lucide-react';
import { validateMessageText } from '@/lib/utils/validation';
import { checkRateLimit } from '@/lib/utils/rate-limit';
import { config } from '@/lib/config';
import { logger } from '@/lib/utils/logger';
import { ValidationError } from '@/lib/utils/errors';
import { analytics } from '@/lib/utils/analytics';
import { SyncIndicator } from '@/components/sync-indicator';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { MainLayout } from '@/components/layout/main-layout';
import type { EncryptedEvent } from '@/types';

const WS_URL = config.wsUrl;

function groupMessagesByDate(messages: ChatMessage[]) {
  const groups: { label: string; messages: ChatMessage[] }[] = [];
  let currentLabel = '';

  for (const msg of messages) {
    const date = new Date(msg.timestamp);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);

    let label: string;
    if (diffDays === 0) label = 'Today';
    else if (diffDays === 1) label = 'Yesterday';
    else if (diffDays < 7) label = date.toLocaleDateString(undefined, { weekday: 'long' });
    else label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    if (label !== currentLabel) {
      groups.push({ label, messages: [msg] });
      currentLabel = label;
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }
  return groups;
}

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

  const messageGroups = useMemo(() => groupMessagesByDate(messages), [messages]);

  if (!cryptoInitialized) {
    return (
      <MainLayout>
        <div className="flex h-full items-center justify-center">
          <div className="text-center space-y-3 animate-in fade-in duration-500">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-950/40 animate-pulse">
              <MessageSquareLock className="h-8 w-8 text-blue-500" />
            </div>
            <p className="text-sm text-muted-foreground">Initializing encryption...</p>
          </div>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
    <div className="flex h-full flex-col">
      {/* Gradient Header */}
      <div className="border-b border-border bg-linear-to-b from-blue-50/60 to-card dark:from-blue-950/20 dark:to-card animate-in fade-in duration-400">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-linear-to-br from-[#007AFF] to-[#5856D6]">
              <MessageSquareLock className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">Secret Chat</h1>
              <div className="mt-0.5 flex items-center gap-3">
                <span className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                  isConnected
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                    : 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400'
                )}>
                  <ShieldCheck className="h-3 w-3" />
                  {isConnected ? 'Encrypted' : 'Offline'}
                </span>
                {messages.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {messages.length} message{messages.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {notificationsSupported && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 rounded-full"
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
          </div>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center animate-in fade-in duration-500">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-linear-to-br from-blue-50 to-violet-50 dark:from-blue-950/30 dark:to-violet-950/30">
              <MessageSquareLock className="h-10 w-10 text-blue-400 dark:text-blue-500" />
            </div>
            <h3 className="mt-5 text-lg font-semibold text-foreground">Start a Conversation</h3>
            <p className="mt-1.5 max-w-60 text-sm text-muted-foreground">
              Send a message to start chatting securely across your devices
            </p>
            <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              End-to-end encrypted
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {messageGroups.map((group) => (
              <div key={group.label}>
                {/* Date separator */}
                <div className="flex items-center gap-3 py-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[11px] font-medium text-muted-foreground">{group.label}</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                {/* Messages in group */}
                <div className="space-y-1.5">
                  {group.messages.map((msg, idx) => {
                    const isLocal = msg.isLocal;
                    const isFirst = idx === 0 || group.messages[idx - 1].isLocal !== isLocal;
                    const isLast = idx === group.messages.length - 1 || group.messages[idx + 1].isLocal !== isLocal;

                    return (
                      <div
                        key={msg.id}
                        className={cn(
                          'flex',
                          isLocal ? 'justify-end' : 'justify-start'
                        )}
                      >
                        <div
                          className={cn(
                            'max-w-[75%] px-4 py-2.5',
                            isLocal
                              ? 'bg-linear-to-br from-[#007AFF] to-[#5856D6] text-white'
                              : 'bg-muted text-foreground',
                            // Adaptive border radius based on grouping position
                            isLocal
                              ? cn(
                                  'rounded-2xl',
                                  isFirst && isLast ? 'rounded-br-md' : '',
                                  isFirst && !isLast ? 'rounded-br-lg' : '',
                                  !isFirst && isLast ? 'rounded-br-md rounded-tr-lg' : '',
                                  !isFirst && !isLast ? 'rounded-r-lg' : '',
                                )
                              : cn(
                                  'rounded-2xl',
                                  isFirst && isLast ? 'rounded-bl-md' : '',
                                  isFirst && !isLast ? 'rounded-bl-lg' : '',
                                  !isFirst && isLast ? 'rounded-bl-md rounded-tl-lg' : '',
                                  !isFirst && !isLast ? 'rounded-l-lg' : '',
                                )
                          )}
                        >
                          <p className="text-sm whitespace-pre-wrap wrap-break-word">{msg.text}</p>
                          <div
                            className={cn(
                              'mt-1 flex items-center gap-1 text-[10px]',
                              isLocal
                                ? 'justify-end text-white/60'
                                : 'text-muted-foreground'
                            )}
                          >
                            <span>{formatTime(msg.timestamp)}</span>
                            {!isLocal && (
                              <span className="ml-1">
                                {getRemoteDeviceName(msg.deviceId)}
                              </span>
                            )}
                            {isLocal && (
                              <CheckCheck className="h-3 w-3 text-white/50" />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="border-t border-border bg-card/80 backdrop-blur-sm px-4 py-3">
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
              'flex-1 resize-none rounded-2xl border border-input bg-background px-4 py-2.5 text-sm',
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
          <button
            onClick={handleSend}
            disabled={!inputText.trim() || isSending || !isConnected}
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-all',
              inputText.trim() && !isSending && isConnected
                ? 'bg-linear-to-br from-[#007AFF] to-[#5856D6] text-white shadow-md hover:opacity-90'
                : 'bg-muted text-muted-foreground'
            )}
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
    </MainLayout>
  );
}
