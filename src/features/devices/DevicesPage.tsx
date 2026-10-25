import { cn } from "cn";
import { Camera, LayoutGrid, List, Loader, Plus, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { deviceExec, saveScreenshot } from "@/features/devices/api";
import {
  DeviceCard,
  MoreMenu,
  OfflineCard,
  rememberedOffline,
  StateBadge,
  useDeviceActions,
} from "@/features/devices/DeviceCard";
import { RenameDialog } from "@/features/devices/dialogs";
import { useKnownDevices } from "@/features/devices/known";
import { NoDevices } from "@/features/devices/NoDevices";
import { deviceName, useDeviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useConnectSheet } from "@/features/devices/sheetStore";
import { useDevices } from "@/features/devices/store";
import { Segmented } from "@/features/settings/Segmented";
import { spring } from "@/lib/motion";
import { useSettings } from "@/lib/settings";
import type { AppError, Device } from "@/lib/tauri";

type View = "grid" | "list";

/** 03 · All devices: cards for every connected and remembered device. */
export default function DevicesPage() {
  const { t } = useTranslation("devices");
  const devices = useDevices((s) => s.devices);
  const loading = useDevices((s) => s.loading);
  const wifi = useKnownDevices((s) => s.wifi);
  useKnownDevices((s) => s.aliases);
  const params = useNavigation((s) => s.params);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("grid");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [running, setRunning] = useState(false);

  // Old entry point: navigate("devices", { connect: "wifi" }).
  useEffect(() => {
    if (params.connect === "wifi") useConnectSheet.getState().show();
  }, [params]);

  // Drop selections of devices that went away or are no longer ready.
  useEffect(() => {
    setSelected((prev) => {
      const ready = new Set(
        devices.filter((d) => d.state.kind === "device").map((d) => d.serial),
      );
      const next = new Set([...prev].filter((s) => ready.has(s)));
      return next.size === prev.size ? prev : next;
    });
  }, [devices]);

  const q = query.trim().toLowerCase();
  const match = (name: string, serial: string) =>
    !q || name.toLowerCase().includes(q) || serial.toLowerCase().includes(q);
  const live = devices.filter((d) => match(deviceName(d), d.serial));
  const remembered = rememberedOffline(wifi, devices).filter((w) =>
    match(w.name ?? "", w.address),
  );
  const total = devices.length + rememberedOffline(wifi, devices).length;
  const toggle = (serial: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(serial);
      else next.delete(serial);
      return next;
    });

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          {t("page.title")}
          <Badge className="tabular-nums">{total}</Badge>
        </span>
      }
      actions={
        <>
          <div className="border-input bg-background text-muted-foreground focus-within:border-ring hidden h-7 w-[220px] items-center gap-2 rounded-[7px] border px-2.5 min-[1100px]:flex">
            <Search className="size-3.5 flex-none" aria-hidden />
            <input
              aria-label={t("page.filter")}
              placeholder={t("page.filter")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="text-foreground placeholder:text-muted-foreground text-small min-w-0 flex-1 bg-transparent outline-none"
            />
          </div>
          <Segmented
            label={t("page.view")}
            value={view}
            onChange={setView}
            options={[
              {
                value: "grid",
                label: <LayoutGrid className="size-3.5" />,
                ariaLabel: t("page.grid"),
              },
              {
                value: "list",
                label: <List className="size-3.5" />,
                ariaLabel: t("page.list"),
              },
            ]}
          />
          <Button size="sm" onClick={() => useConnectSheet.getState().show()}>
            <Plus />
            {t("page.connect")}
          </Button>
        </>
      }
    >
      {!loading && total === 0 ? (
        <div className="-my-6 h-[calc(100%+3rem)]">
          <NoDevices />
        </div>
      ) : (
        <>
          <AnimatePresence initial={false}>
            {selected.size > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring.smooth}
                className="overflow-hidden"
              >
                <SelectionBar
                  serials={[...selected]}
                  allSelected={
                    selected.size ===
                    devices.filter((d) => d.state.kind === "device").length
                  }
                  onSelectAll={(on) =>
                    setSelected(
                      on
                        ? new Set(
                            devices
                              .filter((d) => d.state.kind === "device")
                              .map((d) => d.serial),
                          )
                        : new Set(),
                    )
                  }
                  onRun={() => setRunning(true)}
                />
              </motion.div>
            )}
          </AnimatePresence>
          {view === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] items-start gap-4">
              {live.map((d) => (
                <DeviceCard
                  key={d.serial}
                  device={d}
                  selected={selected.has(d.serial)}
                  onToggle={(on) => toggle(d.serial, on)}
                  onRename={() => setRenaming(d)}
                />
              ))}
              {remembered.map((w) => (
                <OfflineCard
                  key={w.address}
                  serial={w.address}
                  name={
                    useKnownDevices.getState().aliases[w.address] ??
                    w.name ??
                    w.address
                  }
                  device={null}
                  since={w.lastConnected}
                />
              ))}
            </div>
          ) : (
            <div className="bg-card overflow-hidden rounded-[10px] border">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-small text-muted-foreground border-b text-left">
                    <th
                      className="h-8 w-8 px-3"
                      aria-label={t("page.select")}
                    />
                    <th className="h-8 px-3 font-medium">{t("list.name")}</th>
                    <th className="h-8 px-3 font-medium">{t("list.serial")}</th>
                    <th className="h-8 px-3 font-medium">
                      {t("card.transport")}
                    </th>
                    <th className="h-8 px-3 font-medium">
                      {t("card.android")}
                    </th>
                    <th className="h-8 px-3 font-medium">{t("list.state")}</th>
                    <th className="h-8 w-10 px-3" />
                  </tr>
                </thead>
                <tbody>
                  {live.map((d) => (
                    <ListRow
                      key={d.serial}
                      device={d}
                      selected={selected.has(d.serial)}
                      onToggle={(on) => toggle(d.serial, on)}
                      onRename={() => setRenaming(d)}
                    />
                  ))}
                  {remembered.map((w) => (
                    <tr key={w.address} className="border-b last:border-b-0">
                      <td className="h-8 px-3" />
                      <td className="h-8 px-3">{w.name ?? w.address}</td>
                      <td className="text-small h-8 px-3 font-mono">
                        {w.address}
                      </td>
                      <td className="h-8 px-3">Wi-Fi</td>
                      <td className="h-8 px-3">—</td>
                      <td className="h-8 px-3">
                        <Badge variant="error">{t("list.remembered")}</Badge>
                      </td>
                      <td className="h-8 px-3" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {q && live.length === 0 && remembered.length === 0 && (
            <p className="text-muted-foreground py-10 text-center">
              {t("page.nothing", { query })}
            </p>
          )}
        </>
      )}
      <RenameDialog
        device={renaming}
        fallback={renaming ? (renaming.model ?? renaming.serial) : ""}
        onClose={() => setRenaming(null)}
      />
      <RunCommandDialog
        open={running}
        serials={[...selected]}
        onClose={() => setRunning(false)}
      />
    </Page>
  );
}

