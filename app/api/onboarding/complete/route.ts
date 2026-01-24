import { NextRequest, NextResponse } from 'next/server';
import { 
  buildSetCookieHeader, 
  COOKIE_CONFIG,
  extractUserContext,
} from '@/lib/auth';

// POST /api/onboarding/complete
// Marks onboarding as complete by setting an HttpOnly cookie
// Requires X-User-ID header (minimal auth - can be called during onboarding)
export async function POST(req: NextRequest) {
  try {
    // Extract user ID - this is the minimal auth requirement
    const userId = req.headers.get('x-user-id');
    
    if (!userId || userId.length === 0) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'X-User-ID header is required' },
        { status: 401 }
      );
    }

    // Get user context for audit trail
    const userContext = extractUserContext(req);
    
    // Validate request content type if body is present
    const contentType = req.headers.get('content-type');
    const hasBody = req.headers.get('content-length') !== '0';
    
    if (hasBody && contentType && !contentType.includes('application/json')) {
      return NextResponse.json(
        { error: 'Invalid content type' },
        { status: 400 }
      );
    }

    // Build the Set-Cookie header with secure defaults
    const setCookieHeader = buildSetCookieHeader(
      COOKIE_CONFIG.ONBOARDING_COMPLETED,
      'true',
      COOKIE_CONFIG.DEFAULT_OPTIONS
    );

    const res = NextResponse.json({ 
      ok: true,
      timestamp: new Date().toISOString(),
      userId: userId,
    });
    
    res.headers.set('Set-Cookie', setCookieHeader);
    
    // Add security headers
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.headers.set('X-Content-Type-Options', 'nosniff');
    res.headers.set('X-Frame-Options', 'DENY');
    
    return res;
  } catch (err) {
    console.error('Onboarding completion error:', err);
    return NextResponse.json(
      { error: 'Internal error', message: 'Failed to complete onboarding' },
      { status: 500 }
    );
  }
}
