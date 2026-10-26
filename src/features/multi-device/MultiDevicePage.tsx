import { useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Camera,
  Check,
  ChevronDown,
  CircleAlert,
  CornerDownLeft,
  House,
  Loader,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Undo2,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PACKAGE_EXTENSIONS } from "@/features/apps/api";
import { useInstall } from "@/features/apps/install/installStore";
import { ProfileTile } from "@/features/device-settings/ProfileParts";
import {
  applyProfile,
  type DevProfile,
  describeProfile,
  profileName,
  useProfiles,
} from "@/features/device-settings/profiles";
import { deviceExec } from "@/features/devices/api";
import { NoDevices } from "@/features/devices/NoDevices";
import { deviceName } from "@/features/devices/naming";
import { useDevices } from "@/features/devices/store";
import {
  composeGrid,
  type MultiCapture,
  screenshotAll,
} from "@/features/multi-device/api";
import { DeviceTile } from "@/features/multi-device/DeviceTile";
import {
  selectedSerials,
  sendKey,
  sendText,
} from "@/features/multi-device/input";
import { useMulti } from "@/features/multi-device/store";
import { fileStamp } from "@/features/overview/format";
import type { AppError, DeviceInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Header button labels collapse to icons in narrow windows. */
const WIDE = "hidden min-[1180px]:inline";

const errorText = (e: unknown) =>
  (e as Partial<AppError>)?.message ?? String(e);

/** P2 · Multi-device grid: every screen side by side, one action for all. */
export default function MultiDevicePage() {
  const { t } = useTranslation("multi-device");
  const queryClient = useQueryClient();
  const devices = useDevices((s) => s.devices);
  const loading = useDevices((s) => s.loading);
  const params = useNavigation((s) => s.params);
  const navigate = useNavigation((s) => s.navigate);
  const excluded = useMulti((s) => s.excluded);
  const setStatus = useMulti((s) => s.setStatus);
  const [shooting, setShooting] = useState(false);
  const [capture, setCapture] = useState<MultiCapture | null>(null);
  const [composing, setComposing] = useState(false);

  const ready = devices.filter((d) => d.state.kind === "device");
  const selected = ready.filter((d) => !excluded.includes(d.serial));
  const allSelected = ready.length > 0 && selected.length === ready.length;

  // From All devices: navigate("multi-device", { serials: "a,b" }).
  useEffect(() => {
    if (!params.serials) return;
    const wanted = params.serials.split(",");
    useMulti.getState().selectOnly(
      wanted,
      useDevices
        .getState()
        .devices.filter((d) => d.state.kind === "device")
        .map((d) => d.serial),
    );
  }, [params.serials]);

  const nameOf = (serial: string) => {
    const d = devices.find((x) => x.serial === serial);
    const info = queryClient.getQueryData<DeviceInfo>(["device-info", serial]);
    return d ? deviceName(d, info) : serial;
  };

  const shootAll = async () => {
    const serials = selectedSerials();
    if (serials.length === 0) return;
    setShooting(true);
    setCapture(null);
    try {
      const result = await screenshotAll(
        serials.map((serial) => ({ serial, name: nameOf(serial) })),
        fileStamp(),
      );
      setCapture(result);
      for (const shot of result.shots)
        setStatus(
          shot.serial,
          shot.error
            ? {
                tone: "error",
                text: t("status.shotFailed"),
                detail: shot.error,
              }
            : { tone: "success", text: t("status.shot") },
        );
      void queryClient.invalidateQueries({ queryKey: ["captures"] });
    } catch (error) {
      toast.error(t("screenshot.failed"), { description: errorText(error) });
    } finally {
      setShooting(false);
    }
  };

  const compose = async () => {
    const paths = (capture?.shots ?? []).flatMap((s) =>
      s.capture ? [s.capture.path] : [],
    );
    if (paths.length === 0) return;
    setComposing(true);
    try {
      const grid = await composeGrid(paths);
      toast.success(t("screenshot.composed"), {
        description: grid.name,
        action: {
          label: t("screenshot.show"),
          onClick: () => void revealItemInDir(grid.path).catch(() => {}),
        },
      });
      void queryClient.invalidateQueries({ queryKey: ["captures"] });
    } catch (error) {
      toast.error(t("screenshot.composeFailed"), {
        description: errorText(error),
      });
    } finally {
      setComposing(false);
    }
  };

  const installOnAll = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: t("install.pickTitle"),
        filters: [
          { name: t("install.filterName"), extensions: PACKAGE_EXTENSIONS },
        ],
      });
      if (typeof picked === "string")
        useInstall.getState().openWith(picked, selectedSerials());
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const applyToAll = async (profile: DevProfile) => {
    const targets = selected;
    await Promise.all(
      targets.map(async (d) => {
        setStatus(d.serial, {
          tone: "info",
          text: t("status.applying"),
          busy: true,
        });
        try {
          const result = await applyProfile(d.serial, d.transport, profile);
          queryClient.setQueryData(["dev-settings", d.serial], result.settings);
          setStatus(
            d.serial,
            result.failed.length > 0
              ? {
                  tone: "warning",
                  text: t("status.partly"),
                  detail: result.failed
                    .map((f) => `${f.key}: ${f.message}`)
                    .join("\n"),
                }
              : { tone: "success", text: t("status.applied") },
          );
        } catch (error) {
          setStatus(d.serial, {
            tone: "error",
            text: t("status.applyFailed"),
            detail: errorText(error),
          });
        }
      }),
    );
  };

  if (!loading && devices.length === 0) return <NoDevices />;

  return (
    <Page
      title={t("title", { count: devices.length })}
      parent={{ label: t("allDevices"), onClick: () => navigate("devices") }}
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={selected.length === 0}
            onClick={() => void installOnAll()}
            title={t("install.button")}
          >
            <Upload />
            <span className={WIDE}>{t("install.button")}</span>
          </Button>
          <ProfileMenu
            disabled={selected.length === 0}
            onApply={(p) => void applyToAll(p)}
          />
          <Button
            size="sm"
            disabled={selected.length === 0 || shooting}
            onClick={() => void shootAll()}
            title={t("screenshot.button")}
          >
            {shooting ? <Loader className="animate-spin" /> : <Camera />}
            <span className={WIDE}>{t("screenshot.button")}</span>
          </Button>
        </>
      }
      toolbar={
        <>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders the control */}
          <label className="text-small flex flex-none items-center gap-2">
            <Checkbox
              aria-label={t("selectAll")}
              checked={allSelected}
              indeterminate={!allSelected && selected.length > 0}
              disabled={ready.length === 0}
              onCheckedChange={(on) =>
                useMulti.getState().selectOnly(
                  on ? ready.map((d) => d.serial) : [],
                  ready.map((d) => d.serial),
                )
              }
            />
            <span className="tabular-nums">
              {t("selected", { count: selected.length, total: ready.length })}
            </span>
          </label>
          <RunCommand disabled={selected.length === 0} />
        </>
      }
      className="flex flex-col gap-3.5 px-5 py-4"
    >
      {capture && (
        <CaptureBanner
          capture={capture}
          composing={composing}
          onCompose={() => void compose()}
        />
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] items-start gap-4">
        {devices.map((d) => (
          <DeviceTile key={d.serial} device={d} />
        ))}
      </div>
      <ControlCard count={selected.length} />
    </Page>
  );
}

