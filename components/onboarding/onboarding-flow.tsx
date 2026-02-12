'use client';

/**
 * Onboarding Flow — Polished first-run experience
 *
 * Logo + feature cards + device name input + gradient CTA
 */

import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, ArrowRight, FolderSync, FileText, MessageSquare, ShieldCheck, Smartphone, Lock } from 'lucide-react';
import { validateDeviceName } from '@/lib/utils/validation';
import { updateDeviceName } from '@/lib/utils/device';
import { completeOnboarding, loadUserProfile, saveUserProfile } from '@/lib/utils/user-profile';
import { logger } from '@/lib/utils/logger';
import { ValidationError } from '@/lib/utils/errors';
import { PocketBridgeLogo } from '@/components/ui/logo';

interface OnboardingFlowProps {
  userId: string;
  currentDeviceName: string;
  onComplete: () => void;
}

type OnboardingStep = 'setup' | 'complete';

const FEATURES = [
  {
    icon: FolderSync,
    title: 'File Transfer',
    description: 'Send files across devices instantly',
    color: 'text-blue-500',
    bg: 'bg-blue-50 dark:bg-blue-950/50',
  },
  {
    icon: FileText,
    title: 'Shared Scratchpad',
    description: 'Real-time collaborative notes',
    color: 'text-emerald-500',
    bg: 'bg-emerald-50 dark:bg-emerald-950/50',
  },
  {
    icon: MessageSquare,
    title: 'Secret Chat',
    description: 'Encrypted messaging between devices',
    color: 'text-violet-500',
    bg: 'bg-violet-50 dark:bg-violet-950/50',
  },
  {
    icon: ShieldCheck,
    title: 'End-to-End Encrypted',
    description: 'Only you can access your data',
    color: 'text-amber-500',
    bg: 'bg-amber-50 dark:bg-amber-950/50',
  },
];

export function OnboardingFlow({ userId, currentDeviceName, onComplete }: OnboardingFlowProps) {
  const [step, setStep] = useState<OnboardingStep>('setup');
  const [deviceName, setDeviceName] = useState(currentDeviceName);
  const [deviceNameError, setDeviceNameError] = useState<string | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (deviceName && deviceName.trim()) {
      try {
        validateDeviceName(deviceName);
        setDeviceNameError(null);
      } catch {
        // Let user fix it
      }
    }
  }, []);

  const handleDeviceNameChange = (value: string) => {
    setDeviceName(value);
    setDeviceNameError(null);
  };

  const canComplete = () => {
    return deviceName && deviceName.trim() && !deviceNameError;
  };

  const handleComplete = async () => {
    if (!canComplete()) {
      try {
        validateDeviceName(deviceName);
      } catch (error) {
        if (error instanceof ValidationError) {
          setDeviceNameError(error.message);
        } else {
          setDeviceNameError('Invalid device name');
        }
        return;
      }
    }

    setIsCompleting(true);
    setCompletionError(null);

    try {
      const validatedDeviceName = validateDeviceName(deviceName);
      updateDeviceName(validatedDeviceName);

      let existing = loadUserProfile();
      if (!existing || existing.userId !== userId) {
        existing = {
          userId,
          createdAt: Date.now(),
          lastSeen: Date.now(),
          onboardingCompleted: false,
          preferences: { theme: 'auto', notifications: true, autoSync: true },
        };
        saveUserProfile(existing);
      }

      await completeOnboarding(userId);
      logger.info('Onboarding completed successfully', { userId, deviceName: validatedDeviceName });

      setStep('complete');
      setTimeout(() => onComplete(), 1500);
    } catch (error) {
      logger.error('Failed to complete onboarding', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to complete onboarding';
      setCompletionError(errorMessage);
    } finally {
      setIsCompleting(false);
    }
  };

  if (step === 'complete') {
    return (
      <div className="w-full max-w-lg mx-auto animate-in fade-in duration-500">
        <div className="rounded-2xl border border-border bg-card p-10 text-center shadow-lg space-y-6">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-950/50">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
          </div>
          <h2 className="text-2xl font-bold text-foreground">You&apos;re All Set!</h2>
          <p className="text-muted-foreground">
            Your PocketBridge workspace is ready to use.
          </p>
          <button
            onClick={onComplete}
            className="w-full rounded-xl bg-linear-to-r from-[#2f80ed] to-[#5856D6] px-6 py-3.5 text-base font-semibold text-white transition-opacity hover:opacity-90"
          >
            Start Using PocketBridge
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="rounded-2xl border border-border bg-card shadow-lg overflow-hidden">
        {/* Hero */}
        <div className="px-8 pt-10 pb-6 text-center animate-in fade-in duration-500">
          <div className="mx-auto mb-5 flex h-28 w-28 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-950/40">
            <PocketBridgeLogo size={88} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Welcome to PocketBridge
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sync seamlessly across all your devices
          </p>
        </div>

        {/* Features */}
        <div className="px-8 pb-6 space-y-2.5">
          {FEATURES.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="flex items-center gap-3.5 rounded-xl border border-border/50 bg-card px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-400"
                style={{ animationDelay: `${150 + i * 80}ms`, animationFillMode: 'backwards' }}
              >
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${feature.bg}`}>
                  <Icon className={`h-5 w-5 ${feature.color}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{feature.title}</p>
                  <p className="text-xs text-muted-foreground">{feature.description}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Device name input */}
        <div
          className="px-8 pb-6 space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-400"
          style={{ animationDelay: '500ms', animationFillMode: 'backwards' }}
        >
          <Label htmlFor="onboarding-device-name" className="text-sm font-semibold">
            Name your device
          </Label>
          <div
            className={`flex items-center gap-2.5 rounded-xl border px-3.5 h-12 transition-colors ${
              isFocused
                ? 'border-primary ring-2 ring-primary/20'
                : deviceNameError
                  ? 'border-red-400'
                  : 'border-border'
            } bg-background`}
          >
            <Smartphone className={`h-4 w-4 shrink-0 ${isFocused ? 'text-primary' : 'text-muted-foreground'}`} />
            <Input
              id="onboarding-device-name"
              type="text"
              value={deviceName}
              onChange={(e) => handleDeviceNameChange(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canComplete()) handleComplete();
              }}
              placeholder="e.g., My Laptop, Work PC"
              className="border-0 shadow-none focus-visible:ring-0 px-0 h-full"
              aria-invalid={!!deviceNameError}
              aria-describedby={deviceNameError ? 'device-name-error' : 'device-name-hint'}
              autoFocus
            />
          </div>
          {deviceNameError ? (
            <p id="device-name-error" className="text-xs text-red-500" role="alert">
              {deviceNameError}
            </p>
          ) : (
            <p id="device-name-hint" className="text-xs text-muted-foreground">
              This helps you identify this device when pairing
            </p>
          )}
        </div>

        {/* Error */}
        {completionError && (
          <div className="mx-8 mb-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
            <p className="text-sm text-amber-800 dark:text-amber-200">
              <strong>Note:</strong> {completionError}. Your settings are saved locally.
            </p>
          </div>
        )}

        {/* CTA */}
        <div
          className="px-8 pb-8 space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-400"
          style={{ animationDelay: '600ms', animationFillMode: 'backwards' }}
        >
          <button
            onClick={handleComplete}
            disabled={!canComplete() || isCompleting}
            className="w-full rounded-xl bg-linear-to-r from-[#2f80ed] to-[#5856D6] px-6 py-3.5 text-base font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isCompleting ? (
              'Setting up...'
            ) : (
              <>
                Get Started
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>

          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            <span>No accounts needed. Your data stays private.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
