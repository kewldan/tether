import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BatteryCharging,
  Hand,
  LayoutGrid,
  type LucideIcon,
  Moon,
  MousePointer2,
  Plane,
  RotateCcw,
  Signal,
  Smartphone,
  SunMedium,
  Type,
  Wand2,
  Wifi,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  applyDevSetting,
  type DevChange,
  type DevKey,
  type DevSettings,
  readDevSettings,
  setAppLocales,
} from "@/features/device-settings/api";
import {
  LocaleCard,
  useAppLocaleOriginals,
} from "@/features/device-settings/LocaleCard";
import {
  modifiedKeys,
  sameValue,
  useOriginals,
} from "@/features/device-settings/originals";
import {
  ProfilesMenu,
  SaveProfileDialog,
} from "@/features/device-settings/ProfileParts";
import { ProfilesView } from "@/features/device-settings/ProfilesView";
import { Segmented } from "@/features/device-settings/Segmented";
import { useProfileActions } from "@/features/device-settings/useProfileActions";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useSelectedDevice } from "@/features/devices/store";
import type { AppError } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const ANIMATION_SCALES = [0, 0.5, 1, 2, 5];
const FONT_SCALES = [0.85, 1, 1.15, 1.3, 2];
const PRESETS = [
  { name: "Pixel 4a", width: 1080, height: 2340, density: 440 },
  { name: "Galaxy A54", width: 1080, height: 2400, density: 420 },
  { name: "Small", width: 720, height: 1280, density: 320 },
  { name: "Tablet", width: 1600, height: 2560, density: 320 },
  { name: "Foldable inner", width: 2208, height: 1840, density: 420 },
];

const fmtScale = (v: number) =>
  Number.isInteger(v) ? v.toFixed(1) : String(v);

function errorText(error: unknown) {
  return (error as Partial<AppError>)?.message ?? String(error);
}

