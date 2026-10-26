import {
  Camera,
  Check,
  ChevronDown,
  Gauge,
  type LucideIcon,
  Plus,
  Settings2,
  SlidersHorizontal,
  Type,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { DevKey, DevSettings } from "@/features/device-settings/api";
import {
  capitalize,
  changesFrom,
  type DevProfile,
  describeChange,
  describeProfile,
  isApplied,
  PROFILE_KEYS,
  type ProfileIcon,
  profileName,
  useProfiles,
} from "@/features/device-settings/profiles";
import { cn } from "@/lib/utils";

const SKIP_BY_DEFAULT: DevKey[] = [
  "screenSize",
  "density",
  "wifi",
  "mobileData",
  "airplane",
];

const ICONS: Record<ProfileIcon, LucideIcon> = {
  camera: Camera,
  gauge: Gauge,
  type: Type,
  sliders: SlidersHorizontal,
};

const ICON_TONE: Record<ProfileIcon, string> = {
  camera: "text-chart-4",
  gauge: "text-chart-1",
  type: "text-chart-3",
  sliders: "text-secondary-foreground",
};

/** 32 px tile with the profile's icon; brand-tinted while applied. */
export function ProfileTile({
  profile,
  applied,
}: {
  profile: DevProfile;
  applied: boolean;
}) {
  const Icon = ICONS[profile.icon] ?? SlidersHorizontal;
  return (
    <span
      className={cn(
        "flex size-8 flex-none items-center justify-center rounded-lg",
        applied
          ? "bg-brand/15 text-brand"
          : cn("bg-selected", ICON_TONE[profile.icon]),
      )}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

/** "Profiles ▾" in the Device settings header (DevSettings board). */
export function ProfilesMenu({
  settings,
  disabled,
  onApply,
  onSave,
  onManage,
}: {
  settings: DevSettings | undefined;
  disabled: boolean;
  onApply: (profile: DevProfile) => void;
  onSave: () => void;
  onManage: () => void;
}) {
  const { t } = useTranslation("device-settings");
  const profiles = useProfiles((s) => s.profiles);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" />}
        disabled={disabled}
      >
        {t("profiles.menu")}
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {profiles.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("profiles.applyLabel")}</DropdownMenuLabel>
            {profiles.map((p) => {
              const applied = isApplied(p, settings);
              return (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => onApply(p)}
                  className="items-start gap-2.5 py-1.5"
                >
                  <ProfileTile profile={p} applied={applied} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {profileName(p, t)}
                    </span>
                    <span className="text-caption text-muted-foreground line-clamp-2">
                      {describeProfile(p, t)}
                    </span>
                  </span>
                  {applied && <Check className="text-brand mt-1" aria-hidden />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        )}
        {profiles.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onSave}>
          <Plus />
          {t("profiles.saveCurrent")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onManage}>
          <Settings2 />
          {t("profiles.manage")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Save current as profile…": name plus the settings to include. */
export function SaveProfileDialog({
  open,
  settings,
  suggested,
  onClose,
}: {
  open: boolean;
  settings: DevSettings | undefined;
  /** Pre-checked keys (the ones changed on this device). */
  suggested: DevKey[];
  onClose: () => void;
}) {
  const { t } = useTranslation("device-settings");
  const add = useProfiles((s) => s.add);
  const [name, setName] = useState("");
  const [keys, setKeys] = useState<DevKey[]>([]);

  const available = settings
    ? PROFILE_KEYS.filter(
        (k) => settings[k] !== null || k === "screenSize" || k === "density",
      )
    : [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only
  useEffect(() => {
    if (!open) return;
    setName("");
    // Nothing changed yet: offer the display and overlay toggles, not
    // connectivity or screen size.
    setKeys(
      suggested.length > 0
        ? suggested
        : available.filter((k) => !SKIP_BY_DEFAULT.includes(k)),
    );
  }, [open]);

  const save = () => {
    if (!settings || !name.trim() || keys.length === 0) return;
    add(name.trim(), changesFrom(settings, keys));
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("profiles.saveTitle")}</DialogTitle>
          <DialogDescription>{t("profiles.saveText")}</DialogDescription>
        </DialogHeader>
        <form
          id="save-profile"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            autoFocus
            aria-label={t("profiles.name")}
            placeholder={t("profiles.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <fieldset className="bg-sidebar flex max-h-64 flex-col overflow-auto rounded-md border py-1">
            <legend className="sr-only">{t("profiles.include")}</legend>
            {settings &&
              available.map((key) => {
                const [change] = changesFrom(settings, [key]);
                return (
                  // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders the control
                  <label
                    key={key}
                    className="hover:bg-accent h-row flex items-center gap-2.5 px-2.5"
                  >
                    <Checkbox
                      checked={keys.includes(key)}
                      onCheckedChange={(on) =>
                        setKeys((prev) =>
                          on ? [...prev, key] : prev.filter((k) => k !== key),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {change ? capitalize(describeChange(change, t)) : key}
                    </span>
                    {suggested.includes(key) && (
                      <span className="text-caption text-warning">
                        {t("changed")}
                      </span>
                    )}
                  </label>
                );
              })}
          </fieldset>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="submit"
            form="save-profile"
            disabled={!name.trim() || keys.length === 0}
          >
            {t("profiles.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameProfileDialog({
  profile,
  onClose,
}: {
  profile: DevProfile | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("device-settings");
  const rename = useProfiles((s) => s.rename);
  const [name, setName] = useState("");
  useEffect(() => {
    if (profile) setName(profileName(profile, t));
  }, [profile, t]);
  const save = () => {
    if (profile && name.trim()) rename(profile.id, name.trim());
    onClose();
  };
  return (
    <Dialog open={profile !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("profiles.renameTitle")}</DialogTitle>
        </DialogHeader>
        <form
          id="rename-profile"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            autoFocus
            aria-label={t("profiles.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" form="rename-profile" disabled={!name.trim()}>
            {t("profiles.rename")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
