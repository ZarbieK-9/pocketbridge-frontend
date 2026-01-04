/**
 * Custom Error Classes
 * 
 * Provides structured error handling
 */

export class PocketBridgeError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode: number = 500,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PocketBridgeError';
    Object.setPrototypeOf(this, PocketBridgeError.prototype);
  }
}

export class ValidationError extends PocketBridgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, context);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class NetworkError extends PocketBridgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'NETWORK_ERROR', 0, context);
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

export class CryptoError extends PocketBridgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CRYPTO_ERROR', 500, context);
    this.name = 'CryptoError';
    Object.setPrototypeOf(this, CryptoError.prototype);
  }
}



