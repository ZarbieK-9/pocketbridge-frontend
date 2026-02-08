'use client';

import { useState, useEffect, useRef } from 'react';
import { MainLayout } from '@/components/layout/main-layout';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, XCircle, KeyRound, Copy, Check, QrCode } from 'lucide-react';
import { parsePairingCode, generatePairingCode, type PairingData } from '@/lib/utils/pairing-code';
import { getBackendApiUrl } from '@/lib/utils/pairing-code';
import { setWsUrl, getWsUrl, savePairedAccount } from '@/lib/utils/storage';
import { getOrCreateDeviceId, getOrCreateDeviceName, updateDeviceName, setDeviceRole } from '@/lib/utils/device';
import { useRouter } from 'next/navigation';
import { useCrypto } from '@/hooks/use-crypto';
import { useWebSocket } from '@/hooks/use-websocket';
import { validatePairingCode, validateDeviceName } from '@/lib/utils/validation';
import { checkRateLimit } from '@/lib/utils/rate-limit';
import { config } from '@/lib/config';
import { logger } from '@/lib/utils/logger';
import { ValidationError } from '@/lib/utils/errors';
import { ConnectionDetailsCard } from '@/components/pair/connection-details-card';
import { ConnectionProgress } from '@/components/pair/connection-progress';
import { ConnectionStatusIndicator } from '@/components/pair/connection-status-indicator';

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
  const [deviceName, setDeviceName] = useState<string>('');
  const [wsUrl, setWsUrlState] = useState<string>('');
  const [codeExpiresAt, setCodeExpiresAt] = useState<Date | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const [isScanning, setIsScanning] = useState(false);
  const [isPairing, setIsPairing] = useState(false);
  const [pairingStep, setPairingStep] = useState<'pairing' | 'connecting' | 'connected' | 'error'>('pairing');
  const [deviceNameError, setDeviceNameError] = useState<string | null>(null);
  const [cameraPermissionError, setCameraPermissionError] = useState<string | null>(null);
  const generatingRef = useRef(false); // Prevent duplicate generation
  const scannerRef = useRef<any>(null);
  const redirectTimersRef = useRef<{ timer?: NodeJS.Timeout; interval?: NodeJS.Timeout }>({});
  const pairingCodeInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const cryptoState = useCrypto();
  const { identityKeyPair, isInitialized, error: cryptoError } = cryptoState;
  const deviceId = getOrCreateDeviceId();

  // WebSocket connection status
  const { status: connectionStatus, isConnected, error: connectionError, lastSystemMessage } = useWebSocket({
    url: wsUrl,
    deviceId,
    autoConnect: isInitialized && !!wsUrl && wsUrl !== 'Not configured',
    waitForCrypto: true,
  });

  // Initialize device name and URL on mount
  useEffect(() => {
    const currentDeviceName = getOrCreateDeviceName();
    const currentWsUrl = getWsUrl() || config.wsUrl || 'wss://pocketbridge.duckdns.org/ws';
    
    setDeviceName(currentDeviceName || 'Unknown Device');
    setNewDeviceName(currentDeviceName || 'Unknown Device');
    setWsUrlState(currentWsUrl);
  }, []);

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
    setPairingCode(value);
    setResult(null);
    setDeviceNameError(null);
  };

  // Handle paste events for pairing code
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData('text').trim().replace(/\D/g, '').slice(0, 6);
    setPairingCode(pastedText);
    setResult(null);
    setDeviceNameError(null);
    
    // Auto-focus and select all for easy replacement
    if (pairingCodeInputRef.current) {
      pairingCodeInputRef.current.focus();
      pairingCodeInputRef.current.select();
    }
  };

  // Validate device name before pairing
  const validateDeviceNameBeforePair = (): boolean => {
    if (!newDeviceName || newDeviceName.trim() === '') {
      setDeviceNameError('Device name is required');
      return false;
    }
    
    try {
      validateDeviceName(newDeviceName);
      setDeviceNameError(null);
      return true;
    } catch (error) {
      if (error instanceof ValidationError) {
        setDeviceNameError(error.message);
      } else {
        setDeviceNameError('Invalid device name');
      }
      return false;
    }
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

    if (mode === 'share' && isInitialized && identityKeyPair && !generatingRef.current && typeof window !== 'undefined') {
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

          let generatedCode: string | null = null;
          try {
            const { code, expiresAt, shareableWsUrl } = await generatePairingCode(data);
            generatedCode = code;
            // Use the backend-normalized URL (localhost → LAN IP) for sharing with external devices
            if (shareableWsUrl) {
              data.wsUrl = shareableWsUrl;
            }
            setMyPairingCode(code);
            setCodeExpiresAt(expiresAt);
            // Calculate initial time remaining
            const now = Date.now();
            const expires = expiresAt.getTime();
            const remaining = Math.max(0, Math.floor((expires - now) / 1000));
            setTimeRemaining(remaining);
            logger.info('Pairing code generated', { expiresAt });

            // Mark onboarding as complete for Device A (sharer)
            // This ensures Device A can navigate away from /pair without being redirected to onboarding
            try {
              const { completeOnboarding } = await import('@/lib/utils/user-profile');
              await completeOnboarding(identityKeyPair.publicKeyHex);
              // Set device role to sharer
              setDeviceRole('sharer');
              logger.info('[SHARE MODE] Marked onboarding complete for sharer device');
            } catch (onboardingError) {
              logger.warn('[SHARE MODE] Failed to mark onboarding complete (non-blocking)', {
                error: onboardingError instanceof Error ? onboardingError.message : String(onboardingError),
              });
            }
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
            pairingCode: generatedCode,
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
  }, [mode, isInitialized, identityKeyPair, wsUrl, deviceName]);

  // Countdown timer for pairing code expiration
  useEffect(() => {
    if (!codeExpiresAt || timeRemaining <= 0) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const expires = codeExpiresAt.getTime();
      const remaining = Math.max(0, Math.floor((expires - now) / 1000));
      
      setTimeRemaining(remaining);
      
      // Auto-rotate code when expired
      if (remaining === 0 && mode === 'share' && isInitialized && identityKeyPair) {
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
  }, [codeExpiresAt, timeRemaining, mode, isInitialized, identityKeyPair]);

  const handlePair = async (code?: string) => {
    if (isPairing) return; // Prevent multiple pairing attempts
    
    // Validate device name first
    if (!validateDeviceNameBeforePair()) {
      return;
    }
    
    const codeToUse = code || pairingCode;
    setResult(null); // Clear previous result
    setIsPairing(true);
    setPairingStep('pairing');
    
    try {
      // Validate pairing code
      const validatedCode = validatePairingCode(codeToUse);
      
      logger.info('Attempting to pair with code', { codeLength: validatedCode.length });
      // Pass userId if available (for authentication)
      const userId = identityKeyPair?.publicKeyHex;
      const data = await parsePairingCode(validatedCode, userId);
      
      if (!data) {
        setResult({ 
          success: false,
          message: 'Invalid or expired pairing code. Please check and try again.',
        });
        setIsPairing(false);
        setPairingStep('error');
        return;
      }

      setPairingData(data);
      
      // Store pairing code in sessionStorage for completing pairing after WebSocket connects
      // This is needed because the WebSocket handshake must complete before we can send complete_pairing
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('pending_pairing_code', validatedCode);
      }
      
      // If identity keypair is different, save the new one FIRST before proceeding
      // This ensures we use Device A's identity for the complete_pairing message
      if (identityKeyPair && identityKeyPair.publicKeyHex !== data.publicKeyHex) {
        logger.info('[PAIRING] Identity keypair different, saving Device A identity before pairing', {
          oldKeypair: identityKeyPair.publicKeyHex.substring(0, 16) + '...',
          newKeypair: data.publicKeyHex.substring(0, 16) + '...',
          fullOldKeypair: identityKeyPair.publicKeyHex,
          fullNewKeypair: data.publicKeyHex,
        });
        console.log('[PAIRING] IDENTITY CHANGE DETECTED:', {
          from: identityKeyPair.publicKeyHex,
          to: data.publicKeyHex,
        });

        // BACKUP current identity before overwriting with Device A's identity
        // This allows restoring original identity if device is revoked later
        try {
          const { backupIdentityKeyPair } = await import('@/lib/crypto/keys');
          backupIdentityKeyPair();
          logger.info('[PAIRING] Backed up current identity before pairing');
        } catch (backupErr) {
          logger.warn('[PAIRING] Failed to backup identity (non-blocking)', {
            error: backupErr instanceof Error ? backupErr.message : String(backupErr),
          });
        }

        // Save Device A's identity keypair NOW
        try {
          const { saveIdentityKeyPair } = await import('@/lib/crypto/keys');
          const keypair = {
            publicKey: new Uint8Array(
              data.publicKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
            ),
            privateKey: new Uint8Array(
              data.privateKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
            ),
            publicKeyHex: data.publicKeyHex,
            privateKeyHex: data.privateKeyHex,
          };
          saveIdentityKeyPair(keypair);
          logger.info('[PAIRING] Device A identity keypair saved, reloading to re-initialize');

          // Save WebSocket URL and pairing code before reload
          setWsUrl(data.wsUrl);
          sessionStorage.setItem('pending_pairing_code', validatedCode);

          // Reload to pick up new identity - the reloaded page will complete pairing
          setTimeout(() => {
            window.location.reload();
          }, 300);
          return;
        } catch (err) {
          logger.error('[PAIRING] Failed to save identity keypair', err);
          // Continue anyway - will try again after pairing_completed
        }
      }
      
      setWsUrl(data.wsUrl); // Save to localStorage
      
      // Store device name to save after pairing completes
      // (Don't update now - device isn't properly linked until after pairing)
      try {
        const validatedName = validateDeviceName(newDeviceName);
        updateDeviceName(validatedName);
        setDeviceName(validatedName);
        setDeviceNameError(null);
      } catch (error) {
        logger.warn('Invalid device name, using existing', { error });
        // Continue with existing device name
      }
      
      setWsUrlState(data.wsUrl); // Update state
      setPairingStep('connecting');

      setResult({
        success: true,
        message: `Successfully retrieved pairing data. Connecting...`,
      });

      logger.info('Pairing code parsed successfully', { deviceName: data.deviceName });

      // Note: Device name will be updated on backend after pairing completes in the pairing_completed handler
      // This is necessary because the device belongs to Device A until pairing is complete

      // If WebSocket is already connected, send complete_pairing immediately
      // Otherwise, the effect will handle it when connection establishes
      if (isConnected) {
        logger.info('[Pairing] WebSocket already connected, sending complete_pairing immediately');
        try {
          const { getWebSocketClient } = await import('@/lib/ws');
          const client = getWebSocketClient(data.wsUrl, deviceId);
          client.completePairing(validatedCode);
          // Clear the pending code since we're sending it now
          sessionStorage.removeItem('pending_pairing_code');
          setResult({
            success: true,
            message: 'Pairing in progress... Please wait for confirmation.',
          });
        } catch (err) {
          logger.error('[Pairing] Failed to send complete_pairing', err);
          throw err;
        }
      } else {
        logger.info('[Pairing] WebSocket not connected yet, will send complete_pairing when connected');
      }
    } catch (error) {
      setIsPairing(false);
      setPairingStep('error');
      logger.error('Failed to parse pairing code', error);
      
      // Provide more specific error messages
      let errorMessage = 'Failed to pair. Please try again.';
      if (error instanceof ValidationError) {
        errorMessage = error.message;
      } else if (error instanceof Error) {
        if (error.message.includes('Network error') || error.message.includes('fetch')) {
          errorMessage = 'Cannot connect to server. Check your internet connection and try again.';
        } else if (error.message.includes('expired')) {
          errorMessage = 'This pairing code has expired. Please get a new code from the other device.';
        } else {
          errorMessage = error.message;
        }
      }
      
      setResult({
        success: false,
        message: errorMessage,
      });
    }
  };

  // Update pairing step based on connection status
  useEffect(() => {
    if (isPairing) {
      if (isConnected) {
        setPairingStep('connected');
      } else if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') {
        setPairingStep('connecting');
      } else if (connectionStatus === 'error') {
        setPairingStep('error');
      }
    }
  }, [isPairing, isConnected, connectionStatus]);

  // Send complete_pairing message when WebSocket connects after pairing code entry
  useEffect(() => {
    // Log immediately when effect runs to debug timing
    console.log('[Pairing] Effect triggered', { isConnected, isPairing, wsUrl: wsUrl?.substring(0, 30) });

    const completePairingFlow = async () => {
      const hasPendingCode = typeof window !== 'undefined' ? !!sessionStorage.getItem('pending_pairing_code') : false;

      logger.info('[Pairing] completePairingFlow check', {
        isConnected,
        isPairing,
        hasPendingCode,
        wsUrl: wsUrl?.substring(0, 30),
      });

      // Must be connected (isPairing not required - pending code in sessionStorage is enough)
      if (!isConnected || typeof window === 'undefined') {
        logger.info('[Pairing] Skipping - not connected', { isConnected });
        return;
      }

      // Check if there's a pending pairing code to complete
      const pendingCode = sessionStorage.getItem('pending_pairing_code');
      if (!pendingCode) {
        logger.info('[Pairing] No pending pairing code found, skipping completePairing');
        return;
      }

      try {
        // Clear the pending code immediately to prevent duplicate sends
        sessionStorage.removeItem('pending_pairing_code');

        logger.info('Completing pairing flow via WebSocket', {
          codeLength: pendingCode.length,
        });

        // Get the WebSocket client and send complete_pairing message
        const { getWebSocketClient } = await import('@/lib/ws');
        const client = getWebSocketClient(wsUrl, deviceId);
        client.completePairing(pendingCode);

        setResult({
          success: true,
          message: 'Pairing in progress... Please wait for confirmation.',
        });
      } catch (error) {
        logger.error('Failed to complete pairing via WebSocket', error);
        setResult({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to complete pairing',
        });
        setPairingStep('error');
        setIsPairing(false);
      }
    };

    completePairingFlow();
  }, [isConnected, wsUrl, deviceId, isPairing]);

  // Listen for pairing completion system message
  useEffect(() => {
    if (!lastSystemMessage) {
      return;
    }

    if (lastSystemMessage.type === 'pairing_completed' && lastSystemMessage.payload) {
      const payload = lastSystemMessage.payload as { success?: boolean; linkedUserId?: string };
      if (payload.success) {
        logger.info('Pairing completed successfully', { linkedUserId: payload.linkedUserId });
        
        setPairingStep('connected');
        setResult({
          success: true,
          message: 'Pairing completed successfully! Redirecting...',
        });

        // Save the pairing device's identity keypair NOW (after pairing is confirmed)
        // This allows Device B to use the same identity as Device A
        const savePairingIdentity = async () => {
          if (pairingData && pairingData.publicKeyHex && pairingData.privateKeyHex) {
            try {
              logger.info('[PAIRING] Starting to save identity keypair', {
                hasPublicKey: !!pairingData.publicKeyHex,
                hasPrivateKey: !!pairingData.privateKeyHex,
                publicKeyPrefix: pairingData.publicKeyHex.substring(0, 16) + '...',
              });
              
              const { saveIdentityKeyPair } = await import('@/lib/crypto/keys');
              
              const keypair = {
                publicKey: new Uint8Array(
                  pairingData.publicKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
                ),
                privateKey: new Uint8Array(
                  pairingData.privateKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
                ),
                publicKeyHex: pairingData.publicKeyHex,
                privateKeyHex: pairingData.privateKeyHex,
              };
              
              logger.info('[PAIRING] Calling saveIdentityKeyPair with keypair', {
                publicKeyLength: keypair.publicKey.length,
                privateKeyLength: keypair.privateKey.length,
              });
              
              await saveIdentityKeyPair(keypair);
              
              logger.info('[PAIRING] Identity keypair saved successfully to storage', {
                publicKeyPrefix: pairingData.publicKeyHex.substring(0, 16) + '...',
                fullPublicKey: pairingData.publicKeyHex,
              });
              console.log('[PAIRING] KEYPAIR SAVED - Verify in localStorage:', {
                savedPublicKey: pairingData.publicKeyHex,
                storageKey: 'pocketbridge_identity_keypair',
              });
            } catch (error) {
              logger.error('[PAIRING] Failed to save pairing identity keypair', error);
            }
          } else {
            logger.warn('[PAIRING] Cannot save identity keypair: pairingData incomplete', {
              hasPairingData: !!pairingData,
              hasPublicKey: !!pairingData?.publicKeyHex,
              hasPrivateKey: !!pairingData?.privateKeyHex,
            });
          }
        };
        
        // Save identity and redirect - must complete before reload
        const completeAndRedirect = async () => {
          try {
            logger.info('[PAIRING] About to call savePairingIdentity()');
            await savePairingIdentity();

            // Mark onboarding as completed with the NEW identity (Device A's)
            if (pairingData?.publicKeyHex) {
              try {
                const { completeOnboarding } = await import('@/lib/utils/user-profile');
                await completeOnboarding(pairingData.publicKeyHex);
                logger.info('[PAIRING] Onboarding marked complete with new identity');
              } catch (error) {
                logger.warn('Failed to mark onboarding complete after pairing', {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }

            // Save paired account info for persistence across reloads
            if (pairingData?.publicKeyHex) {
              savePairedAccount({
                userId: pairingData.publicKeyHex,
                displayName: pairingData.deviceName, // Will be updated from backend
                pairedAt: Date.now(),
                devices: [],
                deviceRole: 'receiver', // Device B (receiver) role
              });
              // Set device role to receiver
              setDeviceRole('receiver');
              logger.info('[PAIRING] Paired account info saved to localStorage with receiver role');
            }

            // Small delay to ensure storage is flushed
            await new Promise(resolve => setTimeout(resolve, 500));

            logger.info('[PAIRING] Reloading page to reconnect with shared identity');
            window.location.href = '/';
          } catch (error) {
            logger.error('[PAIRING] Failed during save and redirect', error);
            // Still try to redirect even if save failed
            window.location.href = '/';
          }
        };

        completeAndRedirect();
      }
    } else if (lastSystemMessage.type === 'pairing_failed' && lastSystemMessage.payload) {
      const payload = lastSystemMessage.payload as { error?: string };
      logger.error('Pairing failed', undefined, { error: payload.error });
      
      setPairingStep('error');
      setResult({
        success: false,
        message: `Pairing failed: ${payload.error || 'Unknown error'}`,
      });
      setIsPairing(false);
    }
  }, [lastSystemMessage, identityKeyPair, pairingData, router]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (redirectTimersRef.current.timer) {
        clearTimeout(redirectTimersRef.current.timer);
      }
      if (redirectTimersRef.current.interval) {
        clearInterval(redirectTimersRef.current.interval);
      }
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {
          // Ignore stop errors
        });
      }
    };
  }, []);

  // Auto-pair when 6 digits are entered (only once per code)
  const pairingCodeRef = useRef<string>('');
  useEffect(() => {
    if (pairingCode.length === 6 && isInitialized && !isPairing && pairingCode !== pairingCodeRef.current) {
      pairingCodeRef.current = pairingCode;
      handlePair();
    }
  }, [pairingCode, isInitialized, isPairing]);

  // QR Code Scanner
  const startQRScanner = async () => {
    try {
      setCameraPermissionError(null);
      
      // Check camera permissions first
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        // Stop the stream immediately - we just needed to check permission
        stream.getTracks().forEach(track => track.stop());
      } catch (permError: any) {
        if (permError.name === 'NotAllowedError' || permError.name === 'PermissionDeniedError') {
          setCameraPermissionError('Camera permission denied. Please allow camera access in your browser settings.');
        } else if (permError.name === 'NotFoundError' || permError.name === 'DevicesNotFoundError') {
          setCameraPermissionError('No camera found. Please connect a camera and try again.');
        } else {
          setCameraPermissionError(`Camera error: ${permError.message}`);
        }
        setIsScanning(false);
        return;
      }

      const { Html5Qrcode } = await import('html5-qrcode');
      setIsScanning(true);
      
      const scanner = new Html5Qrcode('qr-reader');
      scannerRef.current = scanner;
      
      // Determine QR box size based on screen size (mobile-friendly)
      const isMobile = window.innerWidth < 768;
      const qrboxSize = isMobile ? Math.min(250, window.innerWidth - 40) : 250;
      
      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: qrboxSize, height: qrboxSize },
          aspectRatio: 1.0,
        },
        (decodedText) => {
          // Try to parse as pairing code or JSON
          try {
            const parsed = JSON.parse(decodedText);
            if (parsed.type === 'pocketbridge-pairing') {
              // Extract pairing code from QR data or use the data directly
              handlePair(parsed.code || decodedText);
            } else {
              // Try as pairing code directly
              handlePair(decodedText);
            }
          } catch {
            // Not JSON, try as pairing code
            handlePair(decodedText);
          }
          
          scanner.stop().then(() => {
            setIsScanning(false);
          }).catch(() => {
            setIsScanning(false);
          });
        },
        (errorMessage) => {
          // Ignore scanning errors (just keep scanning)
          // Only log if it's not a common "not found" error
          if (!errorMessage.includes('No QR code found')) {
            logger.debug('QR scanner error', { errorMessage });
          }
        }
      );
    } catch (error) {
      logger.error('Failed to start QR scanner', error);
      setIsScanning(false);
      if (error instanceof Error) {
        setCameraPermissionError(`Failed to start camera: ${error.message}`);
      }
    }
  };

  const stopQRScanner = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
      } catch (error) {
        // Ignore stop errors
      }
      scannerRef.current = null;
    }
    setIsScanning(false);
  };

  const handleCopyCode = async () => {
    if (myPairingCode) {
      await navigator.clipboard.writeText(myPairingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Debug: Log crypto state
  useEffect(() => {
    // Always log in both dev and prod to help debug pairing issues
    console.log('[PAIRING PAGE] Crypto state on mount/update:', {
      isInitialized,
      hasIdentityKeyPair: !!identityKeyPair,
      identityPublicKey: identityKeyPair?.publicKeyHex,
      hasError: !!cryptoError,
      errorMessage: cryptoError?.message,
    });

    // Check if there's a pending pairing code (indicates page was reloaded during pairing)
    const hasPendingCode = typeof window !== 'undefined' && !!sessionStorage.getItem('pending_pairing_code');
    if (hasPendingCode) {
      console.log('[PAIRING PAGE] Page reloaded with pending pairing code. Current identity:', {
        publicKey: identityKeyPair?.publicKeyHex,
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
        {/* Device Profile Section - Always Visible */}
        <Card>
          <CardHeader>
            <CardTitle>Device Profile</CardTitle>
            <CardDescription>
              Your device name and information. This will be shown to other devices when pairing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="device-profile-name">Device Name</Label>
              <div className="flex gap-2">
                <Input
                  id="device-profile-name"
                  type="text"
                  value={newDeviceName}
                  onChange={(e) => {
                    setNewDeviceName(e.target.value);
                    setDeviceNameError(null);
                  }}
                  onBlur={async () => {
                    if (newDeviceName && !deviceNameError) {
                      const isValid = validateDeviceNameBeforePair();
                      if (isValid) {
                        // Always save locally
                        const validatedName = validateDeviceName(newDeviceName);
                        updateDeviceName(validatedName);
                        setDeviceName(validatedName);
                        
                        // Update on backend if connected
                        if (isConnected && identityKeyPair) {
                          try {
                            const apiUrl = getBackendApiUrl();
                            const userId = identityKeyPair.publicKeyHex;
                            
                            const response = await fetch(`${apiUrl}/api/devices/${deviceId}/rename`, {
                              method: 'POST',
                              headers: {
                                'Content-Type': 'application/json',
                                'X-User-ID': userId,
                              },
                              body: JSON.stringify({ device_name: validatedName }),
                            });
                            
                            if (response.ok) {
                              logger.info('Device name updated on backend', { deviceId, name: validatedName });
                            } else {
                              logger.warn('Failed to update device name on backend', { status: response.status });
                            }
                          } catch (error) {
                            logger.error('Error updating device name on backend', error);
                            // Non-blocking: device name is saved locally
                          }
                        }
                      }
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Enter a name for this device"
                  className={`flex-1 ${deviceNameError ? 'border-red-500' : ''}`}
                  aria-invalid={!!deviceNameError}
                  aria-describedby={deviceNameError ? 'device-name-error' : undefined}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    if (!newDeviceName || deviceNameError) return;
                    const isValid = validateDeviceNameBeforePair();
                    if (!isValid) return;
                    
                    try {
                      const validatedName = validateDeviceName(newDeviceName);
                      // Always save locally
                      updateDeviceName(validatedName);
                      setDeviceName(validatedName);
                      setDeviceNameError(null);
                      
                      // Update on backend if connected
                      if (isConnected && identityKeyPair) {
                        const apiUrl = getBackendApiUrl();
                        const userId = identityKeyPair.publicKeyHex;
                        
                        if (!userId) {
                          logger.warn('Cannot update device name: user ID not available');
                          return;
                        }
                        
                        const response = await fetch(`${apiUrl}/api/devices/${deviceId}/rename`, {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            'X-User-ID': userId,
                          },
                          body: JSON.stringify({ device_name: validatedName }),
                        });
                        
                        if (response.ok) {
                          logger.info('Device name updated', { deviceId, name: validatedName });
                        } else {
                          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                          setDeviceNameError(errorData.error || 'Failed to update device name');
                        }
                      } else {
                        logger.info('Device name saved locally (will sync when connected)', { name: validatedName });
                      }
                    } catch (error) {
                      logger.error('Error updating device name', error);
                      if (error instanceof ValidationError) {
                        setDeviceNameError(error.message);
                      } else {
                        setDeviceNameError('Failed to update device name');
                      }
                    }
                  }}
                  disabled={!newDeviceName || !!deviceNameError}
                >
                  Save
                </Button>
              </div>
              {deviceNameError ? (
                <p id="device-name-error" className="text-xs text-red-600" role="alert">
                  {deviceNameError}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {isConnected 
                    ? 'Device name saved and synced to server'
                    : 'Device name saved locally. Will sync when connected.'}
                </p>
              )}
            </div>
            
            {/* Connection Status */}
            <div className="pt-2 border-t">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Connection Status:</span>
                <ConnectionStatusIndicator
                  status={connectionStatus}
                  isConnected={isConnected}
                  error={connectionError}
                  showDetails={true}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Mode Toggle */}
        <div className="flex gap-2 justify-center">
          <Button
            variant={mode === 'receive' ? 'default' : 'outline'}
            onClick={() => setMode('receive')}
            size="sm"
            aria-label="Switch to receive mode"
          >
            Receive
          </Button>
          <Button
            variant={mode === 'share' ? 'default' : 'outline'}
            onClick={() => setMode('share')}
            size="sm"
            aria-label="Switch to share mode"
          >
            Share
          </Button>
        </div>

        {mode === 'receive' && (
          <>
          {/* Connection Details */}
          <ConnectionDetailsCard
            deviceName={deviceName}
            wsUrl={wsUrl}
            connectionStatus={connectionStatus}
            isConnected={isConnected}
            connectionError={connectionError}
          />

          <Card>
          <CardHeader>
            <CardTitle>Enter Pairing Code</CardTitle>
            <CardDescription>
              Get the 6-digit code from the device you want to connect to
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">

            <div className="space-y-2">
              <Label htmlFor="pairing-code">Pairing Code</Label>
              <div className="flex items-center gap-2">
                <Input
                  ref={pairingCodeInputRef}
                  id="pairing-code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={pairingCode}
                  onChange={handleCodeChange}
                  onPaste={handlePaste}
                  placeholder="000000"
                  className="text-center text-3xl font-mono font-bold tracking-widest h-16"
                  aria-label="6-digit pairing code"
                  aria-describedby="pairing-code-help"
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <p id="pairing-code-help" className="text-xs text-muted-foreground">
                Enter the 6-digit code displayed on the other device (or paste it)
              </p>
            </div>

            <div className="space-y-2">
              <Button
                onClick={() => handlePair()}
                disabled={Boolean(!isInitialized || pairingCode.length !== 6 || isPairing || !!deviceNameError)}
                className="w-full"
                aria-label={pairingCode.length === 6 ? 'Pair device with entered code' : 'Enter 6-digit code to pair'}
              >
                {isPairing ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" aria-hidden="true"></div>
                    Pairing...
                  </>
                ) : (
                  <>
                    <KeyRound className="h-4 w-4 mr-2" aria-hidden="true" />
                    {pairingCode.length === 6 ? 'Pair Device' : 'Enter 6-digit Code'}
                  </>
                )}
              </Button>
              
              <Button
                onClick={isScanning ? stopQRScanner : startQRScanner}
                variant="outline"
                className="w-full"
                disabled={!isInitialized || isPairing}
                aria-label={isScanning ? 'Stop QR code scanner' : 'Start QR code scanner'}
              >
                <QrCode className="h-4 w-4 mr-2" aria-hidden="true" />
                {isScanning ? 'Stop Scanner' : 'Scan QR Code'}
              </Button>
            </div>
            
            {cameraPermissionError && (
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg" role="alert">
                <p className="text-sm text-yellow-800 font-medium">Camera Permission Required</p>
                <p className="text-xs text-yellow-700 mt-1">{cameraPermissionError}</p>
              </div>
            )}
            
            {isScanning && (
              <div className="space-y-2">
                <div id="qr-reader" className="w-full max-w-md mx-auto rounded-lg overflow-hidden border-2 border-primary"></div>
                <p className="text-xs text-center text-muted-foreground">
                  Point your camera at the QR code
                </p>
              </div>
            )}

            {/* Connection Progress Indicator */}
            {isPairing && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Connection Progress</CardTitle>
                </CardHeader>
                <CardContent>
                  <ConnectionProgress
                    step={pairingStep}
                    connectionStatus={connectionStatus}
                    error={connectionError}
                  />
                </CardContent>
              </Card>
            )}

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

            <ConnectionDetailsCard
              deviceName={deviceName}
              wsUrl={wsUrl}
              connectionStatus={connectionStatus}
              isConnected={isConnected}
              connectionError={connectionError}
            />

            <p className="text-sm text-muted-foreground text-center">
              This code includes your identity keypair. Keep it secure and only share with devices you trust.
            </p>
          </>
        )}
      </div>
    </MainLayout>
  );
}
