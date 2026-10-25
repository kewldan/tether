import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "cn";
import { Minus, Moon, Search, Square, Sun, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Logo } from "@/components/layout/Logo";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { isMac, modKey } from "@/lib/platform";
import { useSettings } from "@/lib/settings";
import { useResolvedTheme } from "@/lib/theme";

/**
 * 40 px custom titlebar. On macOS the native traffic lights sit in the
 * left inset (titleBarStyle "Overlay"); on Windows and Linux the window is
 * undecorated and we draw our own controls on the right.
 */
export function Titlebar({ onOpenPalette }: { onOpenPalette?: () => void }) {
  const { t } = useTranslation();
  const theme = useResolvedTheme();
  const setTheme = useSettings((s) => s.setTheme);

  return (
    <div
      data-tauri-drag-region
      className="bg-sidebar flex h-10 flex-none items-center gap-3 border-b"
      style={{ paddingLeft: isMac ? 86 : 14 }}
    >
      <div
        data-tauri-drag-region
        className="text-body flex w-[150px] flex-none items-center gap-2 font-semibold"
      >
        <Logo />
        {t("appName")}
      </div>

      {onOpenPalette ? (
        <button
          type="button"
          aria-label={t("titlebar.openPalette")}
          onClick={onOpenPalette}
          className="bg-background text-muted-foreground hover:border-input text-small focus-visible:outline-ring mx-auto flex h-7 min-w-0 flex-[0_1_440px] items-center gap-2 rounded-[7px] border pr-1.5 pl-2.5 text-left outline-none focus-visible:outline-2"
        >
          <Search className="size-3.5 flex-none" aria-hidden />
          <span className="truncate">{t("titlebar.search")}</span>
          <span className="ml-auto flex gap-[3px]">
            <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      ) : (
        <div data-tauri-drag-region className="flex-1" />
      )}

      <div
        data-tauri-drag-region
        className="flex min-w-[150px] flex-none items-center justify-end gap-0.5"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("titlebar.theme")}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className={isMac ? "mr-2" : undefined}
        >
          {theme === "dark" ? <Moon /> : <Sun />}
        </Button>
        {!isMac && <WindowControls />}
      </div>
    </div>
  );
}

function WindowControls() {
  const { t } = useTranslation();
  const controls = [
    {
      label: t("titlebar.minimize"),
      icon: Minus,
      run: () => getCurrentWindow().minimize(),
    },
    {
      label: t("titlebar.maximize"),
      icon: Square,
      run: () => getCurrentWindow().toggleMaximize(),
    },
    {
      label: t("titlebar.close"),
      icon: X,
      run: () => getCurrentWindow().close(),
      danger: true,
    },
  ];
  return (
    <div className="flex">
      {controls.map(({ label, icon: Icon, run, danger }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          onClick={() => void run()}
          // `cn`, not string `+`: concatenation fused the last class with
          // the hover classes into one invalid class.
          className={cn(
            "text-secondary-foreground focus-visible:bg-accent flex h-10 w-[46px] items-center justify-center outline-none",
            danger
              ? "hover:bg-destructive hover:text-destructive-foreground"
              : "hover:bg-accent hover:text-foreground",
          )}
        >
          <Icon
            className={Icon === Square ? "size-3.5" : "size-4"}
            aria-hidden
          />
        </button>
      ))}
    </div>
  );
}
