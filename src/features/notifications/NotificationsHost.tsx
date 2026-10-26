import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { startSystemNotifications } from "./notify";
import { useCrashNotifications } from "./useCrashNotifications";
import { useDeviceNotifications } from "./useDeviceNotifications";
import { useTray } from "./useTray";

/**
 * Background notices and the tray icon: device connected / disconnected,
 * app crashes from the Logcat stream, tray menu sync. Mount once.
 */
export function NotificationsHost() {
  const queryClient = useQueryClient();
  useTray(queryClient);
  useDeviceNotifications(queryClient);
  useCrashNotifications();
  useEffect(() => startSystemNotifications(), []);
  return null;
}