function ListRow({
  device,
  selected,
  onToggle,
  onRename,
}: {
  device: Device;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onRename: () => void;
}) {
  const { t } = useTranslation("devices");
  const ready = device.state.kind === "device";
  const { data: info } = useDeviceInfo(ready ? device.serial : null);
  const name = useDeviceName(device, info);
  const { open } = useDeviceActions(device);
  return (
    <tr
      className={cn(
        "hover:bg-accent border-b last:border-b-0",
        selected && "bg-brand/15 hover:bg-brand/15",
      )}
      onDoubleClick={() => ready && open("overview")}
    >
      <td className="h-8 px-3">
        <Checkbox
          aria-label={t("card.select", { name })}
          checked={selected}
          disabled={!ready}
          onCheckedChange={onToggle}
        />
      </td>
      <td className="h-8 px-3 font-medium">{name}</td>
      <td className="text-small h-8 px-3 font-mono">{device.serial}</td>
      <td className="h-8 px-3">
        {t(`transport.${device.transport}`, { ns: "common" })}
      </td>
      <td className="h-8 px-3 tabular-nums">{info?.androidVersion ?? "—"}</td>
      <td className="h-8 px-3">
        <StateBadge device={device} />
      </td>
      <td className="h-8 px-2">
        <MoreMenu device={device} onRename={onRename} />
      </td>
    </tr>
  );
}

