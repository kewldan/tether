import type { OtaPackage } from "@/features/sideload/api";
import type { BatteryReading } from "@/features/sideload/store";
import type { Device } from "@/lib/tauri";

/** Below this the update must not start (recovery itself wants 20%). */
export const BATTERY_MIN = 20;
/** At or above this the battery is "enough". */
export const BATTERY_OK = 30;

export interface Check {
  id: string;
  tone: "success" | "warning" | "error";
  /** An error that keeps "Install" disabled. */
  blocking: boolean;
  /** i18n key in the `sideload` namespace and its values. */
  key: string;
  values?: Record<string, string | number>;
}

/** Device codename as the OTA's `pre-device` names it. */
export function codename(device: Device): string | null {
  return device.device ?? device.product ?? null;
}

/** Safety checks shown before a sideload, most important first. */
export function sideloadChecks(
  device: Device,
  pkg: OtaPackage | null,
  battery: BatteryReading | null,
): Check[] {
  const checks: Check[] = [];
  const add = (c: Omit<Check, "blocking"> & { blocking?: boolean }) =>
    checks.push({ blocking: false, ...c });

  add(
    device.state.kind === "sideload"
      ? { id: "state", tone: "success", key: "checks.stateOk" }
      : {
          id: "state",
          tone: "error",
          blocking: true,
          key: "checks.stateWrong",
          values: { state: device.state.kind },
        },
  );

  if (!battery) {
    add({ id: "battery", tone: "warning", key: "checks.batteryUnknown" });
  } else if (battery.level < BATTERY_MIN) {
    add({
      id: "battery",
      tone: "error",
      blocking: true,
      key: "checks.batteryLow",
      values: { level: battery.level, min: BATTERY_MIN },
    });
  } else if (battery.level < BATTERY_OK) {
    add({
      id: "battery",
      tone: "warning",
      key: "checks.batteryMeh",
      values: { level: battery.level },
    });
  } else {
    add({
      id: "battery",
      tone: "success",
      key: "checks.batteryOk",
      values: { level: battery.level },
    });
  }

  if (!pkg) return checks;

  if (!pkg.isOta) {
    add({ id: "ota", tone: "error", blocking: true, key: "checks.notOta" });
    return checks;
  }
  add({
    id: "ota",
    tone: "success",
    key: pkg.ab ? "checks.otaAb" : "checks.otaBlock",
  });

  const name = codename(device);
  if (pkg.devices.length === 0) {
    add({ id: "target", tone: "warning", key: "checks.targetUnknown" });
  } else if (!name) {
    add({
      id: "target",
      tone: "warning",
      key: "checks.targetUnverified",
      values: { devices: pkg.devices.join(", ") },
    });
  } else if (pkg.devices.includes(name)) {
    add({
      id: "target",
      tone: "success",
      key: "checks.targetOk",
      values: { device: name },
    });
  } else {
    add({
      id: "target",
      tone: "error",
      blocking: true,
      key: "checks.targetWrong",
      values: { devices: pkg.devices.join(", "), device: name },
    });
  }

  add(
    pkg.signed
      ? { id: "signature", tone: "success", key: "checks.signed" }
      : { id: "signature", tone: "warning", key: "checks.unsigned" },
  );
  if (pkg.preBuild) {
    const build = pkg.preBuild.split("/")[3] ?? pkg.preBuild;
    add({
      id: "incremental",
      tone: "warning",
      key: "checks.incremental",
      values: { build },
    });
  }
  if (pkg.wipe) add({ id: "wipe", tone: "warning", key: "checks.wipe" });
  if (pkg.downgrade)
    add({ id: "downgrade", tone: "warning", key: "checks.downgrade" });
  return checks;
}