function ProfileMenu({
  disabled,
  onApply,
}: {
  disabled: boolean;
  onApply: (profile: DevProfile) => void;
}) {
  const { t } = useTranslation("multi-device");
  const profiles = useProfiles((s) => s.profiles);
  const navigate = useNavigation((s) => s.navigate);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="sm" variant="outline" />}
        disabled={disabled}
        title={t("profile.button")}
      >
        <SlidersHorizontal />
        <span className={WIDE}>{t("profile.button")}</span>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {profiles.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onClick={() => onApply(p)}
            className="items-start gap-2.5 py-1.5"
          >
            <ProfileTile profile={p} applied={false} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {profileName(p, t)}
              </span>
              <span className="text-caption text-muted-foreground line-clamp-2">
                {describeProfile(p, t)}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        {profiles.length === 0 && (
          <DropdownMenuItem
            onClick={() => navigate("device-settings", { view: "profiles" })}
          >
            {t("profile.none")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunCommand({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation("multi-device");
  const setStatus = useMulti((s) => s.setStatus);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const cmd = command.trim();
    const serials = selectedSerials();
    if (!cmd || serials.length === 0) return;
    setBusy(true);
    await Promise.all(
      serials.map(async (serial) => {
        setStatus(serial, {
          tone: "info",
          text: t("status.running"),
          busy: true,
        });
        try {
          const out = (await deviceExec(serial, cmd)).trimEnd();
          const first = out.split("\n")[0] ?? "";
          setStatus(serial, {
            tone: "success",
            text: first || t("status.noOutput"),
            detail: out.includes("\n") ? out : undefined,
          });
        } catch (error) {
          setStatus(serial, {
            tone: "error",
            text: t("status.commandFailed"),
            detail: errorText(error),
          });
        }
      }),
    );
    setBusy(false);
  };

  return (
    <form
      className="ml-auto flex min-w-0 flex-[0_1_520px] items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <div className="border-input bg-background focus-within:border-ring h-ctl-sm flex min-w-0 flex-1 items-center gap-2 rounded-[7px] border px-2.5">
        <SquareTerminal
          className="text-muted-foreground size-3.5 flex-none"
          aria-hidden
        />
        <input
          aria-label={t("run.label")}
          placeholder={t("run.placeholder")}
          value={command}
          disabled={disabled}
          onChange={(e) => setCommand(e.target.value)}
          className="text-small placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent font-mono outline-none"
        />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={disabled || busy || !command.trim()}
      >
        {busy && <Loader className="animate-spin" />}
        {t("run.button")}
      </Button>
    </form>
  );
}

function CaptureBanner({
  capture,
  composing,
  onCompose,
}: {
  capture: MultiCapture;
  composing: boolean;
  onCompose: () => void;
}) {
  const { t } = useTranslation("multi-device");
  const ok = capture.shots.filter((s) => s.capture);
  const failed = capture.shots.length - ok.length;
  const folder = capture.dir.split(/[\\/]/).pop() ?? capture.dir;
  const seconds = (capture.elapsedMs / 1000).toFixed(1);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-[10px] px-3.5 py-2.5",
        failed > 0 ? "bg-warning/12" : "bg-success/12",
      )}
    >
      {failed > 0 ? (
        <CircleAlert className="text-warning size-4 flex-none" aria-hidden />
      ) : (
        <Check className="text-success size-4 flex-none" aria-hidden />
      )}
      <span className="min-w-0 flex-[1_1_280px]">
        {t("screenshot.done", { count: ok.length, seconds })}
        {failed > 0 && ` · ${t("screenshot.someFailed", { count: failed })}`}
        {ok.length > 0 && (
          <>
            {" · "}
            {t("screenshot.savedAs")}{" "}
            <span className="font-mono">{folder}/</span>
          </>
        )}
      </span>
      {ok[0]?.capture && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            ok[0]?.capture &&
            void revealItemInDir(ok[0].capture.path).catch(() => {})
          }
        >
          {t("screenshot.openFolder")}
        </Button>
      )}
      {ok.length > 1 && (
        <Button
          size="sm"
          variant="outline"
          disabled={composing}
          onClick={onCompose}
        >
          {composing && <Loader className="animate-spin" />}
          {t("screenshot.compose")}
        </Button>
      )}
    </div>
  );
}

