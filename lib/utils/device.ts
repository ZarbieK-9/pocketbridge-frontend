/**
 * Device detection and identification utilities
 */

import { STORAGE_KEYS } from "@/lib/constants"
import { generateUUIDv4 } from "./uuid"

export function getDeviceType(): "desktop" | "mobile" | "tablet" {
  if (typeof window === "undefined") return "desktop"

  const userAgent = window.navigator.userAgent.toLowerCase()
  const isMobile = /iphone|ipod|android|blackberry|windows phone/i.test(userAgent)
  const isTablet = /ipad|android(?!.*mobile)|tablet/i.test(userAgent)

  if (isTablet) return "tablet"
  if (isMobile) return "mobile"
  return "desktop"
}

export function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return generateUUIDv4()

  let deviceId = localStorage.getItem(STORAGE_KEYS.DEVICE_ID)
  if (!deviceId) {
    deviceId = generateUUIDv4() // Use UUIDv4 for device IDs (backend requirement)
    localStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId)
    console.log('[Device] 🆕 Generated NEW device ID (Web):', deviceId)
  } else {
    // Validate existing device ID is UUIDv4 format
    // If it's UUIDv7 (from old code), regenerate it
    const uuidv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidv4Regex.test(deviceId)) {
      console.warn('[Device] Existing device ID is not UUIDv4 format, regenerating...', { oldDeviceId: deviceId });
      deviceId = generateUUIDv4();
      localStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
      console.log('[Device] 🆕 Regenerated device ID (Web):', deviceId)
    } else {
      console.log('[Device] ✅ Loaded EXISTING device ID (Web):', deviceId)
    }
  }
  return deviceId
}

export function getOrCreateDeviceName(): string {
  if (typeof window === "undefined") return "Unknown Device"

  let deviceName = localStorage.getItem(STORAGE_KEYS.DEVICE_NAME)
  if (!deviceName) {
    const type = getDeviceType()
    const timestamp = new Date().toLocaleDateString()
    deviceName = `${type.charAt(0).toUpperCase() + type.slice(1)} - ${timestamp}`
    localStorage.setItem(STORAGE_KEYS.DEVICE_NAME, deviceName)
  }
  return deviceName
}

export function updateDeviceName(name: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEYS.DEVICE_NAME, name)
  }
}

export function getDeviceRole(): 'sharer' | 'receiver' | null {
  if (typeof window === "undefined") return null
  const role = localStorage.getItem(STORAGE_KEYS.DEVICE_ROLE)
  return role as 'sharer' | 'receiver' | null
}

export function setDeviceRole(role: 'sharer' | 'receiver'): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEYS.DEVICE_ROLE, role)
  }
}

export function clearDeviceRole(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem(STORAGE_KEYS.DEVICE_ROLE)
  }
}
