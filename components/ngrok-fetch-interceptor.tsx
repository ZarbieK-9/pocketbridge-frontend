"use client"

/**
 * Client component that patches global fetch to add ngrok-skip-browser-warning header.
 * Must be rendered in the component tree to execute on the client side.
 */
import "@/lib/utils/fetch-interceptor"

export function NgrokFetchInterceptor() {
  return null;
}
