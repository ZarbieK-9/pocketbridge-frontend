/**
 * Structured Logging Utility
 * 
 * Replaces console.log/error/warn with structured logging
 * In production, logs are sent to error reporting service
 * In development, logs are pretty-printed
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development';
  private isProduction = process.env.NODE_ENV === 'production';

  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${contextStr}`;
  }

  private shouldLog(level: LogLevel): boolean {
    // In production, only log warn and error
    if (this.isProduction) {
      return level === 'warn' || level === 'error';
    }
    // In development, log everything
    return true;
  }

  debug(message: string, context?: LogContext): void {
    if (!this.shouldLog('debug')) return;
    if (this.isDevelopment) {
      console.debug(this.formatMessage('debug', message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (!this.shouldLog('info')) return;
    if (this.isDevelopment) {
      console.info(this.formatMessage('info', message, context));
    } else {
      // In production, send to analytics/monitoring
      this.sendToMonitoring('info', message, context);
    }
  }

  warn(message: string, context?: LogContext): void {
    if (!this.shouldLog('warn')) return;
    console.warn(this.formatMessage('warn', message, context));
    if (this.isProduction) {
      this.sendToMonitoring('warn', message, context);
    }
  }

  error(message: string, error?: Error | unknown, context?: LogContext): void {
    if (!this.shouldLog('error')) return;
    
    const errorContext: LogContext = {
      ...context,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : String(error),
    };

    console.error(this.formatMessage('error', message, errorContext));
    
    if (this.isProduction) {
      this.sendToMonitoring('error', message, errorContext);
      this.reportError(error, context);
    }
  }

  private sendToMonitoring(level: LogLevel, message: string, context?: LogContext): void {
    // In production, send to monitoring service (e.g., Vercel Analytics, custom endpoint)
    // For now, structured logging is sufficient
    // TODO: Integrate with monitoring service
  }

  private reportError(error: Error | unknown, context?: LogContext): void {
    // Report to error tracking service (Sentry, LogRocket, etc.)
    // TODO: Integrate with error reporting service
    // Example: Sentry.captureException(error, { extra: context });
  }
}

export const logger = new Logger();

