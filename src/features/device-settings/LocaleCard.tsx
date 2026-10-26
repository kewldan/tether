import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, Globe, Languages, RotateCcw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useApps } from "@/features/apps/queries";
import {
  appLocales,
  type DevSettings,
  deviceLocales,
  setAppLocales,
} from "@/features/device-settings/api";
import { useOriginals } from "@/features/device-settings/originals";
import type { AppError } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Offered for per-app languages when the device can't list its own. */
const COMMON_LOCALES = [
  "en-US",
  "en-GB",
  "de-DE",
  "fr-FR",
  "es-ES",
  "es-419",
  "it-IT",
  "pt-BR",
  "ru-RU",
  "uk-UA",
  "pl-PL",
  "tr-TR",
  "ar-EG",
  "he-IL",
  "hi-IN",
  "ja-JP",
  "ko-KR",
  "zh-CN",
  "zh-TW",
  // Pseudo-locales: long accented strings and right-to-left layout.
  "en-XA",
  "ar-XB",
];

const TAG_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

function errorText(error: unknown) {
  return (error as Partial<AppError>)?.message ?? String(error);
}

/** Display name of a BCP 47 tag in the UI language, e.g. "French (France)". */
export function useLocaleName() {
  const { i18n } = useTranslation();
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([i18n.language], { type: "language" });
    } catch {
      names = null;
    }
    return (tag: string) => {
      try {
        return names?.of(tag) ?? tag;
      } catch {
        return tag;
      }
    };
  }, [i18n.language]);
}

