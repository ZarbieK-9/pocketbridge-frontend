'use client';

import { CheckCircle2, Loader2, XCircle, KeyRound, Wifi } from 'lucide-react';
import type { ConnectionStatus } from '@/types';

interface ConnectionProgressProps {
  step: 'pairing' | 'connecting' | 'connected' | 'error';
  connectionStatus?: ConnectionStatus;
  error?: Error | null;
  showDetails?: boolean;
}

export function ConnectionProgress({ step, connectionStatus, error, showDetails = true }: ConnectionProgressProps) {
  const steps = [
    { key: 'pairing', label: 'Pairing', icon: KeyRound, description: 'Validating pairing code and establishing identity' },
    { key: 'connecting', label: 'Connecting', icon: Wifi, description: 'Establishing secure WebSocket connection' },
    { key: 'connected', label: 'Connected', icon: CheckCircle2, description: 'Successfully connected to backend' },
  ];

  const currentStepIndex = steps.findIndex(s => s.key === step);
  const isError = step === 'error';

  return (
    <div className="space-y-4" role="progressbar" aria-label="Connection progress">
      <div className="flex items-center justify-between">
        {steps.map((stepItem, index) => {
          const StepIcon = stepItem.icon;
          const isActive = index === currentStepIndex;
          const isCompleted = index < currentStepIndex;
          const isPending = index > currentStepIndex;

          return (
            <div key={stepItem.key} className="flex flex-col items-center flex-1">
              <div className="flex items-center w-full">
                {/* Line before */}
                {index > 0 && (
                  <div
                    className={`h-1 flex-1 ${
                      isCompleted ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                  />
                )}
                
                {/* Icon */}
                <div
                  className={`flex items-center justify-center w-8 h-8 rounded-full border-2 ${
                    isError && index === currentStepIndex
                      ? 'border-red-500 bg-red-50'
                      : isCompleted
                      ? 'border-green-500 bg-green-50'
                      : isActive
                      ? 'border-primary bg-primary/10'
                      : 'border-gray-300 bg-gray-50'
                  }`}
                >
                  {isError && index === currentStepIndex ? (
                    <XCircle className="h-4 w-4 text-red-500" />
                  ) : isCompleted ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : isActive ? (
                    <StepIcon className="h-4 w-4 text-primary animate-spin" />
                  ) : (
                    <div className="h-4 w-4 rounded-full bg-gray-300" />
                  )}
                </div>

                {/* Line after */}
                {index < steps.length - 1 && (
                  <div
                    className={`h-1 flex-1 ${
                      isCompleted ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                  />
                )}
              </div>
              
              {/* Label */}
              <div className="mt-2 text-center">
                <p
                  className={`text-xs font-medium ${
                    isError && index === currentStepIndex
                      ? 'text-red-600'
                      : isCompleted
                      ? 'text-green-600'
                      : isActive
                      ? 'text-primary'
                      : 'text-gray-500'
                  }`}
                >
                  {stepItem.label}
                </p>
                {showDetails && isActive && (
                  <p className="text-xs text-muted-foreground mt-1 max-w-[120px] mx-auto">
                    {stepItem.description}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg" role="alert">
          <p className="text-sm text-red-800 font-medium">Connection Error</p>
          <p className="text-xs text-red-600 mt-1">{error.message}</p>
        </div>
      )}
    </div>
  );
}

