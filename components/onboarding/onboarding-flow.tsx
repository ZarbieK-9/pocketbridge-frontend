'use client';

/**
 * Onboarding Flow Component
 * 
 * Guides new users through initial setup:
 * 1. Welcome screen
 * 2. Device name setup
 * 3. Preferences (optional)
 * 4. Complete
 */

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, ArrowRight, ArrowLeft } from 'lucide-react';
import { validateDeviceName } from '@/lib/utils/validation';
import { updateDeviceName } from '@/lib/utils/device';
import { updateUserProfile, completeOnboarding, type UserProfile } from '@/lib/utils/user-profile';
import { logger } from '@/lib/utils/logger';
import { ValidationError } from '@/lib/utils/errors';

interface OnboardingFlowProps {
  userId: string;
  currentDeviceName: string;
  onComplete: () => void;
}

type OnboardingStep = 'welcome' | 'device-name' | 'preferences' | 'complete';

export function OnboardingFlow({ userId, currentDeviceName, onComplete }: OnboardingFlowProps) {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [deviceName, setDeviceName] = useState(currentDeviceName);
  const [deviceNameError, setDeviceNameError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [preferences, setPreferences] = useState<Partial<UserProfile['preferences']>>({
    theme: 'auto',
    notifications: true,
    autoSync: true,
  });

  const handleDeviceNameChange = (value: string) => {
    setDeviceName(value);
    setDeviceNameError(null);
  };

  const handleDeviceNameSubmit = () => {
    try {
      const validatedName = validateDeviceName(deviceName);
      updateDeviceName(validatedName);
      setDeviceName(validatedName);
      setStep('preferences');
    } catch (error) {
      if (error instanceof ValidationError) {
        setDeviceNameError(error.message);
      } else {
        setDeviceNameError('Invalid device name');
      }
    }
  };

  const handleComplete = async () => {
    try {
      // Save user profile (with server sync and signature verification)
      await updateUserProfile({
        displayName: displayName || undefined,
        preferences,
        onboardingCompleted: true,
      }, userId);
      
      // Mark onboarding as complete on server (with signature)
      await completeOnboarding(userId);
      logger.info('Onboarding completed', { userId, deviceName, displayName });
      onComplete();
    } catch (error) {
      logger.error('Failed to complete onboarding', error);
      // Still complete locally even if server sync fails
      onComplete();
    }
  };

  const renderStep = () => {
    switch (step) {
      case 'welcome':
        return (
          <div className="space-y-6 text-center">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Welcome to PocketBridge!</h2>
              <p className="text-muted-foreground">
                Let's get you set up in just a few steps.
              </p>
            </div>
            <div className="space-y-4 pt-4">
              <div className="flex items-center gap-3 text-left">
                <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                <div>
                  <p className="font-medium">Secure End-to-End Encryption</p>
                  <p className="text-sm text-muted-foreground">Your data is encrypted and only you can access it</p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-left">
                <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                <div>
                  <p className="font-medium">Sync Across Devices</p>
                  <p className="text-sm text-muted-foreground">Access your data from any of your devices</p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-left">
                <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                <div>
                  <p className="font-medium">Private & Decentralized</p>
                  <p className="text-sm text-muted-foreground">No accounts, no passwords, just your keys</p>
                </div>
              </div>
            </div>
            <Button onClick={() => setStep('device-name')} className="w-full">
              Get Started <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        );

      case 'device-name':
        return (
          <div className="space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Name Your Device</h2>
              <p className="text-muted-foreground">
                Give this device a memorable name so you can identify it later.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="onboarding-device-name">Device Name</Label>
              <Input
                id="onboarding-device-name"
                type="text"
                value={deviceName}
                onChange={(e) => handleDeviceNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleDeviceNameSubmit();
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
                  This name will be shown to other devices when pairing.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('welcome')} className="flex-1">
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleDeviceNameSubmit} className="flex-1" disabled={!deviceName.trim()}>
                Continue <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        );

      case 'preferences':
        return (
          <div className="space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Set Your Preferences</h2>
              <p className="text-muted-foreground">
                You can change these later in settings.
              </p>
            </div>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="onboarding-display-name">Display Name (Optional)</Label>
                <Input
                  id="onboarding-display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  maxLength={50}
                />
                <p className="text-xs text-muted-foreground">
                  This is how other devices will see you.
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('device-name')} className="flex-1">
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleComplete} className="flex-1">
                Complete Setup <CheckCircle2 className="ml-2 h-4 w-4" />
              </Button>
            </div>
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
        <CardTitle>Welcome to PocketBridge</CardTitle>
        <CardDescription>
          {step === 'welcome' && 'Let\'s get you started'}
          {step === 'device-name' && 'Step 1 of 2'}
          {step === 'preferences' && 'Step 2 of 2'}
          {step === 'complete' && 'Setup complete!'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {renderStep()}
      </CardContent>
    </Card>
  );
}