export function LocaleCard({
  serial,
  settings,
  busy,
  modified,
  onApplySystem,
}: {
  serial: string;
  settings: DevSettings;
  busy: boolean;
  modified: boolean;
  onApplySystem: (tag: string) => void;
}) {
  const { t } = useTranslation("device-settings");
  const { data: available } = useQuery({
    queryKey: ["device-locales", serial],
    queryFn: () => deviceLocales(serial),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const locales = available && available.length > 0 ? available : null;

  return (
    <div className="bg-card flex flex-col rounded-lg border">
      <Row
        icon={Globe}
        title={t("locale.system")}
        hint={
          settings.localeSettable
            ? t("locale.systemHint")
            : t("locale.systemReadOnly")
        }
        modified={modified}
        badge={<ScopeBadge>{t("locale.scopeSystem")}</ScopeBadge>}
      >
        {settings.localeSettable ? (
          <LocalePicker
            label={t("locale.system")}
            value={settings.locale}
            locales={locales ?? COMMON_LOCALES}
            disabled={busy}
            onPick={(tag) => {
              if (tag !== settings.locale) onApplySystem(tag);
            }}
          />
        ) : (
          <Badge className="font-mono">{settings.locale ?? "—"}</Badge>
        )}
      </Row>
      <AppLocaleRow
        serial={serial}
        locales={locales ?? COMMON_LOCALES}
        busy={busy}
      />
    </div>
  );
}

function ScopeBadge({ children }: { children: ReactNode }) {
  return <Badge className="h-4 px-[5px] text-[10px]">{children}</Badge>;
}

function Row({
  icon: Icon,
  title,
  hint,
  modified,
  badge,
  children,
  className,
}: {
  icon: typeof Globe;
  title: string;
  hint: string;
  modified: boolean;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation("device-settings");
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-2.5 gap-y-2 px-4 py-3.5",
        className,
      )}
    >
      <Icon
        className="text-muted-foreground mt-0.5 size-4 flex-none"
        aria-hidden
      />
      <div className="min-w-[180px] flex-1">
        <div className="flex flex-wrap items-center gap-1.5 font-semibold">
          {title}
          {badge}
          {modified && (
            <Badge variant="warning" className="h-4 px-[5px] text-[10px]">
              {t("changed")}
            </Badge>
          )}
        </div>
        <div className="text-muted-foreground text-small mt-0.5">{hint}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function AppLocaleRow({
  serial,
  locales,
  busy,
}: {
  serial: string;
  locales: string[];
  busy: boolean;
}) {
  const { t } = useTranslation("device-settings");
  const queryClient = useQueryClient();
  const [pkg, setPkg] = useState<string | null>(null);
  const key = ["app-locales", serial, pkg];
  const original = useOriginals((s) =>
    pkg ? s.appLocales[serial]?.[pkg] : undefined,
  );
  const remember = useOriginals((s) => s.rememberAppLocales);
  const forget = useOriginals((s) => s.forgetAppLocales);

  const { data: current, error } = useQuery({
    queryKey: key,
    queryFn: () => (pkg ? appLocales(serial, pkg) : Promise.reject()),
    enabled: pkg !== null,
  });

  const mutation = useMutation({
    mutationFn: (tags: string[]) =>
      pkg ? setAppLocales(serial, pkg, tags) : Promise.reject(),
    onMutate: () => {
      if (pkg && current) remember(serial, pkg, current);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      const stored = pkg
        ? useOriginals.getState().appLocales[serial]?.[pkg]
        : undefined;
      if (pkg && stored && stored.join(",") === next.join(",")) {
        forget(serial, pkg);
      }
    },
    onError: (e) =>
      toast.error(t("applyFailed"), { description: errorText(e) }),
  });

  const value = current?.[0] ?? null;
  const modified =
    original !== undefined &&
    current !== undefined &&
    original.join(",") !== current.join(",");

  return (
    <Row
      icon={Languages}
      title={t("locale.app")}
      hint={error ? errorText(error) : t("locale.appHint")}
      modified={modified}
      badge={<ScopeBadge>{t("locale.scopeApp")}</ScopeBadge>}
      className="border-t"
    >
      <AppPicker
        serial={serial}
        value={pkg}
        disabled={busy || mutation.isPending}
        onPick={setPkg}
      />
      <LocalePicker
        label={t("locale.app")}
        value={value}
        placeholder={t("locale.systemDefault")}
        locales={locales}
        disabled={busy || mutation.isPending || !pkg || current === undefined}
        onPick={(tag) => mutation.mutate([tag])}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("locale.useSystem")}
        title={t("locale.useSystem")}
        disabled={
          busy || mutation.isPending || !current || current.length === 0
        }
        onClick={() => mutation.mutate([])}
      >
        <RotateCcw />
      </Button>
    </Row>
  );
}

function LocalePicker({
  label,
  value,
  placeholder,
  locales,
  disabled,
  onPick,
}: {
  label: string;
  value: string | null;
  placeholder?: string;
  locales: string[];
  disabled?: boolean;
  onPick: (tag: string) => void;
}) {
  const { t } = useTranslation("device-settings");
  const name = useLocaleName();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const items = useMemo(
    () =>
      locales
        .map((tag) => ({ tag, name: name(tag) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [locales, name],
  );
  const custom =
    TAG_RE.test(search.trim()) && !locales.includes(search.trim())
      ? search.trim()
      : null;
  const pick = (tag: string) => {
    onPick(tag);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={label}
            disabled={disabled}
            className="w-[200px] justify-between"
          />
        }
      >
        <span className="truncate">
          {value ? name(value) : (placeholder ?? "—")}
        </span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <Command>
          <CommandInput
            placeholder={t("locale.search")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>{t("locale.none")}</CommandEmpty>
            {custom && (
              <CommandItem
                value={`custom ${custom}`}
                onSelect={() => pick(custom)}
              >
                {t("locale.custom", { tag: custom })}
              </CommandItem>
            )}
            {items.map((item) => (
              <CommandItem
                key={item.tag}
                value={`${item.name} ${item.tag}`}
                onSelect={() => pick(item.tag)}
                data-checked={item.tag === value || undefined}
              >
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="text-muted-foreground text-caption font-mono">
                  {item.tag}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AppPicker({
  serial,
  value,
  disabled,
  onPick,
}: {
  serial: string;
  value: string | null;
  disabled?: boolean;
  onPick: (pkg: string) => void;
}) {
  const { t } = useTranslation("device-settings");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data, isLoading } = useApps(open || value ? serial : null);
  const apps = data ?? [];
  const user = apps.filter((a) => !a.system && !a.overlay);
  const system = apps.filter((a) => a.system && !a.overlay && a.launcher);
  const pick = (pkg: string) => {
    onPick(pkg);
    setOpen(false);
    setSearch("");
  };
  const list = (items: typeof apps) =>
    items.map((a) => (
      <CommandItem
        key={a.package}
        value={a.package}
        onSelect={() => pick(a.package)}
        className="text-small font-mono"
      >
        {a.package}
      </CommandItem>
    ));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={t("locale.pickApp")}
            disabled={disabled}
            className="w-[220px] justify-between"
          />
        }
      >
        <span className={cn("truncate", value && "font-mono")}>
          {value ?? t("locale.pickApp")}
        </span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command>
          <CommandInput
            placeholder={t("locale.searchApps")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {isLoading ? t("locale.loadingApps") : t("locale.noApps")}
            </CommandEmpty>
            {user.length > 0 && (
              <CommandGroup heading={t("locale.userApps")}>
                {list(user)}
              </CommandGroup>
            )}
            {system.length > 0 && (
              <CommandGroup heading={t("locale.systemApps")}>
                {list(system)}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const EMPTY_ORIGINALS: Record<string, string[]> = {};

/**
 * Per-app languages Tether changed on a device, for the "changed" count
 * and "Restore all original values".
 */
export function useAppLocaleOriginals(serial: string | null) {
  return useOriginals((s) =>
    serial ? (s.appLocales[serial] ?? EMPTY_ORIGINALS) : EMPTY_ORIGINALS,
  );
}
