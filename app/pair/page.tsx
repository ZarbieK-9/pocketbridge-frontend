'use client';

import { useState, useEffect, useRef } from 'react';
import { MainLayout } from '@/components/layout/main-layout';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, XCircle, KeyRound, Copy, Check } from 'lucide-react';
import { parsePairingCode, generatePairingCode, type PairingData } from '@/lib/utils/pairing-code';
import { setWsUrl, getWsUrl } from '@/lib/utils/storage';
import { getOrCreateDeviceId, getOrCreateDeviceName, updateDeviceName } from '@/lib/utils/device';
import { useRouter } from 'next/navigation';
import { useCrypto } from '@/hooks/use-crypto';
import { validatePairingCode, validateDeviceName } from '@/lib/utils/validation';
import { checkRateLimit } from '@/lib/utils/rate-limit';
import { config } from '@/lib/config';
import { logger } from '@/lib/utils/logger';
import { ValidationError } from '@/lib/utils/errors';

type PairMode = 'receive' | 'share';

export default function PairPage() {
  const [mode, setMode] = useState<PairMode>('receive');
  const [pairingCode, setPairingCode] = useState('');
  const [newDeviceName, setNewDeviceName] = useState('');
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [pairingData, setPairingData] = useState<PairingData | null>(null);
  const [myPairingCode, setMyPairingCode] = useState<string | null>(null);
  const [myQrCode, setMyQrCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [deviceName, setDeviceName] = useState<string>('');
  const [wsUrl, setWsUrlState] = useState<string>('');
  const [codeExpiresAt, setCodeExpiresAt] = useState<Date | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const generatingRef = useRef(false); // Prevent duplicate generation
  const router = useRouter();
  const cryptoState = useCrypto();
  const { identityKeyPair, isInitialized, error: cryptoError } = cryptoState;

  // Track client-side mount to prevent hydration mismatches
  useEffect(() => {
    setIsMounted(true);
    const currentDeviceName = getOrCreateDeviceName();
    const currentWsUrl = getWsUrl() || config.wsUrl || process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001/ws';
    
    setDeviceName(currentDeviceName || 'Unknown Device');
    setNewDeviceName(currentDeviceName || 'Unknown Device');
    setWsUrlState(currentWsUrl);
    
    // Debug logging
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Pair page initialized', {
        deviceName: currentDeviceName,
        wsUrl: currentWsUrl,
        hasStoredWsUrl: !!getWsUrl(),
        envWsUrl: process.env.NEXT_PUBLIC_WS_URL,
        configWsUrl: config.wsUrl,
      });
    }
  }, []);

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
    setPairingCode(value);
    setResult(null);
  };

  // Generate pairing code and QR code for sharing
  useEffect(() => {
    // Reset when switching modes
    if (mode !== 'share') {
      setMyPairingCode(null);
      setMyQrCode(null);
      setCodeExpiresAt(null);
      generatingRef.current = false;
      return;
    }

    if (mode === 'share' && isInitialized && identityKeyPair && isMounted && !generatingRef.current) {
      generatingRef.current = true; // Prevent duplicate generation
      
      const generateMyPairingCode = async () => {
        try {
          // Rate limiting for pairing code generation
          const deviceId = getOrCreateDeviceId();
          const rateLimit = checkRateLimit(`pairing:${deviceId}`, 'pairingCode');
          if (!rateLimit.allowed) {
            const resetIn = Math.ceil((rateLimit.resetAt - Date.now()) / 1000 / 60);
            setResult({
              success: false,
              message: `Rate limit exceeded. Please wait ${resetIn} minutes before generating a new pairing code.`,
            });
            generatingRef.current = false;
            return;
          }

          const currentWsUrl = wsUrl || getWsUrl() || config.wsUrl;
          const currentDeviceName = deviceName || getOrCreateDeviceName();

          const data: PairingData = {
            wsUrl: currentWsUrl,
            userId: identityKeyPair.publicKeyHex,
            deviceId,
            deviceName: currentDeviceName,
            publicKeyHex: identityKeyPair.publicKeyHex,
            privateKeyHex: identityKeyPair.privateKeyHex,
          };

          try {
            const { code, expiresAt } = await generatePairingCode(data);
            setMyPairingCode(code);
            setCodeExpiresAt(expiresAt);
            // Calculate initial time remaining
            const now = Date.now();
            const expires = expiresAt.getTime();
            const remaining = Math.max(0, Math.floor((expires - now) / 1000));
            setTimeRemaining(remaining);
            logger.info('Pairing code generated', { expiresAt });
          } catch (error) {
            logger.error('Failed to generate pairing code', error);
            setResult({
              success: false,
              message: `Failed to generate pairing code: ${error instanceof Error ? error.message : String(error)}`,
            });
            generatingRef.current = false; // Allow retry on error
          }

          // Generate QR code
          const qrcodeModule = await import('qrcode');
          const QRCode = qrcodeModule.default || qrcodeModule;
          const pairingPayload = JSON.stringify({
            type: 'pocketbridge-pairing',
            version: '1.0',
            wsUrl: data.wsUrl,
            userId: data.userId,
            deviceId: data.deviceId,
            deviceName: data.deviceName,
            publicKeyHex: data.publicKeyHex,
            privateKeyHex: data.privateKeyHex,
          });

          const qrDataUrl = await QRCode.toDataURL(pairingPayload, {
            width: 400,
            margin: 2,
            color: {
              dark: '#000000',
              light: '#FFFFFF',
            },
          });
          setMyQrCode(qrDataUrl);
        } catch (error) {
          logger.error('Failed to generate QR code', error);
          generatingRef.current = false; // Allow retry on error
        }
      };

      generateMyPairingCode();
    }
  }, [mode, isInitialized, identityKeyPair, isMounted]);

  // Countdown timer for pairing code expiration
  useEffect(() => {
    if (!codeExpiresAt || timeRemaining <= 0) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const expires = codeExpiresAt.getTime();
      const remaining = Math.max(0, Math.floor((expires - now) / 1000));
      
      setTimeRemaining(remaining);
      
      // Auto-rotate code when expired
      if (remaining === 0 && mode === 'share' && isInitialized && identityKeyPair && isMounted) {
        logger.info('Pairing code expired, generating new one');
        generatingRef.current = false; // Allow regeneration
        // Trigger regeneration by clearing state
        setMyPairingCode(null);
        setMyQrCode(null);
        setCodeExpiresAt(null);
        // The useEffect will trigger regeneration
      }
    }, 1000); // Update every second

    return () => clearInterval(interval);
  }, [codeExpiresAt, timeRemaining, mode, isInitialized, identityKeyPair, isMounted]);

  const handlePair = async () => {
    setResult(null); // Clear previous result
    
    try {
      // Validate pairing code
      const validatedCode = validatePairingCode(pairingCode);
      
      logger.info('Attempting to pair with code', { codeLength: validatedCode.length });
      const data = await parsePairingCode(validatedCode);
      
      if (!data) {
        setResult({
          success: false,
          message: 'Invalid pairing code. Please check and try again.',
        });
        return;
      }

      setPairingData(data);
      setWsUrl(data.wsUrl); // Save to localStorage
      
      // Validate and save device name if changed
      if (newDeviceName && newDeviceName !== deviceName) {
        try {
          const validatedName = validateDeviceName(newDeviceName);
          updateDeviceName(validatedName);
          setDeviceName(validatedName);
        } catch (error) {
          logger.warn('Invalid device name, using existing', { error });
          // Continue with existing device name
        }
      }
      
      setWsUrlState(data.wsUrl); // Update state
      
      setResult({
        success: true,
        message: `Successfully paired with ${data.deviceName || 'device'}. Identity keypair imported.`,
      });

      logger.info('Device paired successfully', { deviceName: data.deviceName });

      // Redirect to home after 2 seconds
      setTimeout(() => {
        router.push('/');
      }, 2000);
    } catch (error) {
      logger.error('Failed to parse pairing code', error);
      if (error instanceof ValidationError) {
        setResult({
          success: false,
          message: error.message,
        });
      } else {
        setResult({
          success: false,
          message: `Failed to pair: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  };

  const handleCopyCode = async () => {
    if (myPairingCode) {
      await navigator.clipboard.writeText(myPairingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Debug: Log crypto state (development only)
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Crypto state', {
        isInitialized,
        hasIdentityKeyPair: !!identityKeyPair,
        hasError: !!cryptoError,
        errorMessage: cryptoError?.message,
      });
    }
  }, [isInitialized, identityKeyPair, cryptoError]);

  if (!isInitialized) {
    return (
      <MainLayout>
        <Header title="Pair Device" description="Initializing..." />
        <div className="p-6">
          <Card>
            <CardHeader>
              <CardTitle>Initializing Cryptography</CardTitle>
              <CardDescription>
                Setting up encryption keys for secure communication...
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary"></div>
                <p className="text-muted-foreground">Initializing cryptography...</p>
              </div>
              {cryptoError && (
                <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded">
                  <p className="text-sm font-semibold text-red-800 mb-2">Initialization Error</p>
                  <p className="text-sm text-red-800">
                    <strong>Error:</strong> {cryptoError.message}
                  </p>
                  <p className="text-xs text-red-600 mt-2">
                    Check the browser console (F12) for more details. Look for logs starting with [useCrypto] or [initializeCrypto].
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => window.location.reload()}
                  >
                    Reload Page
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <Header title="Pair Device" description={mode === 'receive' ? 'Enter code from another device' : 'Share your pairing code'} />

      <div className="p-6 space-y-6">
        {/* Mode Toggle */}
        <div className="flex gap-2 justify-center">
          <Button
            variant={mode === 'receive' ? 'default' : 'outline'}
            onClick={() => setMode('receive')}
            size="sm"
          >
            Receive
          </Button>
          <Button
            variant={mode === 'share' ? 'default' : 'outline'}
            onClick={() => setMode('share')}
            size="sm"
          >
            Share
          </Button>
        </div>

        {mode === 'receive' && (
          <>
          {/* Connection Details - Show in receive mode too */}
          <Card className="bg-muted">
            <CardHeader>
              <CardTitle className="text-base">Connection Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-left">
              <div className="text-sm">
                <span className="font-medium">Device:</span>{' '}
                {isMounted ? (deviceName || getOrCreateDeviceName() || 'Unknown Device') : '...'}
              </div>
              <div className="text-sm">
                <span className="font-medium">Server:</span>{' '}
                {isMounted ? (wsUrl || getWsUrl() || config.wsUrl || 'Not configured') : '...'}
              </div>
              {!isMounted && (
                <div className="text-xs text-muted-foreground mt-2">
                  Loading connection details...
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
          <CardHeader>
            <CardTitle>Enter Pairing Code</CardTitle>
            <CardDescription>
              Get the 6-digit code from the device you want to connect to
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-device-name">Device Name</Label>
              <Input
                id="new-device-name"
                type="text"
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                placeholder="Enter a name for this device"
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Give this device a memorable name (e.g., "My iPhone", "Work Laptop")
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pairing-code">Pairing Code</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="pairing-code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={pairingCode}
                  onChange={handleCodeChange}
                  placeholder="000000"
                  className="text-center text-3xl font-mono font-bold tracking-widest h-16"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Enter the 6-digit code displayed on the other device
              </p>
            </div>

            <Button
              onClick={handlePair}
              disabled={Boolean(!isMounted || !isInitialized || pairingCode.length !== 6)}
              className="w-full"
            >
              <KeyRound className="h-4 w-4 mr-2" />
              Pair Device
            </Button>

            {result && (
              <div className="space-y-4">
                <div
                  className={`flex items-center gap-3 p-4 rounded-lg ${
                    result.success
                      ? 'bg-green-50 border border-green-200'
                      : 'bg-red-50 border border-red-200'
                  }`}
                >
                  {result.success ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-600" />
                  )}
                  <p
                    className={
                      result.success ? 'text-green-800' : 'text-red-800'
                    }
                  >
                    {result.message}
                  </p>
                </div>

                {result.success && pairingData && (
                  <div className="p-4 bg-muted rounded-lg space-y-2">
                    <p className="text-sm font-medium">Connection Details:</p>
                    <p className="text-xs text-muted-foreground">
                      Device: {pairingData.deviceName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Server: {pairingData.wsUrl}
                    </p>
                  </div>
                )}

                {!result.success && (
                  <Button
                    onClick={() => {
                      setPairingCode('');
                      setResult(null);
                    }}
                    variant="outline"
                    className="w-full"
                  >
                    Try Again
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Manual Configuration</CardTitle>
            <CardDescription>
              Or enter the WebSocket URL manually
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              If you have the WebSocket URL, you can enter it directly.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                const url = prompt('Enter WebSocket URL (e.g., ws://192.168.1.100:3001/ws):');
                if (url) {
                  setWsUrl(url); // Save to localStorage
                  setWsUrlState(url); // Update state
                  router.push('/');
                }
              }}
              className="w-full"
            >
              Enter URL Manually
            </Button>
          </CardContent>
        </Card>
        </>
        )}

        {mode === 'share' && (
          <>
            {/* QR Code */}
            {myQrCode && (
              <Card className="text-center">
                <CardHeader>
                  <CardTitle>Scan QR Code</CardTitle>
                  <CardDescription>
                    Scan this QR code with another device to pair
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex justify-center">
                    <div className="inline-block p-4 bg-white rounded-lg shadow-sm border">
                      <img
                        src={myQrCode}
                        alt="Pairing QR Code"
                        className="block max-w-full h-auto"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Pairing Code */}
            {myPairingCode && (
              <Card className="text-center">
                <CardHeader>
                  <CardTitle>Pairing Code</CardTitle>
                  <CardDescription>
                    Enter this 6-digit code on the device you want to pair
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex justify-center">
                    <div className="inline-flex items-center gap-4 px-8 py-6 bg-primary/10 rounded-lg border-2 border-primary">
                      <span className="text-5xl font-mono font-bold text-primary tracking-wider">
                        {myPairingCode}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleCopyCode}
                        className="h-10 w-10"
                      >
                        {copied ? (
                          <Check className="h-5 w-5 text-green-600" />
                        ) : (
                          <Copy className="h-5 w-5" />
                        )}
                      </Button>
                    </div>
                  </div>
                  
                  {/* Countdown Timer */}
                  {timeRemaining > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-center gap-2">
                        <div className={`text-sm font-medium ${timeRemaining < 60 ? 'text-red-600' : timeRemaining < 300 ? 'text-orange-600' : 'text-muted-foreground'}`}>
                          Expires in: {Math.floor(timeRemaining / 60)}:{(timeRemaining % 60).toString().padStart(2, '0')}
                        </div>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2">
                        <div
                          className={`h-2 rounded-full transition-all ${
                            timeRemaining < 60
                              ? 'bg-red-500'
                              : timeRemaining < 300
                              ? 'bg-orange-500'
                              : 'bg-primary'
                          }`}
                          style={{ width: `${(timeRemaining / (10 * 60)) * 100}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Code will automatically refresh when expired
                      </p>
                    </div>
                  )}
                  
                  {timeRemaining === 0 && myPairingCode && (
                    <div className="text-sm text-muted-foreground">
                      Generating new code...
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="bg-muted">
              <CardHeader>
                <CardTitle className="text-base">Connection Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-left">
                <div className="text-sm">
                  <span className="font-medium">Device:</span>{' '}
                  {isMounted ? (deviceName || getOrCreateDeviceName() || 'Unknown Device') : '...'}
                </div>
                <div className="text-sm">
                  <span className="font-medium">Server:</span>{' '}
                  {isMounted ? (wsUrl || getWsUrl() || config.wsUrl || 'Not configured') : '...'}
                </div>
                {!isMounted && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Loading connection details...
                  </div>
                )}
              </CardContent>
            </Card>

            <p className="text-sm text-muted-foreground text-center">
              This code includes your identity keypair. Keep it secure and only share with devices you trust.
            </p>
          </>
        )}
      </div>
    </MainLayout>
  );
}
