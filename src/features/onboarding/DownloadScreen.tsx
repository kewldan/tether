import { AlertCircle, ArrowRight, Check, Loader } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  cancelDownload,
  downloadPlatformTools,
  ensureServer,
} from "@/features/onboarding/api";
import { IconTile, PathBox, tildify } from "@/features/onboarding/parts";
import { spring } from "@/lib/motion";
import type { AdbInstall, AppError } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Phase =
  | { phase: "downloading"; downloaded: number; total: number | null }
  | { phase: "extracting" }
  | { phase: "starting" }
  | { phase: "done"; install: AdbInstall; port: number }
  | { phase: "failed"; error: AppError };

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/**
 * Downloads platform-tools (the user already accepted the license on the
 * previous screen), then starts the adb server with them.
 */
export function DownloadScreen({
  onCancel,
  onReady,
  nextLabel,
}: {
  onCancel: () => void;
  onReady: (install: AdbInstall) => void;
  nextLabel: string;
}) {
  const { t } = useTranslation("onboarding");
  const [state, setState] = useState<Phase>({
    phase: "downloading",
    downloaded: 0,
    total: null,
  });
  const [attempt, setAttempt] = useState(0);
  const started = useRef(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [size, setSize] = useState<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the download
  useEffect(() => {
    let active = true;
    started.current = performance.now();
    setElapsed(null);
    setState({ phase: "downloading", downloaded: 0, total: null });
    downloadPlatformTools((event) => {
      if (!active) return;
      if (event.type === "downloading") {
        setState({ phase: "downloading", ...event });
        setSize(event.total ?? event.downloaded);
      } else {
        setElapsed((performance.now() - started.current) / 1000);
        setState({ phase: "extracting" });
      }
    })
      .then(async (install) => {
        if (!active) return;
        setState({ phase: "starting" });
        const port = 5037;
        await ensureServer().catch(() => undefined);
        if (active) setState({ phase: "done", install, port });
      })
      .catch((error: AppError) => {
        if (!active) return;
        if (error.kind === "cancelled") onCancel();
        else setState({ phase: "failed", error });
      });
    return () => {
      active = false;
    };
  }, [attempt, onCancel]);

  return (
    <div className="bg-sidebar flex min-h-0 flex-1 items-center justify-center overflow-auto p-10">
      {state.phase === "done" ? (
        <motion.div
          key="done"
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={spring.smooth}
          className="bg-card flex w-[460px] flex-col items-center gap-5 rounded-xl border p-7 text-center shadow-lg"
        >
          <motion.span
            initial={{ scale: 0.6 }}
            animate={{ scale: 1 }}
            transition={spring.bouncy}
          >
            <IconTile tone="success" size={56}>
              <Check className="size-7" strokeWidth={2.4} />
            </IconTile>
          </motion.span>
          <div>
            <div className="text-[18px] font-semibold">
              {t("download.ready")}
            </div>
            <p className="text-secondary-foreground mt-1">
              {t("download.readyText", {
                version: state.install.version?.split("-")[0] ?? "?",
                port: state.port,
              })}
            </p>
          </div>
          <PathBox
            path={tildify(state.install.path)}
            className="text-caption text-muted-foreground w-full text-left"
          />
          <Button
            size="lg"
            className="w-full"
            autoFocus
            onClick={() => onReady(state.install)}
          >
            {nextLabel}
            <ArrowRight />
          </Button>
        </motion.div>
      ) : (
        <div className="bg-card flex w-[460px] flex-col gap-5 rounded-xl border p-7 shadow-lg">
          <div>
            <div className="text-[18px] font-semibold">
              {t("download.title")}
            </div>
            <p className="text-secondary-foreground mt-0.5">
              {t("download.subtitle")}
            </p>
          </div>
          {state.phase === "failed" ? (
            <div
              role="alert"
              className="bg-error/13 text-error flex gap-2 rounded-md px-3 py-2"
            >
              <AlertCircle className="mt-0.5 size-4 flex-none" />
              <div className="min-w-0">
                <div className="break-words">{state.error.message}</div>
                {state.error.hint && (
                  <div className="text-secondary-foreground">
                    {state.error.hint}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ProgressBlock state={state} />
          )}
          <ol className="border-t">
            <StepRow
              label={t("download.steps.download")}
              status={stepStatus(state, 0)}
              meta={
                size !== null
                  ? `${mb(size)} MB${elapsed !== null ? ` · ${elapsed.toFixed(1)} s` : ""}`
                  : undefined
              }
            />
            <StepRow
              label={t("download.steps.extract")}
              status={stepStatus(state, 1)}
            />
            <StepRow
              label={t("download.steps.server")}
              status={stepStatus(state, 2)}
              meta="localhost:5037"
            />
          </ol>
          <div className="flex justify-end gap-2">
            {state.phase === "failed" ? (
              <>
                <Button variant="ghost" onClick={onCancel}>
                  {t("download.back")}
                </Button>
                <Button onClick={() => setAttempt((n) => n + 1)}>
                  {t("download.retry")}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                disabled={state.phase !== "downloading"}
                onClick={() => void cancelDownload()}
              >
                {t("download.cancel")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type StepStatus = "done" | "active" | "pending" | "failed";

function stepStatus(state: Phase, index: number): StepStatus {
  const order = { downloading: 0, extracting: 1, starting: 2, done: 3 };
  if (state.phase === "failed") return index === 0 ? "failed" : "pending";
  const current = order[state.phase];
  if (index < current) return "done";
  return index === current ? "active" : "pending";
}

function ProgressBlock({ state }: { state: Phase }) {
  const { t } = useTranslation("onboarding");
  let label = t("download.starting");
  let value: number | null = null;
  let meta = "";
  if (state.phase === "downloading") {
    label = t("download.downloading");
    if (state.total) {
      value = state.downloaded / state.total;
      meta = `${mb(state.downloaded)} / ${mb(state.total)} MB · ${Math.round(value * 100)}%`;
    } else {
      meta = `${mb(state.downloaded)} MB`;
    }
  } else if (state.phase === "extracting") {
    label = t("download.extracting");
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-small flex justify-between">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">{meta}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={value === null ? undefined : Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="bg-selected h-1.5 overflow-hidden rounded-full"
      >
        {value === null ? (
          <motion.div
            className="bg-primary h-full w-1/3 rounded-full"
            animate={{ x: ["-100%", "300%"] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : (
          <motion.div
            className="bg-primary h-full origin-left rounded-full"
            animate={{ scaleX: value }}
            transition={spring.smooth}
          />
        )}
      </div>
    </div>
  );
}

function StepRow({
  label,
  status,
  meta,
}: {
  label: string;
  status: StepStatus;
  meta?: string;
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 py-2.5",
        status === "pending" && "opacity-50",
      )}
    >
      <span aria-hidden className="flex justify-center">
        {status === "done" && <Check className="text-success size-4" />}
        {status === "active" && (
          <Loader className="text-brand size-4 animate-spin" />
        )}
        {status === "failed" && <AlertCircle className="text-error size-4" />}
        {status === "pending" && (
          <span className="bg-muted-foreground size-1.5 rounded-full" />
        )}
      </span>
      <span className={cn(status === "active" && "font-medium")}>{label}</span>
      <span className="text-small text-muted-foreground font-mono tabular-nums">
        {status !== "pending" ? meta : ""}
      </span>
    </li>
  );
}
