import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import {
  AlertCircle,
  Check,
  Clock,
  Loader,
  Smartphone,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import { motion } from "motion/react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useNavigation } from "@/app/navigation";
import { deviceTone, StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  cancelPairing,
  connectWifi,
  deviceWifiIp,
  type MdnsService,
  mdnsServices,
  type PairEvent,
  type PairTarget,
  pairDevice,
  type QrSession,
  qrSession,
  switchToWifi,
} from "@/features/devices/api";
import { recentWifi, useKnownDevices } from "@/features/devices/known";
import { deviceName, useDeviceName } from "@/features/devices/naming";
import {
  type ConnectTab,
  useConnectSheet,
} from "@/features/devices/sheetStore";
import { useDevices } from "@/features/devices/store";
import { spring } from "@/lib/motion";
import { modKey } from "@/lib/platform";
import type { AppError } from "@/lib/tauri";

const TABS: ConnectTab[] = ["qr", "code", "ip", "legacy"];
const QR_SECONDS = 5 * 60;

/** 05 · Connect over Wi-Fi: a 440 px right sheet with four methods. */
export function ConnectSheet() {
  const { t } = useTranslation("devices");
  const open = useConnectSheet((s) => s.open);
  const tab = useConnectSheet((s) => s.tab);
  const setTab = useConnectSheet((s) => s.setTab);
  const close = useConnectSheet((s) => s.close);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        className="bg-popover w-[440px] gap-0 border-l p-0 data-[side=right]:sm:max-w-[440px]"
      >
        <div className="flex items-center justify-between px-[18px] pt-4 pr-12 pb-2.5">
          <SheetTitle className="text-section font-semibold">
            {t("wifi.title")}
          </SheetTitle>
        </div>
        <SheetDescription className="sr-only">
          {t("wifi.description")}
        </SheetDescription>
        <div
          role="tablist"
          aria-label={t("wifi.method")}
          className="flex gap-4 border-b px-[18px]"
        >
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "text-small focus-visible:outline-ring relative -mb-px flex h-[34px] items-center font-medium whitespace-nowrap outline-none focus-visible:outline-2",
                tab === id
                  ? "text-foreground"
                  : "text-secondary-foreground hover:text-foreground",
              )}
            >
              {t(`wifi.tabs.${id}`)}
              {tab === id && (
                <motion.span
                  layoutId="wifi-tab"
                  transition={spring.snappy}
                  className="bg-brand absolute inset-x-0 bottom-0 h-0.5 rounded-full"
                />
              )}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto p-[18px]"
        >
          {open && tab === "qr" && <QrTab />}
          {open && tab === "code" && <CodeTab />}
          {open && tab === "ip" && <IpTab />}
          {open && tab === "legacy" && <LegacyTab />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({
  label,
  children,
}: {
  label: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small font-medium">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="text-caption text-muted-foreground font-semibold tracking-[.05em] uppercase">
      {children}
    </div>
  );
}

function StatusRow({
  tone,
  children,
  aside,
}: {
  tone: "waiting" | "success" | "error" | "warning";
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "mt-auto flex items-center gap-2.5 rounded-md px-3 py-2.5",
        tone === "waiting" && "bg-sidebar",
        tone === "success" && "bg-success/12",
        tone === "error" && "bg-error/13",
        tone === "warning" && "bg-warning/12 items-start",
      )}
    >
      {tone === "waiting" && (
        <span className="bg-brand ring-brand/15 size-2 flex-none rounded-full ring-4" />
      )}
      {tone === "success" && (
        <Check className="text-success size-4 flex-none" />
      )}
      {tone === "error" && (
        <AlertCircle className="text-error size-4 flex-none" />
      )}
      {tone === "warning" && (
        <TriangleAlert className="text-warning mt-0.5 size-4 flex-none" />
      )}
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {aside}
    </div>
  );
}

/** "Connected to Galaxy S23 · Open". */
function Connected({ serial }: { serial: string }) {
  const { t } = useTranslation("devices");
  const device = useDevices(
    (s) => s.devices.find((d) => d.serial === serial) ?? null,
  );
  const name = useDeviceName(device) ?? serial;
  const open = () => {
    useDevices.getState().select(serial);
    useNavigation.getState().navigate("overview");
    useConnectSheet.getState().close();
  };
  return (
    <StatusRow
      tone="success"
      aside={
        <Button size="sm" variant="outline" onClick={open}>
          {t("wifi.open")}
        </Button>
      }
    >
      {t("wifi.connectedTo")} <b>{name}</b>
    </StatusRow>
  );
}

