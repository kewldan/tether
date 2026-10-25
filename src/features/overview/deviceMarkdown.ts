import type { TFunction } from "i18next";

import type { DeviceSnapshot } from "@/features/overview/api";
import { gigabytes } from "@/features/overview/format";
import type { Device } from "@/lib/tauri";

/** "Copy device info": a Markdown table to paste into bug reports. */
export function deviceMarkdown(
  device: Device,
  name: string,
  s: DeviceSnapshot,
  t: TFunction,
): string {
  const m = (key: string) => t(`markdown.${key}`, { ns: "overview" });
  const info = s.info;
  const d = s.display;
  const size = d.overrideSize ?? d.physicalSize;
  const rows: [string, string | null | undefined][] = [
    [m("manufacturer"), info.manufacturer],
    [m("model"), info.model],
    [m("serial"), `\`${device.serial}\``],
    [
      m("android"),
      info.androidVersion &&
        `${info.androidVersion}${info.sdk ? ` (SDK ${info.sdk})` : ""}`,
    ],
    [m("patch"), info.securityPatch],
    [
      m("build"),
      [s.build.buildId, s.build.buildType].filter(Boolean).join(" · ") || null,
    ],
    [m("fingerprint"), info.fingerprint && `\`${info.fingerprint}\``],
    [m("soc"), s.build.soc],
    [m("abi"), info.abi],
    [
      m("display"),
      size &&
        `${size.width}×${size.height} @ ${d.overrideDensity ?? d.physicalDensity ?? "?"} dpi${
          d.refreshRate ? `, ${Math.round(d.refreshRate)} Hz` : ""
        }`,
    ],
    [m("memory"), s.memory && `${gigabytes(s.memory.totalBytes)} GB`],
    [
      m("storage"),
      s.storage &&
        `${gigabytes(s.storage.usedBytes)} / ${gigabytes(s.storage.totalBytes)} GB`,
    ],
    [m("battery"), s.battery?.level != null ? `${s.battery.level}%` : null],
    [m("root"), t(`root.${s.root}`, { ns: "overview" })],
    [m("transport"), t(`transport.${device.transport}`, { ns: "common" })],
  ];
  const cell = (v: string) => v.replace(/\|/g, "\\|");
  const lines = rows
    .filter((r): r is [string, string] => Boolean(r[1]))
    .map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`);
  return [`### ${name}`, "", "| | |", "|---|---|", ...lines, ""].join("\n");
}
