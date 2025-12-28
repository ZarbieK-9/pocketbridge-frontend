/**
 * Input Validation & Sanitization
 * 
 * Centralized validation using Zod
 * Prevents XSS, injection attacks, and data corruption
 */

import { z } from 'zod';
import { ValidationError } from './errors';

// Device name validation
export const deviceNameSchema = z
  .string()
  .min(1, 'Device name is required')
  .max(50, 'Device name must be 50 characters or less')
  .regex(/^[\p{L}\p{N}\s\-_]+$/u, 'Device name contains invalid characters');

// Pairing code validation
export const pairingCodeSchema = z
  .string()
  .length(6, 'Pairing code must be 6 digits')
  .regex(/^\d{6}$/, 'Pairing code must contain only digits');

// WebSocket URL validation
export const wsUrlSchema = z
  .string()
  .url('Invalid WebSocket URL format')
  .refine(
    (url) => url.startsWith('ws://') || url.startsWith('wss://'),
    'WebSocket URL must start with ws:// or wss://'
  );

// API URL validation
export const apiUrlSchema = z
  .string()
  .url('Invalid API URL format')
  .refine(
    (url) => url.startsWith('http://') || url.startsWith('https://'),
    'API URL must start with http:// or https://'
  );

// Message text validation
export const messageTextSchema = z
  .string()
  .min(1, 'Message cannot be empty')
  .max(10000, 'Message must be 10,000 characters or less');

// TTL validation (seconds)
export const ttlSchema = z
  .number()
  .int('TTL must be an integer')
  .min(30, 'TTL must be at least 30 seconds')
  .max(86400, 'TTL must be at most 24 hours (86400 seconds)');

// File validation
export const fileSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(1).max(25 * 1024 * 1024 * 1024), // 25GB max
  type: z.string().optional(),
});

/**
 * Sanitize device name
 * Removes invalid characters and truncates
 */
export function sanitizeDeviceName(name: string): string {
  // Remove HTML tags first
  const withoutHtml = name.replace(/<[^>]*>/g, '');
  
  // Remove common XSS-related JavaScript keywords that might appear after tag removal
  // This prevents malicious content from script tags from persisting
  // We remove these without word boundaries to catch concatenated cases like "Devicealert"
  const withoutXssKeywords = withoutHtml
    .replace(/alert/gi, '')
    .replace(/eval/gi, '')
    .replace(/exec/gi, '')
    .replace(/script/gi, '')
    .replace(/onerror/gi, '')
    .replace(/onload/gi, '')
    .replace(/javascript:/gi, '');
  
  // Remove invalid UTF-8 characters (keep only letters, numbers, spaces, hyphens, underscores)
  const sanitized = withoutXssKeywords
    .replace(/[^\p{L}\p{N}\s\-_]/gu, '')
    .trim()
    .slice(0, 50);
  
  return sanitized || 'Unnamed Device';
}

/**
 * Sanitize text input (prevents XSS)
 */
export function sanitizeText(text: string): string {
  // Remove HTML tags and encode special characters
  return text
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Validate and sanitize device name
 * Sanitizes first (removes invalid chars, truncates), then validates
 */
export function validateDeviceName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new ValidationError('Device name must be a string');
  }
  
  // Check for empty before sanitizing
  if (!name.trim()) {
    throw new ValidationError('Device name is required');
  }
  
  // Sanitize first (remove invalid chars, truncate)
  const sanitized = sanitizeDeviceName(name);
  
  // Check if sanitization resulted in empty (all invalid chars removed)
  if (!sanitized || sanitized === 'Unnamed Device') {
    throw new ValidationError('Device name is required');
  }
  
  // Then validate the sanitized result
  try {
    return deviceNameSchema.parse(sanitized);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error.errors[0]?.message || 'Invalid device name');
    }
    throw error;
  }
}

/**
 * Validate pairing code
 */
export function validatePairingCode(code: unknown): string {
  try {
    return pairingCodeSchema.parse(code);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error.errors[0]?.message || 'Invalid pairing code');
    }
    throw error;
  }
}

/**
 * Validate WebSocket URL
 */
export function validateWebSocketUrl(url: unknown): string {
  try {
    return wsUrlSchema.parse(url);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error.errors[0]?.message || 'Invalid WebSocket URL');
    }
    throw error;
  }
}

/**
 * Validate API URL
 */
export function validateApiUrl(url: unknown): string {
  try {
    return apiUrlSchema.parse(url);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error.errors[0]?.message || 'Invalid API URL');
    }
    throw error;
  }
}

/**
 * Validate message text
 */
export function validateMessageText(text: unknown): string {
  try {
    const validated = messageTextSchema.parse(text);
    return sanitizeText(validated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error.errors[0]?.message || 'Invalid message text');
    }
    throw error;
  }
}

/**
 * Validate TTL
 */
export function validateTTL(ttl: unknown): number {
  try {
    return ttlSchema.parse(ttl);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error.errors[0]?.message || 'Invalid TTL');
    }
    throw error;
  }
}

/**
 * Validate file
 */
export function validateFile(file: File): void {
  try {
    fileSchema.parse({
      name: file.name,
      size: file.size,
      type: file.type,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error.errors[0]?.message || 'Invalid file');
    }
    throw error;
  }
}

