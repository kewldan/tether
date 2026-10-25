import { useCallback, useEffect } from "react";

import { AppShell } from "@/app/shell/AppShell";
import { Titlebar } from "@/app/shell/Titlebar";
import { useDeviceTracking } from "@/features/devices/useDeviceTracking";
import { AdbMissing } from "@/features/onboarding/AdbMissing";
import { useAdb } from "@/lib/adb";
import { locateAdb } from "@/lib/tauri";
import { useApplyTheme } from "@/lib/theme";

export function App() {
  useApplyTheme();
  const adb = useAdb((s) => s.adb);
  const setAdb = useAdb((s) => s.setAdb);

  const search = useCallback(() => {
    setAdb({ status: "searching" });
    locateAdb()
      .then((install) =>
        setAdb(install ? { status: "found", install } : { status: "missing" }),
      )
      .catch(() => setAdb({ status: "missing" }));
  }, [setAdb]);

  useEffect(search, [search]);
  useDeviceTracking(adb.status === "found");

  if (adb.status === "found") return <AppShell />;

  return (
    <div className="flex h-full flex-col">
      <Titlebar />
      <div className="min-h-0 flex-1 overflow-auto px-6">
        {adb.status === "missing" && (
          <AdbMissing
            onRetry={search}
            onInstalled={(install) => setAdb({ status: "found", install })}
          />
        )}
      </div>
    </div>
  );
}
