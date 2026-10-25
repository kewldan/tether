import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowDownToLine,
  Download,
  Package as PackageIcon,
  Pause,
  Play,
  RotateCw,
  ScrollText,
  Trash2,
  WrapText,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import {
  useDevices,
  useReadySerial,
  useSelectedDevice,
} from "@/features/devices/store";
import { spring } from "@/lib/motion";
import { hasMod, modKey } from "@/lib/platform";
import type { AppError } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { exportLogcat } from "./api";
import type { LogLine } from "./buffer";
import { Chip, LevelFilter, SearchBox } from "./components/FilterBar";
import { LineDetails } from "./components/LineDetails";
import { LogList } from "./components/LogList";
import { LOG_GRID } from "./components/LogRows";
import { BufferMenu, PresetMenu, SavePresetDialog } from "./components/Menus";
import { PackagePicker, TagPicker } from "./components/Pickers";
import {
  compileFilter,
  filterKey,
  isDefaultFilter,
  type PackageScope,
} from "./filter";
import {
  exportFileName,
  formatEntry,
  formatNumber,
  formatRows,
} from "./format";
import { logBuffer, logcat, useLogcatSession } from "./session";
import { useLogcatUi } from "./store";
import { contextRows, LogView } from "./view";

const CONTEXT_RADIUS = 50;