type PairState =
  | { phase: "idle" }
  | { phase: "running"; event: PairEvent }
  | { phase: "done"; serial: string }
  | { phase: "failed"; message: string };

/** Runs a pairing; cancels it when the component unmounts. */
function usePairing() {
  const [state, setState] = useState<PairState>({ phase: "idle" });
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current++;
      void cancelPairing();
    },
    [],
  );
  const start = (target: PairTarget) => {
    const id = ++run.current;
    setState({ phase: "running", event: { type: "waiting" } });
    pairDevice(target, (event) => {
      if (run.current === id) setState({ phase: "running", event });
    })
      .then((serial) => {
        if (run.current !== id) return;
        setState({ phase: "done", serial });
        useKnownDevices.getState().rememberWifi(serial, null);
      })
      .catch((e: AppError) => {
        if (run.current !== id || e.kind === "cancelled") return;
        setState({ phase: "failed", message: e.message });
      });
  };
  return { state, start };
}

function PairProgress({
  event,
  waiting,
}: {
  event: PairEvent;
  waiting: ReactNode;
}) {
  const { t } = useTranslation("devices");
  if (event.type === "waiting") return <>{waiting}</>;
  return (
    <StatusRow
      tone="waiting"
      aside={<Loader className="text-brand size-4 animate-spin" />}
    >
      {event.type === "pairing" &&
        t("wifi.pairing", { address: event.address })}
      {event.type === "paired" && t("wifi.paired")}
      {event.type === "connecting" &&
        t("wifi.connecting", { address: event.address })}
    </StatusRow>
  );
}

