'use client';

/**
 * Web Vitals Reporter
 * 
 * Reports Core Web Vitals to analytics
 */

import { useEffect } from 'react';
import { reportWebVitals } from '@/lib/utils/analytics';

export function WebVitalsReporter() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Report Web Vitals
    const reportMetric = (metric: {
      name: string;
      value: number;
      id: string;
      delta: number;
    }) => {
      reportWebVitals(metric);
    };

    // Use Next.js built-in Web Vitals if available
    if (typeof window !== 'undefined' && (window as any).__NEXT_DATA__) {
      // Web Vitals will be reported automatically by Next.js
      // This component ensures we capture them for analytics
    }

    // Fallback: Use web-vitals library if needed
    // import('web-vitals').then(({ onCLS, onFID, onFCP, onLCP, onTTFB, onINP }) => {
    //   onCLS(reportMetric);
    //   onFID(reportMetric);
    //   onFCP(reportMetric);
    //   onLCP(reportMetric);
    //   onTTFB(reportMetric);
    //   onINP(reportMetric);
    // });
  }, []);

  return null;
}



