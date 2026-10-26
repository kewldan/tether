import { Channel, invoke } from "@tauri-apps/api/core";

/** What `sideload_inspect` found in a local OTA zip. */
export interface OtaPackage {
  path: string;
  name: string;
  sizeBytes: number;
  /** Has OTA metadata or an updater (false for an arbitrary zip). */
  isOta: boolean;
  /** A/B payload (`payload.bin`). */
  ab: boolean;
  otaType: string | null;
  /** Device codenames it installs on (`pre-device`). */
  devices: string[];
  postBuild: string | null;
  postRelease: string | null;
  postBuildId: string | null;
  postSdk: number | null;
  postSecurityPatch: string | null;
  /** Incremental packages only apply over this fingerprint. */
  preBuild: string | null;
  wipe: boolean;
  downgrade: boolean;
  /** The signature footer recovery verifies is present. */
  signed: boolean;
}

export type SideloadMode = "host" | "legacy";

export type SideloadEvent = {
  type: "progress";
  mode: SideloadMode;
  transferred: number;
  size: number;
  /** adb's estimate 0..100 (`sideload-host` sends the package ~2.1×). */
  percent: number;
};

export interface SideloadResult {
  mode: SideloadMode;
  elapsedMs: number;
}

export const inspectOta = (path: string) =>
  invoke<OtaPackage>("sideload_inspect", { path });

export function startSideload(
  serial: string,
  path: string,
  onEvent: (event: SideloadEvent) => void,
) {
  const channel = new Channel<SideloadEvent>();
  channel.onmessage = onEvent;
  return invoke<SideloadResult>("sideload_start", {
    serial,
    path,
    onEvent: channel,
  });
}

export const cancelSideload = (serial: string) =>
  invoke<void>("sideload_cancel", { serial });