function SelectionBar({
  serials,
  allSelected,
  onSelectAll,
  onRun,
}: {
  serials: string[];
  allSelected: boolean;
  onSelectAll: (on: boolean) => void;
  onRun: () => void;
}) {
  const { t } = useTranslation("devices");
  const [busy, setBusy] = useState(false);
  const screenshotAll = async () => {
    setBusy(true);
    const dir = useSettings.getState().capturesDir;
    const results = await Promise.allSettled(
      serials.map((serial) => saveScreenshot(serial, dir)),
    );
    setBusy(false);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (ok === results.length) toast.success(t("multi.saved", { count: ok }));
    else
      toast.error(t("multi.savedSome", { ok, total: results.length }), {
        description: results
          .flatMap((r) =>
            r.status === "rejected" ? [(r.reason as AppError).message] : [],
          )
          .join("\n"),
      });
  };
  return (
    <div className="bg-brand/15 mb-4 flex flex-wrap items-center gap-3 rounded-md px-3 py-2">
      <Checkbox
        aria-label={t("multi.selectAll")}
        checked={allSelected}
        indeterminate={!allSelected}
        onCheckedChange={(on) => onSelectAll(on)}
      />
      <span className="font-medium">
        {t("multi.selected", { count: serials.length })}
      </span>
      <span className="text-small text-muted-foreground">
        {t("multi.parallel")}
      </span>
      <div className="ml-auto flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void screenshotAll()}
        >
          {busy ? <Loader className="animate-spin" /> : <Camera />}
          {t("multi.screenshot")}
        </Button>
        <Button size="sm" variant="outline" onClick={onRun}>
          {t("multi.run")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onSelectAll(false)}>
          {t("multi.clear")}
        </Button>
      </div>
    </div>
  );
}

type RunResult = { serial: string; output?: string; error?: string };

function RunCommandDialog({
  open,
  serials,
  onClose,
}: {
  open: boolean;
  serials: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation("devices");
  const devices = useDevices((s) => s.devices);
  const [command, setCommand] = useState("getprop ro.build.version.release");
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const settled = await Promise.allSettled(
      serials.map((serial) => deviceExec(serial, command)),
    );
    setResults(
      settled.map((r, i) =>
        r.status === "fulfilled"
          ? { serial: serials[i], output: r.value }
          : { serial: serials[i], error: (r.reason as AppError).message },
      ),
    );
    setBusy(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setResults(null);
        }
      }}
    >
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {t("multi.runTitle", { count: serials.length })}
          </DialogTitle>
          <DialogDescription>{t("multi.runText")}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            autoFocus
            className="font-mono"
            aria-label={t("multi.command")}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void run()}
          />
          <Button disabled={busy || !command.trim()} onClick={() => void run()}>
            {busy && <Loader className="animate-spin" />}
            {t("multi.runButton")}
          </Button>
        </div>
        {results && (
          <div className="flex max-h-[360px] flex-col gap-2 overflow-auto">
            {results.map((r) => {
              const d = devices.find((x) => x.serial === r.serial);
              return (
                <div key={r.serial} className="rounded-md border">
                  <div className="text-small flex justify-between border-b px-2.5 py-1.5">
                    <span className="font-medium">
                      {d ? deviceName(d) : r.serial}
                    </span>
                    <span className="text-muted-foreground font-mono">
                      {r.serial}
                    </span>
                  </div>
                  <pre
                    className={cn(
                      "selectable text-small max-h-40 overflow-auto px-2.5 py-2 font-mono whitespace-pre-wrap",
                      r.error && "text-error",
                    )}
                  >
                    {r.error ?? (r.output?.trimEnd() || t("multi.noOutput"))}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
