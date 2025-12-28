'use client';

/**
 * Onboarding Flow Component
 * 
 * Optimized for new users - minimal steps to get started:
 * 1. Quick setup (device name + optional display name)
 * 2. Complete
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, ArrowRight, Sparkles } from 'lucide-react';
import { validateDeviceName } from '@/lib/utils/validation';
import { updateDeviceName } from '@/lib/utils/device';
import { updateUserProfile, completeOnboarding, loadUserProfile, saveUserProfile, type UserProfile } from '@/lib/utils/user-profile';
import { logger } from '@/lib/utils/logger';
import { ValidationError } from '@/lib/utils/errors';

interface OnboardingFlowProps {
  userId: string;
  currentDeviceName: string;
  onComplete: () => void;
}

type OnboardingStep = 'setup' | 'complete';

export function OnboardingFlow({ userId, currentDeviceName, onComplete }: OnboardingFlowProps) {
  const [step, setStep] = useState<OnboardingStep>('setup');
  const [deviceName, setDeviceName] = useState(currentDeviceName);
  const [deviceNameError, setDeviceNameError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [isCompleting, setIsCompleting] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  
  // Auto-validate device name on mount
  useEffect(() => {
    if (deviceName && deviceName.trim()) {
      try {
        validateDeviceName(deviceName);
        setDeviceNameError(null);
      } catch (error) {
        // Device name exists but might be invalid, let user fix it
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
    // Validate device name first
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
      // Validate and save device name
      const validatedName = validateDeviceName(deviceName);
      updateDeviceName(validatedName);
      
      // Ensure profile exists first
      let existing = loadUserProfile();
      if (!existing || existing.userId !== userId) {
        existing = {
          userId,
          createdAt: Date.now(),
          lastSeen: Date.now(),
          onboardingCompleted: false,
          preferences: {
            theme: 'auto',
            notifications: true,
            autoSync: true,
          },
        };
        saveUserProfile(existing);
      }
      
      // Save user profile (with server sync and signature verification)
      const profileUpdates: { displayName?: string } = {};
      if (displayName && displayName.trim()) {
        profileUpdates.displayName = displayName.trim();
      }
      
      // Update profile if there are actual updates
      if (Object.keys(profileUpdates).length > 0) {
        await updateUserProfile(profileUpdates, userId);
      }
      
      // Mark onboarding as complete on server (with signature)
      await completeOnboarding(userId);
      logger.info('Onboarding completed', { userId, deviceName, displayName });
      
      setStep('complete');
      // Auto-redirect after 1.5 seconds
      setTimeout(() => {
        onComplete();
      }, 1500);
    } catch (error) {
      logger.error('Failed to complete onboarding', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to complete onboarding';
      setCompletionError(errorMessage);
      
      // Still complete locally even if server sync fails
      const existing = loadUserProfile();
      if (existing) {
        existing.onboardingCompleted = true;
        saveUserProfile(existing);
      } else {
        const newProfile: UserProfile = {
          userId,
          createdAt: Date.now(),
          lastSeen: Date.now(),
          onboardingCompleted: true,
          preferences: {
            theme: 'auto',
            notifications: true,
            autoSync: true,
          },
          ...(displayName && displayName.trim() ? { displayName: displayName.trim() } : {}),
        };
        saveUserProfile(newProfile);
      }
      
      // Show success even if server sync failed (local save succeeded)
      setStep('complete');
      setTimeout(() => {
        onComplete();
      }, 2000);
    } finally {
      setIsCompleting(false);
    }
  };

  const renderStep = () => {
    switch (step) {
      case 'setup':
        return (
          <div className="space-y-6">
            <div className="space-y-2 text-center">
              <div className="flex items-center justify-center mb-2">
                <Sparkles className="h-8 w-8 text-primary" />
              </div>
              <h2 className="text-2xl font-bold">Welcome to PocketBridge!</h2>
              <p className="text-muted-foreground text-sm">
                Let's set up your device in seconds
              </p>
            </div>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="onboarding-device-name">Device Name *</Label>
                <Input
                  id="onboarding-device-name"
                  type="text"
                  value={deviceName}
                  onChange={(e) => handleDeviceNameChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canComplete()) {
                      handleComplete();
                    }
                  }}
                  placeholder="e.g., My Laptop, Work Phone"
                  className={deviceNameError ? 'border-red-500' : ''}
                  aria-invalid={!!deviceNameError}
                  aria-describedby={deviceNameError ? 'device-name-error' : undefined}
                  autoFocus
                />
                {deviceNameError ? (
                  <p id="device-name-error" className="text-xs text-red-600" role="alert">
                    {deviceNameError}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This name helps you identify this device when pairing.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="onboarding-display-name">Your Name (Optional)</Label>
                <Input
                  id="onboarding-display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canComplete()) {
                      handleComplete();
                    }
                  }}
                  placeholder="How should other devices see you?"
                  maxLength={50}
                />
                <p className="text-xs text-muted-foreground">
                  You can change this anytime in settings.
                </p>
              </div>
            </div>

            {completionError && (
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                <p className="text-sm text-yellow-800">
                  <strong>Note:</strong> {completionError}. Your settings are saved locally.
                </p>
              </div>
            )}

            <Button 
              onClick={handleComplete} 
              className="w-full" 
              disabled={!canComplete() || isCompleting}
              size="lg"
            >
              {isCompleting ? (
                <>Setting up...</>
              ) : (
                <>Get Started <ArrowRight className="ml-2 h-4 w-4" /></>
              )}
            </Button>
            
            <p className="text-xs text-center text-muted-foreground">
              Your data is encrypted end-to-end. No accounts needed.
            </p>
          </div>
        );

      case 'complete':
        return (
          <div className="space-y-6 text-center">
            <div className="space-y-2">
              <CheckCircle2 className="h-16 w-16 text-green-600 mx-auto" />
              <h2 className="text-2xl font-bold">You're All Set!</h2>
              <p className="text-muted-foreground">
                Your PocketBridge account is ready to use.
              </p>
            </div>
            <Button onClick={onComplete} className="w-full">
              Start Using PocketBridge
            </Button>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <Card className="max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle>
          {step === 'setup' ? 'Quick Setup' : 'All Set!'}
        </CardTitle>
        <CardDescription>
          {step === 'setup' && 'Just one quick step to get started'}
          {step === 'complete' && 'Your PocketBridge is ready'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {renderStep()}
      </CardContent>
    </Card>
  );
}

