import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import { useAdb } from "@/lib/adb";
import { os } from "@/lib/platform";
import { useSettings } from "@/lib/settings";
import type { AdbInstall } from "@/lib/tauri";

export interface PlatformToolsLatest {
  /** Newest stable platform-tools, e.g. `37.0.1`. */
  latest: string;
  /** Active adb as `adb version` prints it (`37.0.0-12345`). */
  current: string | null;
  updateAvailable: boolean;
}

/** Null when offline or the manifest couldn't be read. */
export const platformToolsLatest = (force = false) =>
  invoke<PlatformToolsLatest | null>("platform_tools_latest", { force });

/**
 * "New platform-tools available" for the active adb. The backend checks
 * Google's manifest at most daily; here it's asked once per session and
 * again when the active adb changes.
 */
export function usePlatformToolsUpdate() {
  const adb = useAdb((s) => s.adb);
  const install = adb.status === "found" ? adb.install : null;
  const dismissed = useSettings((s) => s.platformToolsDismissed);
  const { data } = useQuery({
    queryKey: ["platform-tools-latest", install?.path, install?.version],
    queryFn: () => platformToolsLatest(),
    enabled: install !== null,
    staleTime: 6 * 60 * 60 * 1000,
    retry: false,
  });
  const available = !!data?.updateAvailable && install !== null;
  return {
    install,
    latest: data?.latest ?? null,
    available,
    /** Worth a dot on the settings gear: new and not dismissed. */
    unseen: available && dismissed !== data?.latest,
  };
}

export interface UpdateCommand {
  via: string;
  command: string;
}

export type UpdateHow =
  | { kind: "bundled" }
  | { kind: "commands"; commands: UpdateCommand[] }
  | { kind: "studio" }
  | { kind: "manual" };

const cmd = (via: string, command: string): UpdateHow => ({
  kind: "commands",
  commands: [{ via, command }],
});

/** How to update the adb at `install`, guessed from where it lives. */
export function updateHow(install: AdbInstall): UpdateHow {
  if (install.source === "bundled") return { kind: "bundled" };
  const path = install.path.replaceAll("\\", "/");
  const lower = path.toLowerCase();
  if (install.source === "android_home" || lower.includes("/android/sdk")) {
    return { kind: "studio" };
  }
  if (os === "macos") {
    if (path.startsWith("/opt/homebrew/") || path.startsWith("/usr/local/")) {
      return cmd("Homebrew", "brew upgrade --cask android-platform-tools");
    }
  } else if (os === "windows") {
    if (lower.includes("/winget/")) {
      return cmd("winget", "winget upgrade Google.PlatformTools");
    }
    if (lower.includes("/scoop/")) return cmd("Scoop", "scoop update adb");
  } else if (path.startsWith("/usr/bin/")) {
    // Distribution packages; they often trail Google's release.
    return {
      kind: "commands",
      commands: [
        { via: "apt", command: "sudo apt install --only-upgrade adb" },
        { via: "dnf", command: "sudo dnf upgrade android-tools" },
        { via: "pacman", command: "sudo pacman -Syu android-tools" },
      ],
    };
  }
  return { kind: "manual" };
}
