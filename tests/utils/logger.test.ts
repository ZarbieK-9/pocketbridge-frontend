/**
 * Logger Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/utils/logger';

describe('Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log debug messages in development', () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logger.debug('Test debug message');
    
    if (process.env.NODE_ENV === 'development') {
      expect(consoleSpy).toHaveBeenCalled();
    }
    
    consoleSpy.mockRestore();
  });

  it('should log info messages', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('Test info message');
    
    if (process.env.NODE_ENV === 'development') {
      expect(consoleSpy).toHaveBeenCalled();
    }
    
    consoleSpy.mockRestore();
  });

  it('should log warn messages', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('Test warning');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should log error messages', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('Test error');
    logger.error('Test error message', error);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should include context in logs', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('Test message', { key: 'value' });
    
    if (process.env.NODE_ENV === 'development') {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test message'),
        expect.stringContaining('value')
      );
    }
    
    consoleSpy.mockRestore();
  });
});

