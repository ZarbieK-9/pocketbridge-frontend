/**
 * Toast Notification Component
 * Simple toast system for sync feedback
 */

'use client';

import { useEffect, useState } from 'react';
import { X, CheckCircle2, AlertCircle, Info, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastType = 'success' | 'error' | 'info' | 'loading';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastProps {
  toast: Toast;
  onClose: (id: string) => void;
}

function ToastComponent({ toast, onClose }: ToastProps) {
  useEffect(() => {
    if (toast.type !== 'loading' && toast.duration !== 0) {
      const timer = setTimeout(() => {
        onClose(toast.id);
      }, toast.duration || 3000);
      return () => clearTimeout(timer);
    }
  }, [toast, onClose]);

  const icons = {
    success: CheckCircle2,
    error: AlertCircle,
    info: Info,
    loading: Loader2,
  };

  const styles = {
    success: 'bg-green-50 border-green-200 text-green-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
    loading: 'bg-gray-50 border-gray-200 text-gray-800',
  };

  const Icon = icons[toast.type];

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border p-4 shadow-lg min-w-[300px] max-w-[500px]',
        styles[toast.type]
      )}
    >
      <Icon
        className={cn(
          'h-5 w-5 shrink-0',
          toast.type === 'loading' && 'animate-spin'
        )}
      />
      <p className="flex-1 text-sm font-medium">{toast.message}</p>
      {toast.type !== 'loading' && (
        <button
          onClick={() => onClose(toast.id)}
          className="shrink-0 text-current opacity-50 hover:opacity-100 transition-opacity"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

let toastIdCounter = 0;
const toasts: Toast[] = [];
const listeners = new Set<(toasts: Toast[]) => void>();

function notifyListeners() {
  listeners.forEach((listener) => listener([...toasts]));
}

export function toast(message: string, type: ToastType = 'info', duration?: number) {
  const id = `toast-${++toastIdCounter}`;
  const newToast: Toast = { id, message, type, duration };
  toasts.push(newToast);
  notifyListeners();
  return id;
}

export function dismissToast(id: string) {
  const index = toasts.findIndex((t) => t.id === id);
  if (index !== -1) {
    toasts.splice(index, 1);
    notifyListeners();
  }
}

export function ToastContainer() {
  const [currentToasts, setCurrentToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const listener = (newToasts: Toast[]) => {
      setCurrentToasts(newToasts);
    };
    listeners.add(listener);
    listener([...toasts]); // Initial state

    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (currentToasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {currentToasts.map((toast) => (
        <ToastComponent
          key={toast.id}
          toast={toast}
          onClose={dismissToast}
        />
      ))}
    </div>
  );
}

