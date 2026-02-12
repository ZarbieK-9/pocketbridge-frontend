"use client";

import { useEffect, useRef } from "react";
import { useWebSocket } from "@/hooks/use-websocket";
import { getOrCreateDeviceId, getDeviceRole } from "@/lib/utils/device";
import { getWsUrl } from "@/lib/utils/storage";
import { useCrypto } from "@/hooks/use-crypto";
import { toast } from "@/components/ui/toast";

export function DeviceConnectionNotice() {
  const { isInitialized } = useCrypto();
  const deviceId = getOrCreateDeviceId();
  const wsUrl = getWsUrl();
  const { lastSystemMessage } = useWebSocket({
    url: wsUrl || "",
    deviceId,
    autoConnect: isInitialized,
  });
  const handledKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!lastSystemMessage || lastSystemMessage.type !== "device_status_changed") return;
    if (lastSystemMessage.device_id === deviceId) return;
    if (!lastSystemMessage.is_online) return;

    const timestamp = lastSystemMessage.timestamp || Date.now();
    const dedupeKey = `${lastSystemMessage.device_id}:${timestamp}`;
    if (handledKeysRef.current.has(dedupeKey)) return;
    handledKeysRef.current.add(dedupeKey);

    const deviceName = lastSystemMessage.device_name || "New device";
    const role = getDeviceRole();

    if (role === "sharer") {
      toast(`${deviceName} connected. Refreshing...`, "info", 2500);
      setTimeout(() => {
        window.location.reload();
      }, 1200);
    } else {
      toast(`${deviceName} connected.`, "success", 3000);
    }
  }, [lastSystemMessage, deviceId]);

  return null;
}