function QrTab() {
  const { t } = useTranslation("devices");
  const [attempt, setAttempt] = useState(0);
  const { data: session, error } = useQuery({
    queryKey: ["wifi-qr", attempt],
    queryFn: qrSession,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const { state, start } = usePairing();
  const [left, setLeft] = useState(QR_SECONDS);

  // biome-ignore lint/correctness/useExhaustiveDependencies: start a new wait per QR session only
  useEffect(() => {
    if (!session) return;
    start({ type: "qr", name: session.name, password: session.password });
    setLeft(QR_SECONDS);
    const timer = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [session]);

  const expired = left === 0 && state.phase === "running";

  return (
    <>
      <div className="relative self-center rounded-[14px] bg-white p-3.5">
        {session ? (
          <QrCode session={session} />
        ) : (
          <div className="size-[200px]" />
        )}
        <span className="bg-primary text-primary-foreground absolute top-1/2 left-1/2 -mt-[18px] -ml-[18px] flex size-9 items-center justify-center rounded-[9px] border-[3px] border-white">
          <svg
            viewBox="0 0 24 24"
            className="size-[15px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="7" y="3" width="10" height="13" rx="2" />
            <path d="M12 16v2a3 3 0 0 0 3 3h4" />
          </svg>
        </span>
      </div>
      <div className="text-small text-muted-foreground text-center">
        {t("wifi.qr.requirements")}
      </div>
      <ol className="text-secondary-foreground flex list-decimal flex-col gap-1 pl-[18px]">
        <li>{t("wifi.qr.step1")}</li>
        <li>{t("wifi.qr.step2")}</li>
        <li>{t("wifi.qr.step3")}</li>
      </ol>
      {error ? (
        <StatusRow tone="error">
          {(error as unknown as AppError).message}
        </StatusRow>
      ) : state.phase === "done" ? (
        <Connected serial={state.serial} />
      ) : state.phase === "failed" || expired ? (
        <StatusRow
          tone="error"
          aside={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t("wifi.newCode")}
            </Button>
          }
        >
          {expired
            ? t("wifi.qr.expired")
            : state.phase === "failed"
              ? state.message
              : null}
        </StatusRow>
      ) : state.phase === "running" ? (
        <PairProgress
          event={state.event}
          waiting={
            <StatusRow
              tone="waiting"
              aside={
                <span className="text-caption text-muted-foreground font-mono tabular-nums">
                  {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
                </span>
              }
            >
              {t("wifi.qr.waiting")}
            </StatusRow>
          }
        />
      ) : null}
    </>
  );
}

function QrCode({ session }: { session: QrSession }) {
  const { width, modules } = session;
  let d = "";
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      if (modules[y * width + x] === "1") d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return (
    <svg
      viewBox={`-2 -2 ${width + 4} ${width + 4}`}
      className="size-[200px]"
      shapeRendering="crispEdges"
      role="img"
      aria-label={session.payload}
    >
      <path d={d} className="fill-black" />
    </svg>
  );
}

/** Pairing services broadcast on the network, refreshed every 2 s. */
function useMdns(enabled = true) {
  return useQuery({
    queryKey: ["wifi-mdns"],
    queryFn: mdnsServices,
    refetchInterval: 2000,
    enabled,
  });
}

/** Phone name for a pairing service: a known device with that serial. */
function serviceLabel(service: MdnsService, devices: Record<string, string>) {
  const m = service.name.match(/^adb-([^-]+)-/);
  const serial = m?.[1];
  return (serial && (devices[serial] ?? serial)) || service.name;
}

function CodeTab() {
  const { t } = useTranslation("devices");
  const { data } = useMdns();
  const snapshots = useDevices((s) => s.snapshots);
  const names: Record<string, string> = {};
  for (const d of Object.values(snapshots)) names[d.serial] = deviceName(d);
  const pairing =
    data?.services.filter(
      (s) => s.kind === "pairing" && !s.name.startsWith("tether-"),
    ) ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [code, setCode] = useState("");
  const { state, start } = usePairing();
  const selected =
    pairing.find((s) => s.address === picked) ?? (manual ? null : pairing[0]);
  const address = selected?.address ?? manual.trim();
  const target = selected ? serviceLabel(selected, names) : manual.trim();
  const busy = state.phase === "running";

  return (
    <>
      <p className="text-secondary-foreground">{t("wifi.code.intro")}</p>
      <Label>{t("wifi.code.found")}</Label>
      {pairing.map((s) => {
        const on = s.address === selected?.address;
        return (
          <button
            key={s.address}
            type="button"
            aria-pressed={on}
            onClick={() => setPicked(s.address)}
            className={cn(
              "focus-visible:outline-ring flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left outline-none focus-visible:outline-2",
              on ? "border-brand bg-brand/15" : "hover:bg-accent",
            )}
          >
            <Smartphone
              className="text-secondary-foreground size-4"
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {serviceLabel(s, names)}
              </span>
              <span className="text-caption text-muted-foreground block font-mono">
                {s.address}
              </span>
            </span>
            {on && <Check className="text-brand size-4" aria-hidden />}
          </button>
        );
      })}
      <div className="text-small text-muted-foreground flex items-center gap-1.5">
        {data && !data.available ? (
          t("wifi.code.mdnsOff")
        ) : (
          <>
            <Loader className="size-3.5 animate-spin" aria-hidden />
            {t("wifi.code.scanning")}
          </>
        )}
      </div>
      {pairing.length === 0 && (
        <Field label={t("wifi.code.manual")}>
          {(id) => (
            <Input
              id={id}
              className="font-mono"
              placeholder="192.168.1.42:41823"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
          )}
        </Field>
      )}
      <Label>
        {target
          ? t("wifi.code.codeFor", { name: target })
          : t("wifi.code.code")}
      </Label>
      <CodeInput value={code} onChange={setCode} disabled={busy} />
      {state.phase === "done" ? (
        <Connected serial={state.serial} />
      ) : state.phase === "failed" ? (
        <StatusRow tone="error">{state.message}</StatusRow>
      ) : state.phase === "running" ? (
        <PairProgress event={state.event} waiting={null} />
      ) : null}
      <Button
        className="mt-auto h-9"
        disabled={code.length !== 6 || !address || busy}
        onClick={() => start({ type: "code", address, code })}
      >
        {busy ? <Loader className="animate-spin" /> : null}
        {t("wifi.code.pair")}
      </Button>
    </>
  );
}

/** Six one-digit boxes; typing advances, Backspace goes back, paste fills. */
function CodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("devices");
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  // Keystrokes can outrun re-renders; always edit the newest value.
  const latest = useRef(value);
  latest.current = value;
  /** Writes a digit at box `i` (no gaps) and returns where it landed. */
  const set = (i: number, digit: string) => {
    const cur = latest.current;
    const pos = Math.min(i, cur.length);
    const next = digit
      ? (cur.slice(0, pos) + digit + cur.slice(pos + 1)).slice(0, 6)
      : cur.slice(0, i) + cur.slice(i + 1);
    latest.current = next;
    onChange(next);
    return pos;
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === "Backspace" && !latest.current[i] && i > 0) {
      refs.current[i - 1]?.focus();
      set(i - 1, "");
      e.preventDefault();
    } else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
  };
  const onPaste = (e: ClipboardEvent) => {
    const digits = e.clipboardData
      .getData("text")
      .replace(/\D/g, "")
      .slice(0, 6);
    if (!digits) return;
    e.preventDefault();
    onChange(digits);
    refs.current[Math.min(digits.length, 5)]?.focus();
  };
  return (
    <fieldset
      aria-label={t("wifi.code.code")}
      className="grid grid-cols-6 gap-1.5"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <input
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed six slots
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          aria-label={t("wifi.code.digit", { n: i + 1 })}
          inputMode="numeric"
          autoComplete="one-time-code"
          // biome-ignore lint/a11y/noAutofocus: the code is the only input of this step
          autoFocus={i === 0}
          disabled={disabled}
          value={value[i] ?? ""}
          onPaste={onPaste}
          onKeyDown={(e) => onKey(e, i)}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, "");
            const digit = raw.slice(-1);
            // Typing into a filled box continues the code instead of
            // overwriting it.
            const at = raw.length > 1 ? latest.current.length : i;
            const pos = set(at, digit);
            if (digit) refs.current[Math.min(pos + 1, 5)]?.focus();
          }}
          className="border-input bg-background focus:border-ring focus:ring-brand/15 text-title h-11 rounded-md border text-center font-mono font-semibold outline-none focus:ring-[3px] disabled:opacity-50"
        />
      ))}
    </fieldset>
  );
}

