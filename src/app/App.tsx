import { useCallback, useEffect, useState } from "react";
import { Smartphone } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { DeviceCard } from "@/features/devices/DeviceCard";
import { useDevices } from "@/features/devices/useDevices";
import { AdbMissing } from "@/features/onboarding/AdbMissing";
import { type AdbInstall, locateAdb } from "@/lib/tauri";

type AdbStatus =
  | { status: "searching" }
  | { status: "missing" }
  | { status: "found"; install: AdbInstall };

export function App() {
  const [adb, setAdb] = useState<AdbStatus>({ status: "searching" });

  const search = useCallback(() => {
    setAdb({ status: "searching" });
    locateAdb()
      .then((install) =>
        setAdb(install ? { status: "found", install } : { status: "missing" }),
      )
      .catch(() => setAdb({ status: "missing" }));
  }, []);

  useEffect(search, [search]);

  return (
    <main className="bg-background text-foreground min-h-screen px-6">
      {adb.status === "missing" ? (
        <AdbMissing onRetry={search} />
      ) : (
        <DevicesView install={adb.status === "found" ? adb.install : null} />
      )}
    </main>
  );
}

function DevicesView({ install }: { install: AdbInstall | null }) {
  const { devices, error, loading } = useDevices(install !== null);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 py-8">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">Devices</h1>
        {install && (
          <span
            className="text-muted-foreground truncate font-mono text-xs"
            title={install.path}
          >
            adb {install.version ?? "unknown version"}
          </span>
        )}
      </header>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-lg px-4 py-3 text-sm">
          {error.message}
          {error.hint && (
            <span className="text-muted-foreground block">{error.hint}</span>
          )}
        </div>
      )}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      ) : devices.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 py-20 text-center text-sm">
          <Smartphone className="size-8" />
          <p>
            No devices yet. Connect a phone over USB with USB debugging
            enabled.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {devices.map((d) => (
            <DeviceCard key={d.serial} device={d} />
          ))}
        </div>
      )}
    </div>
  );
}
