/**
 * Validation Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import {
  validateDeviceName,
  validatePairingCode,
  validateWebSocketUrl,
  validateApiUrl,
  validateMessageText,
  validateTTL,
  validateFile,
  sanitizeDeviceName,
  sanitizeText,
} from '@/lib/utils/validation';
import { ValidationError } from '@/lib/utils/errors';

describe('Validation Utilities', () => {
  describe('validateDeviceName', () => {
    it('should validate valid device names', () => {
      expect(validateDeviceName('My Device')).toBe('My Device');
      expect(validateDeviceName('Device-123')).toBe('Device-123');
      expect(validateDeviceName('Device_Test')).toBe('Device_Test');
    });

    it('should sanitize invalid characters', () => {
      const result = validateDeviceName('Device<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('alert');
    });

    it('should throw ValidationError for empty name', () => {
      expect(() => validateDeviceName('')).toThrow(ValidationError);
    });

    it('should truncate names longer than 50 characters', () => {
      const longName = 'A'.repeat(100);
      const result = validateDeviceName(longName);
      expect(result.length).toBeLessThanOrEqual(50);
    });
  });

  describe('validatePairingCode', () => {
    it('should validate 6-digit codes', () => {
      expect(validatePairingCode('123456')).toBe('123456');
    });

    it('should throw for non-6-digit codes', () => {
      expect(() => validatePairingCode('12345')).toThrow(ValidationError);
      expect(() => validatePairingCode('1234567')).toThrow(ValidationError);
    });

    it('should throw for non-numeric codes', () => {
      expect(() => validatePairingCode('abcdef')).toThrow(ValidationError);
    });
  });

  describe('validateWebSocketUrl', () => {
    it('should validate ws:// URLs', () => {
      expect(validateWebSocketUrl('ws://localhost:3001/ws')).toBe('ws://localhost:3001/ws');
    });

    it('should validate wss:// URLs', () => {
      expect(validateWebSocketUrl('wss://example.com/ws')).toBe('wss://example.com/ws');
    });

    it('should throw for invalid URLs', () => {
      expect(() => validateWebSocketUrl('http://example.com')).toThrow(ValidationError);
      expect(() => validateWebSocketUrl('not-a-url')).toThrow(ValidationError);
    });
  });

  describe('validateMessageText', () => {
    it('should validate and sanitize message text', () => {
      const result = validateMessageText('Hello world');
      expect(result).toBe('Hello world');
    });

    it('should remove HTML tags', () => {
      const result = validateMessageText('<script>alert("xss")</script>Hello');
      expect(result).not.toContain('<script>');
      expect(result).toContain('Hello');
    });

    it('should throw for empty messages', () => {
      expect(() => validateMessageText('')).toThrow(ValidationError);
    });

    it('should throw for messages longer than 10000 characters', () => {
      const longMessage = 'A'.repeat(10001);
      expect(() => validateMessageText(longMessage)).toThrow(ValidationError);
    });
  });

  describe('validateTTL', () => {
    it('should validate TTL values', () => {
      expect(validateTTL(30)).toBe(30);
      expect(validateTTL(3600)).toBe(3600);
      expect(validateTTL(86400)).toBe(86400);
    });

    it('should throw for TTL less than 30', () => {
      expect(() => validateTTL(29)).toThrow(ValidationError);
    });

    it('should throw for TTL greater than 86400', () => {
      expect(() => validateTTL(86401)).toThrow(ValidationError);
    });
  });

  describe('validateFile', () => {
    it('should validate valid files', () => {
      const file = new File(['content'], 'test.txt', { type: 'text/plain' });
      expect(() => validateFile(file)).not.toThrow();
    });

    it('should throw for files larger than 25GB', () => {
      const largeFile = new File(['content'], 'large.bin');
      Object.defineProperty(largeFile, 'size', { value: 26 * 1024 * 1024 * 1024 });
      expect(() => validateFile(largeFile)).toThrow(ValidationError);
    });
  });

  describe('sanitizeText', () => {
    it('should remove HTML tags', () => {
      expect(sanitizeText('<p>Hello</p>')).toBe('Hello');
      expect(sanitizeText('<script>alert("xss")</script>')).not.toContain('<script>');
    });

    it('should encode special characters', () => {
      expect(sanitizeText('Hello & World')).toContain('&amp;');
      expect(sanitizeText('Hello < World')).toContain('&lt;');
    });
  });
});