export default function DeviceSettingsPage() {
  const { t } = useTranslation("device-settings");
  const { t: tc } = useTranslation();
  const device = useSelectedDevice();
  const ready = device?.state.kind === "device";
  const serial = ready ? device.serial : null;
  const { data: info } = useDeviceInfo(serial);
  const queryClient = useQueryClient();
  const queryKey = ["dev-settings", serial];

  const { data: settings, error } = useQuery({
    queryKey,
    queryFn: () => (serial ? readDevSettings(serial) : Promise.reject()),
    enabled: serial !== null,
    refetchInterval: 15_000,
  });
  const originals = useOriginals((s) =>
    serial ? s.bySerial[serial] : undefined,
  );
  const remember = useOriginals((s) => s.remember);
  const forget = useOriginals((s) => s.forget);
  const modified = modifiedKeys(settings, originals);
  const appLocaleOriginals = useAppLocaleOriginals(serial);
  const changedApps = Object.keys(appLocaleOriginals);
  const changedCount = modified.length + changedApps.length;
  const forgetAppLocales = useOriginals((s) => s.forgetAppLocales);

  const mutation = useMutation({
    mutationFn: (change: DevChange) => {
      if (!serial) return Promise.reject();
      return applyDevSetting(serial, change);
    },
    onMutate: (change) => {
      if (serial && settings)
        remember(serial, change.key, settings[change.key]);
    },
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
    onError: (error) =>
      toast.error(t("applyFailed"), { description: errorText(error) }),
  });

  const apply = (change: DevChange) => mutation.mutate(change);
  const [confirmWifiOff, setConfirmWifiOff] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const view = useNavigation((s) => s.params.view);
  const navigate = useNavigation((s) => s.navigate);
  const profileActions = useProfileActions(
    serial,
    device?.transport ?? "usb",
    settings,
  );

  const revertAll = async () => {
    if (!serial || !settings) return;
    setReverting(true);
    let latest = settings;
    try {
      for (const [pkg, tags] of Object.entries(appLocaleOriginals)) {
        await setAppLocales(serial, pkg, tags);
        forgetAppLocales(serial, pkg);
        void queryClient.invalidateQueries({
          queryKey: ["app-locales", serial, pkg],
        });
      }
      for (const key of Object.keys(originals ?? {}) as DevKey[]) {
        const original = originals?.[key];
        if (sameValue(latest[key], original)) continue;
        const nullable = key === "screenSize" || key === "density";
        if (original === null && !nullable) continue;
        latest = await applyDevSetting(serial, {
          key,
          value: original,
        } as DevChange);
      }
      forget(serial);
      queryClient.setQueryData(queryKey, latest);
      toast.success(t("reverted"));
    } catch (error) {
      queryClient.setQueryData(queryKey, latest);
      toast.error(t("applyFailed"), { description: errorText(error) });
    } finally {
      setReverting(false);
    }
  };

  const busy = mutation.isPending || reverting || profileActions.busy !== null;
  const isMod = (key: DevKey) => modified.includes(key);
  const name = device ? deviceName(device, info) : "";

  const toggle = (key: DevKey & keyof DevSettings) => (checked: boolean) =>
    apply({ key, value: checked } as DevChange);

  if (view === "profiles" && device && serial) {
    return (
      <ProfilesView device={device} settings={settings} modified={modified} />
    );
  }

  return (
    <Page
      title={
        <span className="flex items-center gap-1.5">
          {tc("nav.device-settings")}
          {changedCount > 0 && (
            <Badge variant="warning" className="ml-1.5">
              {t("changedCount", { count: changedCount })}
            </Badge>
          )}
        </span>
      }
      parent={device ? { label: name } : undefined}
      actions={
        <>
          <ProfilesMenu
            settings={settings}
            disabled={!settings || busy}
            onApply={(profile) => void profileActions.apply(profile)}
            onSave={() => setSavingProfile(true)}
            onManage={() => navigate("device-settings", { view: "profiles" })}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={changedCount === 0 || busy}
            onClick={() => void revertAll()}
          >
            <RotateCcw />
            {t("revertAll")}
          </Button>
        </>
      }
      className="px-5 py-4"
    >
      {!serial ? (
        <p className="text-muted-foreground py-16 text-center">
          {t("noDevice")}
        </p>
      ) : error && !settings ? (
        <div className="bg-error/13 rounded-lg border px-4 py-3">
          <div className="font-semibold">{t("loadFailed")}</div>
          <div className="text-secondary-foreground text-small">
            {errorText(error)}
          </div>
        </div>
      ) : !settings ? (
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 9 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
            <Skeleton key={i} className="h-[92px] rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-[18px]">
          <Section label={t("sections.display")}>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              <ToggleCard
                icon={settings.darkTheme ? Moon : SunMedium}
                title={t("darkTheme.title")}
                hint="cmd uimode night"
                modified={isMod("darkTheme")}
                checked={settings.darkTheme}
                disabled={busy}
                onChange={toggle("darkTheme")}
              />
              <SettingCard
                icon={Wand2}
                title={t("animation.title")}
                hint={t("animation.hint")}
                modified={isMod("animationScale")}
              >
                <Segmented
                  stretch
                  label={t("animation.title")}
                  value={settings.animationScale}
                  disabled={busy}
                  options={ANIMATION_SCALES.map((v) => ({
                    value: v,
                    label: String(v),
                  }))}
                  onChange={(v) => apply({ key: "animationScale", value: v })}
                />
              </SettingCard>
              <SettingCard
                icon={Type}
                title={t("fontScale.title")}
                hint={t("fontScale.hint")}
                modified={isMod("fontScale")}
                aside={
                  <span className="font-semibold tabular-nums">
                    {settings.fontScale !== null &&
                      `${fmtScale(settings.fontScale)}×`}
                  </span>
                }
              >
                <Segmented
                  stretch
                  label={t("fontScale.title")}
                  value={
                    FONT_SCALES.find((v) => sameValue(v, settings.fontScale)) ??
                    null
                  }
                  disabled={busy}
                  options={FONT_SCALES.map((v) => ({
                    value: v,
                    label: fmtScale(v),
                  }))}
                  onChange={(v) => apply({ key: "fontScale", value: v })}
                />
              </SettingCard>
              <ScreenSizeCard
                settings={settings}
                modified={isMod("screenSize") || isMod("density")}
                disabled={busy}
                onApply={async (size, density) => {
                  if (
                    !sameValue(
                      size,
                      settings.screenSize ?? settings.physicalSize,
                    )
                  )
                    await mutation.mutateAsync({
                      key: "screenSize",
                      value: size,
                    });
                  if (
                    density !== (settings.density ?? settings.physicalDensity)
                  )
                    await mutation.mutateAsync({
                      key: "density",
                      value: density,
                    });
                }}
                onReset={async () => {
                  if (settings.screenSize)
                    await mutation.mutateAsync({
                      key: "screenSize",
                      value: null,
                    });
                  if (settings.density !== null)
                    await mutation.mutateAsync({ key: "density", value: null });
                }}
              />
              <ToggleCard
                icon={Smartphone}
                title={t("demo.title")}
                hint={t("demo.hint")}
                modified={isMod("demoMode")}
                checked={settings.demoMode}
                disabled={busy}
                onChange={toggle("demoMode")}
              >
                <div
                  aria-hidden
                  className="bg-sidebar flex h-[22px] items-center justify-between rounded-sm border px-2.5 text-[11px] font-semibold"
                >
                  <span>12:00</span>
                  <span className="flex items-center gap-1">
                    <span className="bg-secondary-foreground h-2 w-2.5 rounded-[1px]" />
                    <span className="border-secondary-foreground h-2 w-4 rounded-[2px] border p-px">
                      <span className="bg-secondary-foreground block h-full" />
                    </span>
                  </span>
                </div>
              </ToggleCard>
            </div>
          </Section>

          <Section label={t("sections.overlays")}>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              <ToggleCard
                icon={Hand}
                title={t("overlays.showTouches")}
                hint="show_touches"
                modified={isMod("showTouches")}
                checked={settings.showTouches}
                disabled={busy}
                onChange={toggle("showTouches")}
              />
              <ToggleCard
                icon={MousePointer2}
                title={t("overlays.pointerLocation")}
                hint="pointer_location"
                modified={isMod("pointerLocation")}
                checked={settings.pointerLocation}
                disabled={busy}
                onChange={toggle("pointerLocation")}
              />
              <ToggleCard
                icon={LayoutGrid}
                title={t("overlays.layoutBounds")}
                hint="debug.layout"
                modified={isMod("layoutBounds")}
                checked={settings.layoutBounds}
                disabled={busy}
                onChange={toggle("layoutBounds")}
              />
              <ToggleCard
                icon={Activity}
                title={t("overlays.gpuProfiling")}
                hint="debug.hwui.profile"
                modified={isMod("gpuProfiling")}
                checked={settings.gpuProfiling}
                disabled={busy}
                onChange={toggle("gpuProfiling")}
              />
              <ToggleCard
                icon={BatteryCharging}
                title={t("overlays.stayAwake")}
                hint="stay_on_while_plugged_in"
                modified={isMod("stayAwake")}
                checked={settings.stayAwake}
                disabled={busy}
                onChange={toggle("stayAwake")}
              />
            </div>
          </Section>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Section label={t("sections.locale")}>
              <LocaleCard
                serial={serial}
                settings={settings}
                busy={busy}
                modified={isMod("locale")}
                onApplySystem={(tag) => apply({ key: "locale", value: tag })}
              />
            </Section>
            <Section label={t("sections.connectivity")}>
              <div className="bg-card grid grid-cols-3 rounded-lg border">
                {(
                  [
                    ["wifi", Wifi],
                    ["mobileData", Signal],
                    ["airplane", Plane],
                  ] as const
                ).map(([key, Icon], i) => (
                  <div
                    key={key}
                    className={cn(
                      "flex min-w-0 items-center gap-2.5 px-4 py-3.5",
                      i < 2 && "border-r",
                    )}
                  >
                    <Icon
                      className="text-muted-foreground size-4 flex-none"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {t(`connectivity.${key}`)}
                    </span>
                    {isMod(key) && <ChangedBadge />}
                    <Switch
                      size="sm"
                      aria-label={t(`connectivity.${key}`)}
                      checked={settings[key] ?? false}
                      disabled={busy || settings[key] === null}
                      onCheckedChange={(checked) => {
                        if (
                          key === "wifi" &&
                          !checked &&
                          device?.transport === "wifi"
                        ) {
                          setConfirmWifiOff(true);
                          return;
                        }
                        apply({ key, value: checked });
                      }}
                    />
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground text-small mt-2">
                {t("connectivity.note")}
              </p>
            </Section>
          </div>
        </div>
      )}

      <SaveProfileDialog
        open={savingProfile}
        settings={settings}
        suggested={modified}
        onClose={() => setSavingProfile(false)}
      />
      <AlertDialog open={confirmWifiOff} onOpenChange={setConfirmWifiOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("wifiOff.title", { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("wifiOff.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmWifiOff(false);
                apply({ key: "wifi", value: false });
              }}
            >
              {t("wifiOff.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-caption text-muted-foreground mb-2 font-semibold tracking-[.05em] uppercase">
        {label}
      </h2>
      {children}
    </section>
  );
}

function ChangedBadge() {
  const { t } = useTranslation("device-settings");
  return (
    <Badge variant="warning" className="h-4 px-[5px] text-[10px]">
      {t("changed")}
    </Badge>
  );
}

function SettingCard({
  icon: Icon,
  title,
  hint,
  modified = false,
  aside,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  modified?: boolean;
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card flex min-w-0 flex-col gap-2.5 rounded-lg border px-4 py-3.5 transition-colors",
        modified && "border-warning",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className="text-muted-foreground mt-0.5 size-4 flex-none"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            {title}
            {modified && <ChangedBadge />}
          </div>
          {hint && (
            <div className="text-muted-foreground text-small mt-0.5">
              {hint}
            </div>
          )}
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

function ToggleCard({
  checked,
  onChange,
  disabled,
  ...card
}: Omit<Parameters<typeof SettingCard>[0], "aside"> & {
  checked: boolean | null;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingCard
      {...card}
      aside={
        <Switch
          size="sm"
          aria-label={card.title}
          checked={checked ?? false}
          disabled={disabled || checked === null}
          onCheckedChange={onChange}
        />
      }
    />
  );
}

function ScreenSizeCard({
  settings,
  modified,
  disabled,
  onApply,
  onReset,
}: {
  settings: DevSettings;
  modified: boolean;
  disabled: boolean;
  onApply: (
    size: { width: number; height: number },
    density: number,
  ) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const { t } = useTranslation("device-settings");
  const size = settings.screenSize ?? settings.physicalSize;
  const density = settings.density ?? settings.physicalDensity;
  const [w, setW] = useState("");
  const [h, setH] = useState("");
  const [d, setD] = useState("");

  const sw = size?.width;
  const sh = size?.height;
  useEffect(() => {
    setW(sw ? String(sw) : "");
    setH(sh ? String(sh) : "");
    setD(density ? String(density) : "");
  }, [sw, sh, density]);

  const width = Number.parseInt(w, 10);
  const height = Number.parseInt(h, 10);
  const dpi = Number.parseInt(d, 10);
  const valid =
    width >= 100 &&
    width <= 10000 &&
    height >= 100 &&
    height <= 10000 &&
    dpi >= 72 &&
    dpi <= 1000;
  const overridden = settings.screenSize !== null || settings.density !== null;
  const physical =
    settings.physicalSize && settings.physicalDensity
      ? `${settings.physicalSize.width}×${settings.physicalSize.height} @ ${settings.physicalDensity}`
      : "—";

  const run = (p: Promise<void>) => void p.catch(() => {});

  return (
    <SettingCard
      icon={Zap}
      title={t("screen.title")}
      hint={t("screen.hint", { original: physical })}
      modified={modified}
      className="col-span-2"
      aside={
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || !overridden}
          onClick={() => run(onReset())}
        >
          {t("screen.reset")}
        </Button>
      }
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) run(onApply({ width, height }, dpi));
        }}
      >
        <NumberField value={w} onChange={setW} label={t("screen.width")} />
        <span className="text-muted-foreground">×</span>
        <NumberField value={h} onChange={setH} label={t("screen.height")} />
        <span className="text-muted-foreground">@</span>
        <NumberField
          value={d}
          onChange={setD}
          label={t("screen.density")}
          suffix="dpi"
          className="w-24"
        />
        <Button type="submit" size="sm" disabled={disabled || !valid}>
          {t("screen.apply")}
        </Button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const on =
            size?.width === p.width &&
            size?.height === p.height &&
            density === p.density;
          return (
            <button
              key={p.name}
              type="button"
              disabled={disabled}
              onClick={() =>
                run(onApply({ width: p.width, height: p.height }, p.density))
              }
              className={cn(
                "bg-background focus-visible:outline-ring h-[26px] rounded-sm border px-2 text-[11px] font-medium whitespace-nowrap outline-none focus-visible:outline-2 disabled:opacity-50",
                on
                  ? "border-brand bg-brand/15 text-brand"
                  : "border-input text-secondary-foreground hover:text-foreground",
              )}
            >
              {p.name} · {p.width}×{p.height} @ {p.density}
            </button>
          );
        })}
      </div>
    </SettingCard>
  );
}

function NumberField({
  value,
  onChange,
  label,
  suffix,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  suffix?: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "border-input bg-background focus-within:border-ring flex h-7 w-[110px] items-center gap-2 rounded-[7px] border px-2.5",
        className,
      )}
    >
      <input
        inputMode="numeric"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] tabular-nums outline-none"
      />
      {suffix && (
        <span className="text-muted-foreground text-caption">{suffix}</span>
      )}
    </label>
  );
}