/** Keys and text for every selected device; taps can be broadcast too. */
function ControlCard({ count }: { count: number }) {
  const { t } = useTranslation("multi-device");
  const broadcast = useMulti((s) => s.broadcast);
  const setBroadcast = useMulti((s) => s.setBroadcast);
  const [text, setText] = useState("");
  const disabled = count === 0;

  const report = (results: PromiseSettledResult<unknown>[]) => {
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failed.length > 0)
      toast.error(t("control.failed", { count: failed.length }), {
        description: errorText(failed[0]?.reason),
      });
  };
  const key = (k: string) => void sendKey(k).then(report);

  return (
    <div className="bg-card flex flex-wrap items-center gap-3 rounded-[10px] border p-3.5">
      <span className="font-semibold">{t("control.title")}</span>
      <span className="text-small text-secondary-foreground min-w-0 flex-[1_1_240px]">
        {t("control.hint", { count })}
      </span>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => key("BACK")}
        >
          <Undo2 />
          {t("control.back")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => key("HOME")}
        >
          <House />
          {t("control.home")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => key("APP_SWITCH")}
        >
          <Square />
          {t("control.recents")}
        </Button>
      </div>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          void sendText(text).then(report);
          setText("");
        }}
      >
        <Input
          aria-label={t("control.type")}
          placeholder={t("control.type")}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          className="h-ctl-sm w-44"
        />
        <Button
          type="submit"
          size="icon-sm"
          variant="outline"
          aria-label={t("control.send")}
          disabled={disabled || !text}
        >
          <CornerDownLeft />
        </Button>
      </form>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: Switch renders the control */}
      <label className="text-small ml-auto flex items-center gap-2">
        <Switch
          size="sm"
          checked={broadcast}
          onCheckedChange={setBroadcast}
          aria-label={t("control.broadcast")}
        />
        {t("control.broadcast")}
      </label>
    </div>
  );
}
