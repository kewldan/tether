import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "cn";
import {
  Download,
  FolderOpen,
  RefreshCw,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { AdbScan } from "@/features/onboarding/api";
import { CopyButton, IconTile, Steps } from "@/features/onboarding/parts";
import { describe } from "@/features/onboarding/SearchScreen";
import { Segmented } from "@/features/settings/Segmented";
import { os } from "@/lib/platform";

export const LICENSE_URL = "https://developer.android.com/studio/terms";

const INSTALL_COMMANDS = {
  macos: {
    label: "macOS",
    command: "brew install --cask android-platform-tools",
  },
  windows: { label: "Windows", command: "winget install Google.PlatformTools" },
  ubuntu: { label: "Ubuntu", command: "sudo apt install adb" },
  fedora: { label: "Fedora", command: "sudo dnf install android-tools" },
  arch: { label: "Arch", command: "sudo pacman -S android-tools" },
} as const;
type InstallOs = keyof typeof INSTALL_COMMANDS;

const ARCHIVE = {
  macos: "platform-tools-latest-darwin.zip",
  windows: "platform-tools-latest-windows.zip",
  linux: "platform-tools-latest-linux.zip",
} as const;

/** Step 2 when no adb was found: download it or install it yourself. */
export function NotFoundScreen({
  scan,
  installDir,
  returning,
  onDownload,
  onRetry,
  onChoosePath,
  choosing,
}: {
  scan: AdbScan | null;
  /** `<app data>/platform-tools`, if known. */
  installDir: string | null;
  /** Onboarding was finished before; hide the steps. */
  returning: boolean;
  onDownload: () => void;
  onRetry: () => void;
  onChoosePath: () => void;
  choosing: boolean;
}) {
  const { t } = useTranslation("onboarding");
  const [accepted, setAccepted] = useState(false);
  const [tab, setTab] = useState<InstallOs>(os === "linux" ? "ubuntu" : os);
  const checks = scan?.checks ?? [];
  const others = (Object.keys(INSTALL_COMMANDS) as InstallOs[])
    .filter((k) => k !== tab)
    .slice(0, 2);

  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-auto px-8 py-14">
      <div className="flex w-full max-w-[980px] flex-col gap-7">
        {!returning && <Steps current={2} />}
        <div className="flex items-start gap-4">
          <IconTile tone="warning" size={40}>
            <TriangleAlert className="size-5" />
          </IconTile>
          <div>
            <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.01em]">
              {t("missing.title")}
            </h1>
            <p className="text-secondary-foreground mt-1 text-[14px]">
              {t("missing.subtitle")}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 items-stretch gap-4">
          <div className="bg-card border-brand ring-brand flex flex-col gap-4 rounded-xl border p-6 ring-1">
            <div className="flex items-center justify-between">
              <IconTile tone="brand">
                <Download className="size-5" />
              </IconTile>
              <Badge variant="brand">{t("missing.recommended")}</Badge>
            </div>
            <div>
              <div className="text-[16px] font-semibold">
                {t("missing.download.title")}
              </div>
              <p className="text-secondary-foreground mt-1">
                {t("missing.download.before")}{" "}
                <span className="text-foreground font-mono">dl.google.com</span>
                {t("missing.download.after")}
              </p>
            </div>
            <dl className="text-small grid grid-cols-[90px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt className="text-muted-foreground">{t("missing.package")}</dt>
              <dd className="font-mono">{ARCHIVE[os]}</dd>
              <dt className="text-muted-foreground">{t("missing.version")}</dt>
              <dd className="font-mono">{t("missing.latest")}</dd>
              <dt className="text-muted-foreground">
                {t("missing.installsTo")}
              </dt>
              <dd className="truncate font-mono" title={installDir ?? ""}>
                {installDir ?? "…"}
              </dd>
            </dl>
            <label className="mt-auto flex cursor-pointer items-start gap-2.5">
              <Checkbox
                className="mt-0.5"
                checked={accepted}
                onCheckedChange={setAccepted}
              />
              <span>
                {t("missing.accept")}{" "}
                <button
                  type="button"
                  className="text-brand hover:underline"
                  onClick={(e) => {
                    e.preventDefault();
                    void openUrl(LICENSE_URL);
                  }}
                >
                  {t("missing.license")}
                </button>
              </span>
            </label>
            <Button size="lg" disabled={!accepted} onClick={onDownload}>
              {t("missing.download.button")}
            </Button>
          </div>

          <div className="bg-card flex flex-col gap-4 rounded-xl border p-6">
            <IconTile>
              <TerminalSquare className="size-5" />
            </IconTile>
            <div>
              <div className="text-[16px] font-semibold">
                {t("missing.manual.title")}
              </div>
              <p className="text-secondary-foreground mt-1">
                {t("missing.manual.text")}
              </p>
            </div>
            <Segmented
              label={t("missing.manual.os")}
              value={tab}
              onChange={setTab}
              className="flex w-full"
              itemClassName="flex-1"
              options={(Object.keys(INSTALL_COMMANDS) as InstallOs[]).map(
                (k) => ({ value: k, label: INSTALL_COMMANDS[k].label }),
              )}
            />
            <div className="bg-sidebar flex items-center gap-2 rounded-md border py-1.5 pr-1.5 pl-3 font-mono">
              <span className="text-muted-foreground">$</span>
              <span className="selectable min-w-0 flex-1 truncate">
                {INSTALL_COMMANDS[tab].command}
              </span>
              <CopyButton
                text={INSTALL_COMMANDS[tab].command}
                label={t("missing.manual.copy")}
                withText
              />
            </div>
            <div className="text-small text-muted-foreground">
              {others.map((k, i) => (
                <span key={k}>
                  {i > 0 && " · "}
                  {INSTALL_COMMANDS[k].label}:{" "}
                  <span className="font-mono">
                    {INSTALL_COMMANDS[k].command}
                  </span>
                </span>
              ))}
            </div>
            <div className="mt-auto flex gap-2">
              <Button
                variant="outline"
                size="lg"
                className="flex-1"
                onClick={onRetry}
              >
                <RefreshCw />
                {t("missing.checkAgain")}
              </Button>
              <Button
                variant="ghost"
                size="lg"
                onClick={onChoosePath}
                disabled={choosing}
              >
                <FolderOpen />
                {t("missing.choosePath")}
              </Button>
            </div>
          </div>
        </div>

        {checks.length > 0 && (
          <details className="bg-card group rounded-xl border px-4 py-3">
            <summary className="text-secondary-foreground cursor-pointer font-medium">
              {t("missing.whereWeLooked", { count: checks.length })}
            </summary>
            <ul className="text-small text-muted-foreground mt-2.5 font-mono leading-5">
              {checks.map((c) => {
                const { label, detail } = describe(c, t);
                return (
                  <li
                    key={`${c.kind}-${c.paths[0] ?? ""}`}
                    className={cn("truncate")}
                  >
                    {label} · {detail || "—"} ·{" "}
                    {t(`search.status.${c.status}`).toLowerCase()}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
