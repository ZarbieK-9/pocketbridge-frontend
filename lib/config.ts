/**
 * Configuration Management
 * 
 * Validates and provides type-safe configuration
 * Environment-specific settings
 */

import { z } from 'zod';
import { validateWebSocketUrl, validateApiUrl } from './utils/validation';
import { ValidationError } from './utils/errors';

// Environment schema
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NEXT_PUBLIC_WS_URL: z.string().optional(),
  NEXT_PUBLIC_API_URL: z.string().optional(),
});

// Configuration interface
export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  wsUrl: string;
  apiUrl: string;
  isDevelopment: boolean;
  isProduction: boolean;
}

/**
 * Get and validate environment variables
 */
function getEnv(): z.infer<typeof envSchema> {
  try {
    return envSchema.parse({
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        `Invalid environment configuration: ${error.errors[0]?.message}`,
        { errors: error.errors }
      );
    }
    throw error;
  }
}

/**
 * Derive API URL from WebSocket URL
 */
function deriveApiUrlFromWs(wsUrl: string): string {
  if (wsUrl.startsWith('ws://')) {
    return wsUrl.replace('ws://', 'http://').replace('/ws', '');
  } else if (wsUrl.startsWith('wss://')) {
    return wsUrl.replace('wss://', 'https://').replace('/ws', '');
  }
  throw new ValidationError('Invalid WebSocket URL format');
}

/**
 * Get default WebSocket URL based on environment
 */
function getDefaultWsUrl(): string {
  if (typeof window !== 'undefined') {
    // Try to get from localStorage (set via pairing)
    const stored = localStorage.getItem('pocketbridge_ws_url');
    if (stored) {
      return stored;
    }
  }
  
  // Default based on environment
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv === 'production') {
    // Production default (should be overridden by env var)
    return 'wss://backend-production-7f7ab.up.railway.app/ws';
  }
  
  // Development default
  return 'ws://localhost:3001/ws';
}

/**
 * Get default API URL based on environment
 */
function getDefaultApiUrl(): string {
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv === 'production') {
    return 'https://backend-production-7f7ab.up.railway.app';
  }
  return 'http://localhost:3001';
}

/**
 * Create configuration object
 */
function createConfig(): Config {
  const env = getEnv();
  const nodeEnv = env.NODE_ENV;

  // Get WebSocket URL
  let wsUrl: string;
  if (env.NEXT_PUBLIC_WS_URL) {
    try {
      wsUrl = validateWebSocketUrl(env.NEXT_PUBLIC_WS_URL);
    } catch (error) {
      console.error('[Config] Invalid NEXT_PUBLIC_WS_URL, using default:', error);
      wsUrl = getDefaultWsUrl();
    }
  } else {
    wsUrl = getDefaultWsUrl();
  }

  // Get API URL
  let apiUrl: string;
  if (env.NEXT_PUBLIC_API_URL) {
    try {
      apiUrl = validateApiUrl(env.NEXT_PUBLIC_API_URL);
    } catch (error) {
      console.error('[Config] Invalid NEXT_PUBLIC_API_URL, deriving from WS URL:', error);
      apiUrl = deriveApiUrlFromWs(wsUrl);
    }
  } else {
    // Derive from WebSocket URL
    try {
      apiUrl = deriveApiUrlFromWs(wsUrl);
    } catch {
      apiUrl = getDefaultApiUrl();
    }
  }

  return {
    nodeEnv,
    wsUrl,
    apiUrl,
    isDevelopment: nodeEnv === 'development',
    isProduction: nodeEnv === 'production',
  };
}

// Export singleton config
export const config = createConfig();

/**
 * Feature Flags
 */
export interface FeatureFlags {
  enableAnalytics: boolean;
  enablePerformanceMonitoring: boolean;
  enableErrorReporting: boolean;
  enableAdvancedFeatures: boolean;
}

/**
 * Get feature flags
 */
export function getFeatureFlags(): FeatureFlags {
  return {
    enableAnalytics: process.env.NEXT_PUBLIC_ENABLE_ANALYTICS !== 'false',
    enablePerformanceMonitoring: process.env.NEXT_PUBLIC_ENABLE_PERFORMANCE !== 'false',
    enableErrorReporting: process.env.NEXT_PUBLIC_ENABLE_ERROR_REPORTING !== 'false',
    enableAdvancedFeatures: process.env.NEXT_PUBLIC_ENABLE_ADVANCED_FEATURES === 'true',
  };
}

/**
 * Check if feature is enabled
 */
export function isFeatureEnabled(feature: keyof FeatureFlags): boolean {
  const flags = getFeatureFlags();
  return flags[feature];
}

// Validate config on module load
if (config.isProduction) {
  // In production, ensure URLs are secure
  if (!config.wsUrl.startsWith('wss://')) {
    console.warn('[Config] WARNING: Using non-secure WebSocket URL in production:', config.wsUrl);
  }
  if (!config.apiUrl.startsWith('https://')) {
    console.warn('[Config] WARNING: Using non-secure API URL in production:', config.apiUrl);
  }
}