function ago(
  ms: number,
  t: (k: string, o?: Record<string, unknown>) => string,
) {
  const mins = Math.floor((Date.now() - ms) / 60_000);
  if (mins < 60 * 24) return t("wifi.ip.today");
  const days = Math.floor(mins / (60 * 24));
  return days < 14
    ? t("wifi.ip.days", { count: days })
    : t("wifi.ip.weeks", { count: Math.floor(days / 7) });
}

function IpTab() {
  const { t } = useTranslation("devices");
  const history = useKnownDevices((s) => s.wifi);
  const recent = recentWifi(history).slice(0, 6);
  const [address, setAddress] = useState(recent[0]?.address ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { serial: string } | { error: string } | null
  >(null);

  const connect = (target = address) => {
    if (!target.trim()) return;
    setAddress(target);
    setBusy(true);
    setResult(null);
    connectWifi(target)
      .then((serial) => {
        setResult({ serial });
        useKnownDevices.getState().rememberWifi(serial, null);
      })
      .catch((e: AppError) => setResult({ error: e.message }))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Field label={t("wifi.ip.address")}>
        {(id) => (
          <Input
            id={id}
            autoFocus
            className="font-mono"
            placeholder="192.168.1.42:37115"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect()}
          />
        )}
      </Field>
      <span className="text-small text-muted-foreground -mt-2">
        {t("wifi.ip.hint")}
      </span>
      <Button
        className="h-[34px]"
        disabled={busy || !address.trim()}
        onClick={() => connect()}
      >
        {busy && <Loader className="animate-spin" />}
        {t("wifi.ip.connect")}
      </Button>
      {recent.length > 0 && (
        <>
          <Label>{t("wifi.ip.recent")}</Label>
          <div className="flex flex-col gap-0.5">
            {recent.map((r) => (
              <button
                key={r.address}
                type="button"
                onClick={() => connect(r.address)}
                className={cn(
                  "hover:bg-accent focus-visible:outline-ring flex h-[34px] items-center gap-2 rounded-sm px-2 text-left outline-none focus-visible:outline-2",
                  r.address === address && "bg-selected",
                )}
              >
                <Clock className="text-muted-foreground size-4" aria-hidden />
                <span className="flex-1 font-mono">{r.address}</span>
                <span className="text-small text-muted-foreground">
                  {r.name ? `${r.name} · ` : ""}
                  {ago(r.lastConnected, t)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {result && "serial" in result && <Connected serial={result.serial} />}
      {result && "error" in result && (
        <StatusRow tone="error">{result.error}</StatusRow>
      )}
    </>
  );
}

function LegacyTab() {
  const { t } = useTranslation("devices");
  const usb = useDevices((s) => s.devices).filter((d) => d.transport === "usb");
  const [picked, setPicked] = useState<string | null>(null);
  const device =
    usb.find((d) => d.serial === picked) ??
    usb.find((d) => d.state.kind === "device") ??
    null;
  const ready = device?.state.kind === "device";
  const { data: ip } = useQuery({
    queryKey: ["wifi-ip", device?.serial],
    queryFn: () => (device ? deviceWifiIp(device.serial) : null),
    enabled: ready,
  });
  const [port, setPort] = useState("5555");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { serial: string } | { error: string } | null
  >(null);
  const portNum = Number(port);
  const validPort = Number.isInteger(portNum) && portNum > 0 && portNum < 65536;

  const run = () => {
    if (!device) return;
    setBusy(true);
    setResult(null);
    switchToWifi(device.serial, portNum)
      .then((serial) => {
        setResult({ serial });
        useKnownDevices.getState().rememberWifi(serial, deviceName(device));
      })
      .catch((e: AppError) => setResult({ error: e.message }))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <p className="text-secondary-foreground">{t("wifi.legacy.intro")}</p>
      <Label>{t("wifi.legacy.plugged")}</Label>
      {usb.length === 0 && (
        <div className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-center">
          {t("wifi.legacy.none")}
        </div>
      )}
      {usb.map((d) => (
        <button
          key={d.serial}
          type="button"
          aria-pressed={d.serial === device?.serial}
          onClick={() => setPicked(d.serial)}
          className={cn(
            "focus-visible:outline-ring flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left outline-none focus-visible:outline-2",
            d.serial === device?.serial
              ? "border-brand bg-brand/15"
              : "hover:bg-accent",
          )}
        >
          <Smartphone
            className="text-secondary-foreground size-4"
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{deviceName(d)}</span>
            <span className="text-caption text-muted-foreground block">
              USB
              {d.serial === device?.serial && ip && (
                <>
                  {" · Wi-Fi "}
                  <span className="font-mono">{ip}</span>
                </>
              )}
            </span>
          </span>
          <Badge variant={d.state.kind === "device" ? "success" : "warning"}>
            <StatusDot tone={deviceTone(d.state)} />
            {d.state.kind === "unknown"
              ? d.state.raw
              : d.state.kind.replace("_", " ")}
          </Badge>
        </button>
      ))}
      <Field label={t("wifi.legacy.port")}>
        {(id) => (
          <Input
            id={id}
            className="font-mono tabular-nums"
            inputMode="numeric"
            value={port}
            aria-invalid={!validPort}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
          />
        )}
      </Field>
      <Button
        className="h-[34px]"
        disabled={!ready || !validPort || busy}
        onClick={run}
      >
        {busy ? <Loader className="animate-spin" /> : <Wifi />}
        {t("wifi.legacy.switch")}
      </Button>
      {device && (
        <pre className="text-caption text-muted-foreground bg-sidebar selectable rounded-[7px] border px-2.5 py-2 font-mono leading-[17px] whitespace-pre-wrap">
          {`adb -s ${device.serial} tcpip ${port || 5555}\nadb connect ${ip ?? "<phone ip>"}:${port || 5555}`}
        </pre>
      )}
      {result && "serial" in result && <Connected serial={result.serial} />}
      {result && "error" in result && (
        <StatusRow tone="error">{result.error}</StatusRow>
      )}
      {!result && (
        <StatusRow tone="warning">
          {t("wifi.legacy.warning", { port: port || 5555 })}
        </StatusRow>
      )}
    </>
  );
}

/** Shortcut hint for the sheet (⌘⇧W). */
export const CONNECT_SHORTCUT = [modKey, "⇧", "W"];
