"use client"

/**
 * Session Timeout Component
 * Shows countdown timer and warning before session expiration
 */

import { useEffect, useState } from 'react';
import { Clock, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

interface SessionTimeoutProps {
  expiresAt: Date | string;
  onRefresh?: () => void;
  onExpired?: () => void;
  className?: string;
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'Expired';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function SessionTimeout({ expiresAt, onRefresh, onExpired, className }: SessionTimeoutProps) {
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    const expiryDate = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
    const now = new Date();
    
    // Calculate total duration (assume 24 hours from creation)
    const duration = 24 * 60 * 60 * 1000; // 24 hours in ms
    setTotalDuration(duration);

    function updateTimer() {
      const now = new Date();
      const remaining = expiryDate.getTime() - now.getTime();
      setTimeRemaining(Math.max(0, remaining));

      // Show warning if less than 5 minutes remaining
      const fiveMinutes = 5 * 60 * 1000;
      setShowWarning(remaining > 0 && remaining <= fiveMinutes);

      // Call onExpired callback when session expires
      if (remaining <= 0 && onExpired) {
        onExpired();
      }
    }

    updateTimer();
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [expiresAt, onExpired]);

  const progressValue = totalDuration > 0 ? (timeRemaining / totalDuration) * 100 : 0;
  const isExpired = timeRemaining <= 0;

  return (
    <Card className={cn(className, showWarning && "border-orange-500", isExpired && "border-destructive")}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {showWarning || isExpired ? (
              <AlertTriangle className={cn("h-5 w-5", isExpired ? "text-destructive" : "text-orange-500")} />
            ) : (
              <Clock className="h-5 w-5" />
            )}
            <CardTitle>Session Status</CardTitle>
          </div>
          {!isExpired && onRefresh && (
            <Button variant="outline" size="sm" onClick={onRefresh}>
              Refresh
            </Button>
          )}
        </div>
        <CardDescription>
          {isExpired ? (
            <span className="text-destructive">Session expired</span>
          ) : showWarning ? (
            <span className="text-orange-500">Session expiring soon</span>
          ) : (
            'Your session will expire in'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <span className={cn(
            "text-2xl font-bold tabular-nums",
            isExpired && "text-destructive",
            showWarning && "text-orange-500"
          )}>
            {formatTimeRemaining(timeRemaining)}
          </span>
          {!isExpired && (
            <span className="text-sm text-muted-foreground">
              {new Date(typeof expiresAt === 'string' ? expiresAt : expiresAt.toString()).toLocaleString()}
            </span>
          )}
        </div>

        <Progress 
          value={progressValue} 
          className={cn(
            showWarning && "[&>div]:bg-orange-500",
            isExpired && "[&>div]:bg-destructive"
          )}
        />

        {showWarning && !isExpired && (
          <div className="bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800 rounded-lg p-4">
            <p className="text-sm text-orange-900 dark:text-orange-100">
              <strong>Warning:</strong> Your session will expire in less than 5 minutes. 
              Click "Refresh" to extend your session.
            </p>
          </div>
        )}

        {isExpired && (
          <div className="bg-destructive/10 border border-destructive rounded-lg p-4">
            <p className="text-sm text-destructive">
              <strong>Session Expired:</strong> Please reconnect to continue using PocketBridge.
            </p>
            {onRefresh && (
              <Button variant="destructive" className="mt-3 w-full" onClick={onRefresh}>
                Reconnect
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
