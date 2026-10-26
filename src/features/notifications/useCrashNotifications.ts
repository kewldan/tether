import { useEffect } from "react";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { useDevices } from "@/features/devices/store";
import type { LogEntry } from "@/features/logcat/api";
import { logBuffer, useLogcatSession } from "@/features/logcat/session";
import i18n from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { crashWatch } from "./api";
import type { CrashReport } from "./crashes";
import {
  type CrashGroup,
  CrashThrottle,
  crashKey,
  packageOf,
  SeenCrashes,
} from "./crashes";
import { isWindowFocused } from "./focus";
import { deliver, follow, type Route } from "./notify";
import { showCrashToast } from "./toasts";

/**
 * A fresh stream first replays the device's backlog (up to 5000 lines);
 * crashes in it are old news. Lines arriving this soon after a (re)start
 * are not announced.
 */
const BACKLOG_GRACE_MS = 4000;
/** Crashes this close together become one notice. */
const BURST_MS = 1500;
/** More apps than this in one burst become one grouped notice. */
const GROUP_OVER = 2;

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, { ns: "notifications", ...options });

function copyTrace(trace: string) {
  void navigator.clipboard
    .writeText(trace)
    .then(() => toast.success(t("crash.copied")))
    .catch(() => {});
}

function announceGroup(group: CrashGroup) {
  const first = group.reports[0];
  const app = group.app ?? t("crash.unknownApp");
  const count = group.reports.length;
  const title =
    first.kind === "anr"
      ? t("crash.anr", { app })
      : count > 1
        ? t("crash.crashedTimes", { app, count })
        : t("crash.crashed", { app });
  const route: Route = {
    kind: "logcat",
    serial: first.serial,
    package: group.app,
  };
  deliver({
    toast: () =>
      showCrashToast({
        title,
        detail: first.title,
        open: { label: t("crash.openLogcat"), onClick: () => follow(route) },
        copy: {
          label: t("crash.copyTrace"),
          onClick: () => copyTrace(first.trace),
        },
      }),
    system: { title, body: first.title, route, crash: true },
    replayOnFocus: true,
  });
}

function announce(groups: CrashGroup[]) {
  if (groups.length <= GROUP_OVER) {
    for (const group of groups) announceGroup(group);
    return;
  }
  const title = t("crash.many", { count: groups.length });
  const body = groups.map((g) => g.app ?? t("crash.unknownApp")).join(", ");
  const route: Route = {
    kind: "logcat",
    serial: groups[0].reports[0].serial,
    package: null,
  };
  deliver({
    toast: () =>
      showCrashToast({
        title,
        detail: body,
        open: { label: t("crash.openLogcat"), onClick: () => follow(route) },
        copy: null,
      }),
    system: { title, body, route, crash: true },
    replayOnFocus: true,
  });
}

/** Serials of the devices ready for adb, sorted. */
function readySerials(): string[] {
  return useDevices
    .getState()
    .devices.filter((d) => d.state.kind === "device")
    .map((d) => d.serial)
    .sort();
}

/** True while the Logcat page shows `serial` to the user. */
function logcatShows(serial: string) {
  return (
    useNavigation.getState().section === "logcat" &&
    isWindowFocused() &&
    useLogcatSession.getState().serial === serial
  );
}

/**
 * Announces new crashes and ANRs, grouped per burst and throttled per app.
 * Two sources feed it: a background crash watcher on every ready device
 * (crash and ANR lines only, started and stopped with the device), and the
 * Logcat page's stream (it keeps running after leaving the page). A crash
 * both see is announced once. Quiet for the device the Logcat page itself
 * shows while it's in front of the user.
 */
export function useCrashNotifications() {
  useEffect(() => {
    const throttle = new CrashThrottle();
    const seen = new SeenCrashes();
    let lastId = logBuffer.last?.id ?? -1;
    let armedAt = 0;
    let burst: CrashReport[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const reports = burst.filter((r) => !logcatShows(r.serial));
      burst = [];
      if (!useSettings.getState().notifyCrashes) return;
      const groups = throttle.take(reports, Date.now());
      if (groups.length > 0) announce(groups);
    };

    const take = (serial: string, entry: LogEntry) => {
      const crash = entry.crash;
      if (!crash || !seen.add(crashKey(serial, entry))) return;
      burst.push({
        serial,
        app: packageOf(crash.process),
        kind: crash.kind,
        title: crash.title,
        trace: entry.message,
      });
      if (timer === null) timer = setTimeout(flush, BURST_MS);
    };

    const stopSession = useLogcatSession.subscribe((state, prev) => {
      if (state.status === "connecting" && prev.status !== "connecting")
        armedAt = Date.now() + BACKLOG_GRACE_MS;
      if (state.version === prev.version) return;

      const lines = logBuffer.lines;
      const start = logBuffer.indexAfter(lastId);
      const last = logBuffer.last;
      if (last && last.id > lastId) lastId = last.id;
      // Backlog crashes are not marked seen: a new one arriving meanwhile
      // still comes through the watcher.
      if (Date.now() < armedAt || !state.serial) return;

      for (let i = start; i < lines.length; i++) take(state.serial, lines[i]);
    });

    // Watchers follow the ready devices and the setting; off means none run.
    let watched = "";
    const syncWatchers = () => {
      const serials = useSettings.getState().notifyCrashes
        ? readySerials()
        : [];
      const key = serials.join();
      if (key === watched) return;
      watched = key;
      void crashWatch(serials, (alert) =>
        take(alert.serial, alert.entry),
      ).catch(() => {
        watched = "";
      });
    };
    syncWatchers();
    const stopDevices = useDevices.subscribe(syncWatchers);
    const stopSettings = useSettings.subscribe(syncWatchers);

    return () => {
      stopSession();
      stopDevices();
      stopSettings();
      void crashWatch([], () => {}).catch(() => {});
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
