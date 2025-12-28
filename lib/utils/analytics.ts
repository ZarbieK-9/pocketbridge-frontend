/**
 * Analytics & Monitoring
 * 
 * Custom event tracking and Web Vitals monitoring
 */

import { logger } from './logger';

interface AnalyticsEvent {
  name: string;
  properties?: Record<string, unknown>;
  timestamp?: number;
}

class Analytics {
  private events: AnalyticsEvent[] = [];
  private isEnabled = typeof window !== 'undefined';

  /**
   * Track custom event
   */
  track(eventName: string, properties?: Record<string, unknown>): void {
    if (!this.isEnabled) return;

    const event: AnalyticsEvent = {
      name: eventName,
      properties,
      timestamp: Date.now(),
    };

    this.events.push(event);

    // Send to Vercel Analytics if available
    if (typeof window !== 'undefined' && (window as any).va) {
      (window as any).va('track', eventName, properties);
    }

    // Log in development
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Analytics event', { eventName, properties });
    }
  }

  /**
   * Track page view
   */
  page(name: string, properties?: Record<string, unknown>): void {
    this.track('page_view', {
      page_name: name,
      ...properties,
    });
  }

  /**
   * Track feature usage
   */
  feature(featureName: string, action: string, properties?: Record<string, unknown>): void {
    this.track('feature_usage', {
      feature: featureName,
      action,
      ...properties,
    });
  }

  /**
   * Track error
   */
  error(error: Error, context?: Record<string, unknown>): void {
    this.track('error', {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack,
      ...context,
    });
  }

  /**
   * Track performance metric
   */
  performance(metricName: string, value: number, unit: string = 'ms'): void {
    this.track('performance', {
      metric: metricName,
      value,
      unit,
    });
  }
}

export const analytics = new Analytics();

/**
 * Web Vitals tracking
 */
export function reportWebVitals(metric: {
  name: string;
  value: number;
  id: string;
  delta: number;
}) {
  analytics.performance(metric.name, metric.value);

  // Send to Vercel Analytics
  if (typeof window !== 'undefined' && (window as any).va) {
    (window as any).va('web-vitals', metric);
  }
}

/**
 * Track user flow
 */
export function trackUserFlow(step: string, properties?: Record<string, unknown>): void {
  analytics.track('user_flow', {
    step,
    ...properties,
  });
}

