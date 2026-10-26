import { Monitor, Moon, PanelLeft, Sun, SunMoon, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useNavigation } from "@/app/navigation";
import { SECTION_IDS, SECTIONS } from "@/app/sections";
import { deviceTone, StatusDot } from "@/components/status/StatusDot";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useConnectSheet } from "@/features/devices/sheetStore";
import { useDevices } from "@/features/devices/store";
import { useSettings } from "@/lib/settings";
import { type ShortcutId, ShortcutKbd } from "@/lib/shortcuts";
import type { Device } from "@/lib/tauri";

/** Palette entries that also have a shortcut show its current keys. */
const NAV_SHORTCUTS: Partial<Record<string, ShortcutId>> = {
  devices: "devices",
  settings: "settings",
};

function Hint({ id, digit }: { id: ShortcutId; digit?: number }) {
  return (
    <CommandShortcut className="tracking-normal">
      <ShortcutKbd id={id} digit={digit} />
    </CommandShortcut>
  );
}

/** ⌘K / Ctrl+K palette: navigation, devices and preferences. */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigation((s) => s.navigate);
  const devices = useDevices((s) => s.devices);
  const select = useDevices((s) => s.select);
  const setTheme = useSettings((s) => s.setTheme);
  const toggleSidebar = useSettings((s) => s.toggleSidebar);

  const run = (action: () => void) => () => {
    action();
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("titlebar.openPalette")}
      className="sm:max-w-[640px]"
    >
      <Command>
        <CommandInput placeholder={t("palette.placeholder")} />
        <CommandList>
          <CommandEmpty>{t("palette.empty")}</CommandEmpty>
          <CommandGroup heading={t("palette.navigation")}>
            {SECTION_IDS.map((id) => {
              const Icon = SECTIONS[id].icon;
              return (
                <CommandItem
                  key={id}
                  value={`nav ${id} ${t(`nav.${id}`)}`}
                  onSelect={run(() => navigate(id))}
                >
                  <Icon />
                  {t(`nav.${id}`)}
                  {NAV_SHORTCUTS[id] && <Hint id={NAV_SHORTCUTS[id]} />}
                </CommandItem>
              );
            })}
          </CommandGroup>
          {devices.length > 0 && (
            <CommandGroup heading={t("palette.devices")}>
              {devices.map((d, i) => (
                <DeviceCommand
                  key={d.serial}
                  device={d}
                  index={i}
                  onSelect={run(() => select(d.serial))}
                />
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading={t("palette.preferences")}>
            <CommandItem
              onSelect={run(() => useConnectSheet.getState().show())}
            >
              <Wifi />
              {t("palette.connectWifi")}
              <Hint id="wifi" />
            </CommandItem>
            <CommandItem onSelect={run(toggleSidebar)}>
              <PanelLeft />
              {t("palette.toggleSidebar")}
              <Hint id="sidebar" />
            </CommandItem>
            <CommandItem
              onSelect={run(() =>
                setTheme(
                  document.documentElement.classList.contains("dark")
                    ? "light"
                    : "dark",
                ),
              )}
            >
              <SunMoon />
              {t("palette.toggleTheme")}
              <Hint id="theme" />
            </CommandItem>
            <CommandItem onSelect={run(() => setTheme("dark"))}>
              <Moon />
              {t("palette.themeDark")}
            </CommandItem>
            <CommandItem onSelect={run(() => setTheme("light"))}>
              <Sun />
              {t("palette.themeLight")}
            </CommandItem>
            <CommandItem onSelect={run(() => setTheme("system"))}>
              <Monitor />
              {t("palette.themeSystem")}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/** One device row; resolves the display name (alias, AVD, model) like the switcher. */
function DeviceCommand({
  device,
  index,
  onSelect,
}: {
  device: Device;
  index: number;
  onSelect: () => void;
}) {
  const { data: info } = useDeviceInfo(
    device.state.kind === "device" ? device.serial : null,
  );
  const name = deviceName(device, info);
  return (
    <CommandItem value={`device ${device.serial} ${name}`} onSelect={onSelect}>
      <StatusDot tone={deviceTone(device.state)} />
      {name}
      <span className="text-caption text-muted-foreground ml-auto font-mono">
        {device.serial}
      </span>
      {index < 9 && <Hint id="switch" digit={index + 1} />}
    </CommandItem>
  );
}