export default function LogcatPage() {
  const { t, i18n } = useTranslation("logcat");
  const device = useSelectedDevice();
  const selectedSerial = useDevices((s) => s.selectedSerial);
  const ready = useReadySerial();
  const { data: info } = useDeviceInfo(ready);
  const navigate = useNavigation((s) => s.navigate);
  const navPackage = useNavigation((s) => s.params.package);

  const filter = useLogcatUi((s) => s.filter);
  const buffers = useLogcatUi((s) => s.buffers);
  const wrap = useLogcatUi((s) => s.wrap);
  const presets = useLogcatUi((s) => s.presets);
  const setFilter = useLogcatUi((s) => s.setFilter);
  const resetFilter = useLogcatUi((s) => s.resetFilter);
  const applyPreset = useLogcatUi((s) => s.applyPreset);
  const setBuffers = useLogcatUi((s) => s.setBuffers);
  const toggleWrap = useLogcatUi((s) => s.toggleWrap);

  const status = useLogcatSession((s) => s.status);
  const error = useLogcatSession((s) => s.error);
  const rate = useLogcatSession((s) => s.rate);
  const version = useLogcatSession((s) => s.version);
  const crashCount = useLogcatSession((s) => s.crashCount);
  const sessionScope = useLogcatSession((s) => s.scope);
  const sessionSerial = useLogcatSession((s) => s.serial);
  const lastTime = useLogcatSession((s) => s.lastTime);

  const [paused, setPaused] = useState(false);
  const [following, setFollowing] = useState(true);
  const [selected, setSelected] = useState<LogLine | null>(null);
  const [contextId, setContextId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [saveOpen, setSaveOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<LogView | null>(null);
  viewRef.current ??= new LogView();
  const unfollowCount = useRef(0);

  // Stream the ready device; a reconnect resumes the same session.
  useEffect(() => {
    if (ready) logcat.connect(ready, buffers);
  }, [ready, buffers]);

  // Another device was picked: drop the previous device's stream and lines.
  // Read the live serial: the connect effect above may have just changed it.
  useEffect(() => {
    const current = useLogcatSession.getState().serial;
    if (current !== null && selectedSerial !== current) {
      logcat.reset();
      setSelected(null);
      setContextId(null);
    }
  }, [selectedSerial]);

  useEffect(() => {
    logcat.setPageVisible(true);
    return () => logcat.setPageVisible(false);
  }, []);

  useEffect(() => {
    if (navPackage) setFilter({ packageName: navPackage });
  }, [navPackage, setFilter]);

  const scopeSerial = ready ?? sessionSerial;
  useEffect(() => {
    logcat.setPackage(scopeSerial, filter.packageName);
  }, [scopeSerial, filter.packageName]);

  const scope = useMemo<PackageScope | null>(() => {
    if (!filter.packageName) return null;
    if (sessionScope?.name === filter.packageName) return sessionScope;
    return { name: filter.packageName, uid: null, pids: new Set() };
  }, [filter.packageName, sessionScope]);

  const compiled = useMemo(() => compileFilter(filter, scope), [filter, scope]);
  const key = useMemo(() => filterKey(filter, scope), [filter, scope]);

  // `version` is the trigger: the buffer is mutated outside React.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const snapshot = useMemo(() => {
    const view = viewRef.current as LogView;
    if (contextId !== null) {
      const rows = contextRows(logBuffer, contextId, CONTEXT_RADIUS);
      return { rows, pending: 0, matches: 0 };
    }
    let pending = 0;
    if (paused && !view.isStale(logBuffer, key)) {
      pending = view.countPending(logBuffer, compiled);
    } else {
      view.sync(logBuffer, compiled, key, filter.packageName);
    }
    return { rows: view.rows, pending, matches: view.matches };
  }, [version, compiled, key, paused, contextId]);
  const rows = snapshot.rows;

  const total = logBuffer.size;
  const newSinceUnfollow = following
    ? 0
    : Math.max(0, rows.length - unfollowCount.current);

  const changeFollowing = (next: boolean) => {
    if (!next) unfollowCount.current = rows.length;
    setFollowing(next);
  };

  const jumpToEnd = () => {
    setPaused(false);
    setContextId(null);
    setFollowing(true);
  };

  const copyText = (text: string, message: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(message),
      () => {},
    );
  };
  const copyLine = (line: LogLine) =>
    copyText(formatEntry(line), t("details.copied"));

  const clear = () => {
    const { undo, done } = logcat.clear();
    setSelected(null);
    setContextId(null);
    setCollapsed(new Set());
    setFollowing(true);
    done.then(
      () =>
        toast(t("toast.cleared"), {
          action: { label: t("toast.undo"), onClick: undo },
        }),
      (e: AppError) =>
        toast.error(t("toast.clearFailed"), {
          description: e.message,
          action: { label: t("toast.undo"), onClick: undo },
        }),
    );
  };

  const exportLog = async () => {
    const count = rows.filter((r) => r.kind === "line").length;
    try {
      const path = await exportLogcat(
        exportFileName(ready ?? sessionSerial ?? "device"),
        formatRows(rows),
      );
      toast.success(
        t("toast.exported", { count: formatNumber(count, i18n.language) }),
        {
          description: path,
          action: {
            label: t("toast.showInFolder"),
            onClick: () => void revealItemInDir(path).catch(() => {}),
          },
        },
      );
    } catch (e) {
      toast.error(t("toast.exportFailed"), {
        description: (e as AppError).message,
      });
    }
  };

  const includeTag = (tag: string) =>
    setFilter({
      includeTags: [...new Set([...filter.includeTags, tag])],
      excludeTags: filter.excludeTags.filter((x) => x !== tag),
    });
  const excludeTag = (tag: string) =>
    setFilter({
      excludeTags: [...new Set([...filter.excludeTags, tag])],
      includeTags: filter.includeTags.filter((x) => x !== tag),
    });

  const toggleCrash = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Keyboard: Space pause, ⌘L clear, ⌘F search, ⌘C copy line, ⌘1–9 presets.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest(
      "input, textarea, [contenteditable=true], [role=dialog]",
    );
    if (hasMod(e)) {
      const k = e.key.toLowerCase();
      if (k === "l") {
        e.preventDefault();
        clear();
      } else if (k === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (
        k === "c" &&
        selected &&
        !typing &&
        window.getSelection()?.isCollapsed !== false
      ) {
        e.preventDefault();
        copyLine(selected);
      } else if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
        const preset = presets[Number(e.key) - 1];
        if (preset) {
          e.preventDefault();
          applyPreset(preset.id);
        }
      }
      return;
    }
    if (typing) return;
    if (e.key === " " && !target?.closest("button, [role=menuitem]")) {
      e.preventDefault();
      setPaused((p) => !p);
    } else if (e.key === "Escape") {
      if (contextId !== null) setContextId(null);
      else setSelected(null);
    } else if (e.key === "End") {
      e.preventDefault();
      jumpToEnd();
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const name = device ? deviceName(device, info) : selectedSerial;
  // The selected device is gone or not usable (offline, unauthorized…).
  const disconnected = selectedSerial !== null && ready === null;
  const stateLabel =
    device && device.state.kind !== "offline"
      ? t(`state.${device.state.kind}`, { ns: "common" })
      : null;
  const hasLines = total > 0;
  const errors = logBuffer.counts.E + logBuffer.counts.F;
  const nf = (n: number) => formatNumber(n, i18n.language);

  const badge = (() => {
    if (!selectedSerial) return null;
    if (disconnected || status === "ended")
      return (
        <Badge>
          <StatusDot tone="neutral" />
          {t("status.stopped")}
        </Badge>
      );
    if (status === "error")
      return (
        <Badge variant="error">
          <StatusDot tone="error" />
          {t("status.error")}
        </Badge>
      );
    if (status === "connecting")
      return (
        <Badge>
          <StatusDot tone="info" />
          {t("status.connecting")}
        </Badge>
      );
    if (paused)
      return (
        <Badge variant="warning">
          <StatusDot tone="warning" />
          {t("status.paused", { count: nf(snapshot.pending) })}
        </Badge>
      );
    return (
      <Badge variant="success">
        <StatusDot tone="success" />
        {t("status.streaming", { rate: nf(rate) })}
      </Badge>
    );
  })();

  const pill = (() => {
    if (contextId !== null) return null;
    if (paused && snapshot.pending > 0)
      return t("actions.newLines", {
        count: snapshot.pending,
        formatted: nf(snapshot.pending),
      });
    if (!following && !paused)
      return newSinceUnfollow > 0
        ? t("actions.newLines", {
            count: newSinceUnfollow,
            formatted: nf(newSinceUnfollow),
          })
        : t("actions.jumpToEnd");
    return null;
  })();

  const contextLine =
    contextId !== null ? logBuffer.lines[logBuffer.indexOf(contextId)] : null;

  return (
    <Page
      title={
        <span className="flex items-center gap-1.5">
          {t("nav.logcat", { ns: "common" })}
          {badge && <span className="ml-1.5 flex">{badge}</span>}
        </span>
      }
      parent={
        name ? { label: name, onClick: () => navigate("overview") } : undefined
      }
      actions={
        <>
          <PresetMenu onSave={() => setSaveOpen(true)} />
          <BufferMenu
            buffers={buffers}
            onChange={(next) => {
              setBuffers(next);
              setSelected(null);
              setContextId(null);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void exportLog()}
            disabled={rows.length === 0}
          >
            <Download aria-hidden />
            {t("actions.export")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={clear}
            disabled={!selectedSerial}
          >
            <Trash2 aria-hidden />
            {t("actions.clear")}
            <Kbd>{modKey}L</Kbd>
          </Button>
        </>
      }
      toolbar={
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <SearchBox
            inputRef={searchRef}
            query={filter.query}
            regex={filter.regex}
            matchCase={filter.matchCase}
            highlight={filter.highlight}
            invalid={compiled.invalid}
            matches={filter.highlight ? snapshot.matches : rows.length}
            onChange={setFilter}
          />
          <LevelFilter
            levels={filter.levels}
            counts={logBuffer.counts}
            onChange={(levels) => setFilter({ levels })}
          />
          {filter.packageName ? (
            <Chip
              tone="brand"
              icon={<PackageIcon className="size-3 flex-none" aria-hidden />}
              label={t("package.follow", { name: filter.packageName })}
              title={
                scope && scope.pids.size > 0
                  ? t("package.followHint", {
                      name: filter.packageName,
                      pids: [...scope.pids].join(", "),
                    })
                  : undefined
              }
              removeLabel={t("package.remove")}
              onRemove={() => setFilter({ packageName: null })}
            />
          ) : (
            <PackagePicker
              serial={ready}
              onPick={(packageName) => setFilter({ packageName })}
            />
          )}
          {filter.onlyCrashes && (
            <Chip
              label={t("onlyCrashes")}
              removeLabel={t("removeOnlyCrashes")}
              onRemove={() => setFilter({ onlyCrashes: false })}
            />
          )}
          {filter.includeTags.map((tag) => (
            <Chip
              key={`+${tag}`}
              label={`+ ${tag}`}
              removeLabel={t("tags.removeInclude", { tag })}
              onRemove={() =>
                setFilter({
                  includeTags: filter.includeTags.filter((x) => x !== tag),
                })
              }
            />
          ))}
          {filter.excludeTags.map((tag) => (
            <Chip
              key={`-${tag}`}
              tone="muted"
              label={`− ${tag}`}
              removeLabel={t("tags.removeExclude", { tag })}
              onRemove={() =>
                setFilter({
                  excludeTags: filter.excludeTags.filter((x) => x !== tag),
                })
              }
            />
          ))}
          <TagPicker onInclude={includeTag} onExclude={excludeTag} />
          <span className="ml-auto" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("actions.wrap")}
            title={t("actions.wrap")}
            aria-pressed={wrap}
            onClick={toggleWrap}
            className={cn(wrap && "bg-selected text-foreground")}
          >
            <WrapText />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("actions.jumpToEnd")}
            title={t("actions.jumpToEnd")}
            onClick={jumpToEnd}
          >
            <ArrowDownToLine />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused((p) => !p)}
            disabled={contextId !== null}
          >
            {paused ? (
              <Play className="size-[13px]" aria-hidden />
            ) : (
              <Pause className="size-[13px]" aria-hidden />
            )}
            {paused ? t("actions.resume") : t("actions.pause")}
            <Kbd>Space</Kbd>
          </Button>
        </div>
      }
      body="fill"
    >
      {disconnected && (hasLines || status !== "idle") && (
        <div
          role="status"
          className="bg-error/13 flex flex-none items-center gap-3 border-b px-5 py-2.5"
        >
          <span className="bg-error size-2.5 flex-none rounded-full" />
          <p className="min-w-0 flex-1">
            <span className="font-semibold">
              {stateLabel
                ? t("disconnected.titleState", { name, state: stateLabel })
                : t("disconnected.title", { name })}
            </span>
            <span className="text-secondary-foreground">
              {lastTime
                ? t("disconnected.body", { time: lastTime.slice(11, 19) })
                : t("disconnected.bodyNoTime")}
            </span>
          </p>
        </div>
      )}
      {ready && (status === "error" || status === "ended") && (
        <div
          role="alert"
          className="bg-error/13 flex flex-none items-center gap-3 border-b px-5 py-2.5"
        >
          <span className="bg-error size-2.5 flex-none rounded-full" />
          <p className="min-w-0 flex-1 truncate">
            <span className="font-semibold">{t("errorBanner.title")}</span>
            <span className="text-secondary-foreground">
              {error
                ? t("errorBanner.body", { message: error.message })
                : t("errorBanner.ended")}
            </span>
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => logcat.connect(ready, buffers)}
          >
            <RotateCw aria-hidden />
            {t("actions.retry")}
          </Button>
        </div>
      )}
      {contextLine && (
        <div className="bg-brand/15 flex flex-none items-center gap-3 border-b px-5 py-2">
          <p className="min-w-0 flex-1 truncate">
            {t("context.banner", { time: contextLine.time })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setContextId(null)}
          >
            {t("context.back")}
          </Button>
        </div>
      )}
      <div
        className={cn("flex min-h-0 flex-1", disconnected && "saturate-[.4]")}
      >
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div
            className={cn(
              LOG_GRID,
              "text-muted-foreground text-caption h-7 flex-none items-center border-b font-medium",
            )}
          >
            <span>{t("columns.time")}</span>
            <span>{t("columns.pidTid")}</span>
            <span />
            <span>{t("columns.tag")}</span>
            <span className="flex min-w-0 items-center justify-between gap-3">
              {t("columns.message")}
              {hasLines && (
                <span className="num truncate font-normal">
                  {t("columns.summary", {
                    total: nf(total),
                    shown: nf(rows.length),
                  })}
                  {(crashCount > 0 || errors > 0) && " · "}
                  {crashCount > 0 && (
                    <span className="text-error">
                      {t("columns.crashes", {
                        count: crashCount,
                        formatted: nf(crashCount),
                      })}
                    </span>
                  )}
                  {crashCount > 0 && errors > 0 && " · "}
                  {errors > 0 &&
                    t("columns.errors", {
                      count: errors,
                      formatted: nf(errors),
                    })}
                </span>
              )}
            </span>
          </div>
          {rows.length > 0 ? (
            <LogList
              rows={rows}
              version={version + rows.length}
              wrap={wrap}
              matcher={compiled.matcher}
              selectedId={selected?.id ?? null}
              following={following && !paused && contextId === null}
              collapsed={collapsed}
              onlyCrashes={filter.onlyCrashes}
              onFollowingChange={changeFollowing}
              onSelect={setSelected}
              onToggleCrash={toggleCrash}
              onCopyCrash={(line) => copyText(line.message, t("crash.copied"))}
              onOnlyCrashes={() =>
                setFilter({ onlyCrashes: !filter.onlyCrashes })
              }
            />
          ) : (
            <EmptyState
              kind={
                !selectedSerial || (!ready && !hasLines)
                  ? "noDevice"
                  : hasLines
                    ? "noMatches"
                    : status === "ended" || status === "error"
                      ? "empty"
                      : "waiting"
              }
              total={nf(total)}
              canReset={!isDefaultFilter(filter)}
              onReset={resetFilter}
            />
          )}
          <AnimatePresence>
            {pill && (
              <motion.div
                key="pill"
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={spring.snappy}
                className="absolute bottom-3.5 left-1/2 -translate-x-1/2"
              >
                <Button
                  size="sm"
                  onClick={jumpToEnd}
                  className="h-[30px] rounded-full px-3.5 shadow-lg"
                >
                  <ArrowDown aria-hidden />
                  {pill}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {selected && (
          <LineDetails
            line={selected}
            scope={scope}
            onClose={() => setSelected(null)}
            onFilterTag={includeTag}
            onExcludeTag={excludeTag}
            onAround={(line) => {
              setContextId(line.id);
              setFollowing(false);
            }}
            onCopy={copyLine}
          />
        )}
      </div>
      <SavePresetDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        onSaved={(n) => toast.success(t("presets.saved", { name: n }))}
      />
    </Page>
  );
}

function EmptyState({
  kind,
  total,
  canReset,
  onReset,
}: {
  kind: "noDevice" | "noMatches" | "waiting" | "empty";
  total: string;
  canReset: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation("logcat");
  return (
    <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <ScrollText className="size-8" aria-hidden />
      {kind === "noDevice" && (
        <>
          <p className="text-foreground font-medium">{t("empty.noDevice")}</p>
          <p>{t("empty.noDeviceHint")}</p>
        </>
      )}
      {kind === "noMatches" && (
        <>
          <p className="text-foreground font-medium">{t("empty.noMatches")}</p>
          <p>{t("empty.noMatchesHint", { total })}</p>
          {canReset && (
            <Button variant="outline" size="sm" onClick={onReset}>
              {t("empty.resetFilters")}
            </Button>
          )}
        </>
      )}
      {(kind === "waiting" || kind === "empty") && <p>{t("empty.waiting")}</p>}
    </div>
  );
}
