import type { DiagnosticsReport } from "@/features/diagnostics/api";
import type { AdbInstall } from "@/lib/tauri";

/**
 * Plain-text report for "Copy a diagnostic report". English on purpose:
 * it is pasted into issues.
 */
export function formatReport(
  report: DiagnosticsReport,
  adb: AdbInstall | null,
  appVersion: string | null,
): string {
  const f = report.facts;
  const lines = [
    "Tether diagnostic report",
    `Generated: ${new Date(report.checkedAt).toISOString()}`,
    `Tether: ${appVersion ?? "unknown"} · OS: ${f.os} · ${navigator.userAgent}`,
    "",
    "## adb",
    `Binary: ${adb?.path ?? f.adbPath ?? "not found"} (${adb?.source ?? "?"})`,
    `platform-tools: ${f.adbVersion ?? "?"} · client protocol ${f.clientVersion ?? "?"}`,
    `Server: ${f.serverVersion != null ? `running, protocol ${f.serverVersion}` : `down (${f.serverError ?? "?"})`} on :${f.serverPort}`,
    `Server process: pid ${f.process.pid ?? "?"}, ${f.process.binary ?? "unknown binary"}, up ${f.process.uptimeSecs ?? "?"} s, started by Tether: ${f.startedByUs}`,
    `Server drops in the last minute: ${f.serverDrops}`,
    `mDNS: ${f.mdns ?? "unavailable"}`,
    ...(f.udevRules !== null ? [`udev rules present: ${f.udevRules}`] : []),
    "",
    "## Checks",
    ...report.checks.map(
      (c) =>
        `[${c.status.toUpperCase()}] ${c.id}/${c.variant}${
          Object.keys(c.params).length
            ? ` ${Object.entries(c.params)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ")}`
            : ""
        }`,
    ),
    "",
    "## Devices (adb)",
    ...(f.devices.length
      ? f.devices.map(
          (d) =>
            `${d.serial} · ${d.state.kind === "unknown" ? d.state.raw : d.state.kind} · ${d.transport} · ${d.model ?? "?"}`,
        )
      : ["none"]),
    "",
    "## USB (host)",
    ...(f.usb === null || !f.usb.supported
      ? ["not checked on this OS"]
      : f.usb.devices.length
        ? f.usb.devices.map((u) =>
            `${hex(u.vendorId)}:${hex(u.productId)} ${u.manufacturer ?? ""} ${u.product ?? ""} serial=${u.serial ?? "-"} ${u.location ?? ""} ${u.speed ?? ""}`.replace(
              /\s+/g,
              " ",
            ),
          )
        : ["no USB devices"]),
  ];
  if (f.serverLog.length) lines.push("", "## Server log", ...f.serverLog);
  return lines.join("\n");
}

export const hex = (n: number) => n.toString(16).padStart(4, "0");
