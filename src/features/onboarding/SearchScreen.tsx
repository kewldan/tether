import { cn } from "cn";
import {
  ArrowRight,
  Check,
  Loader,
  Minus,
  MonitorSmartphone,
  Package,
  ScrollText,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AdbScan, LocationCheck } from "@/features/onboarding/api";
import { IconTile, PathBox, Steps, tildify } from "@/features/onboarding/parts";
import { spring } from "@/lib/motion";

const REVEAL_MS = 220;

/** Step 2 with the welcome panel: the animated list of checked places. */
export function SearchScreen({
  scan,
  onRevealed,
  onContinue,
  onChooseOther,
}: {
  scan: AdbScan | null;
  /** Called once every row has been revealed. */
  onRevealed: (scan: AdbScan) => void;
  onContinue: () => void;
  onChooseOther: () => void;
}) {
  const { t } = useTranslation("onboarding");
  const [revealed, setRevealed] = useState(0);
  const total = scan?.checks.length ?? 0;
  const done = scan !== null && revealed >= total;

  useEffect(() => {
    if (!scan) {
      setRevealed(0);
      return;
    }
    if (revealed >= scan.checks.length) {
      onRevealed(scan);
      return;
    }
    const timer = setTimeout(() => setRevealed((n) => n + 1), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [scan, revealed, onRevealed]);

  const install = done ? scan.install : null;

  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <Welcome />
      <section className="flex min-w-0 flex-[1_1_560px] flex-col justify-center gap-5 px-10 py-12 min-[1200px]:px-18">
        <div className="min-[1100px]:hidden">
          <Steps current={2} />
        </div>
        <div>
          <h2 className="text-title font-semibold">{t("search.title")}</h2>
          <p className="text-secondary-foreground mt-1">
            {t("search.subtitle")}
          </p>
        </div>
        <ul
          aria-live="polite"
          className="bg-card divide-y overflow-hidden rounded-xl border"
        >
          {scan === null ? (
            <CheckRow label={t("search.starting")} detail="" state="checking" />
          ) : (
            scan.checks.map((check, i) => (
              <CheckRow
                key={`${check.kind}-${check.paths[0] ?? i}`}
                {...describe(check, t)}
                state={
                  i < revealed
                    ? check.status
                    : i === revealed
                      ? "checking"
                      : "queued"
                }
              />
            ))
          )}
        </ul>
        <AnimatePresence>
          {install && (
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={spring.smooth}
              className="bg-card border-success flex flex-col gap-3.5 rounded-xl border p-[18px]"
            >
              <div className="flex items-center gap-3">
                <IconTile tone="success" size={32}>
                  <Check className="size-4" strokeWidth={2.4} />
                </IconTile>
                <div>
                  <div className="text-[14px] font-semibold">
                    {t("search.found")}
                  </div>
                  <div className="text-small text-muted-foreground">
                    {t("search.foundVersion")}{" "}
                    <span className="font-mono tabular-nums">
                      {install.version ?? "?"}
                    </span>
                  </div>
                </div>
              </div>
              <PathBox path={install.path} copyLabel={t("copyPath")} />
              <div className="flex items-center justify-between gap-3">
                <Button variant="link" className="px-0" onClick={onChooseOther}>
                  {t("search.useOther")}
                </Button>
                <Button size="lg" onClick={onContinue} autoFocus>
                  {t("search.continue")}
                  <ArrowRight />
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}

function Welcome() {
  const { t } = useTranslation("onboarding");
  const features = [
    { icon: MonitorSmartphone, key: "mirror" },
    { icon: ScrollText, key: "logcat" },
    { icon: Package, key: "many" },
  ] as const;
  return (
    <section className="bg-sidebar hidden flex-[1_1_520px] flex-col gap-7 border-r px-18 pt-18 pb-12 min-[1100px]:flex">
      <Steps current={2} />
      <div>
        <span className="bg-primary text-primary-foreground mb-7 flex size-16 items-center justify-center rounded-2xl">
          <svg
            viewBox="0 0 24 24"
            className="size-9"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="7" y="3" width="10" height="13" rx="2" />
            <path d="M12 16v2a3 3 0 0 0 3 3h4" />
            <circle cx="12" cy="12.5" r=".6" />
          </svg>
        </span>
        <h1 className="max-w-[460px] text-[34px] leading-10 font-bold tracking-[-0.025em]">
          {t("welcome.title")}
        </h1>
        <p className="text-secondary-foreground mt-4 max-w-[460px] text-[15px] leading-6">
          {t("welcome.subtitle")}
        </p>
      </div>
      <ul className="flex max-w-[460px] flex-col gap-3.5">
        {features.map(({ icon: Icon, key }) => (
          <li key={key} className="flex items-start gap-3">
            <IconTile size={28} className="text-brand">
              <Icon className="size-4" />
            </IconTile>
            <div>
              <div className="font-semibold">{t(`welcome.${key}.title`)}</div>
              <div className="text-secondary-foreground">
                {t(`welcome.${key}.text`)}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="text-small text-muted-foreground mt-auto">
        {t("welcome.footer")}
      </div>
    </section>
  );
}

type RowState = LocationCheck["status"] | "checking" | "queued";

function CheckRow({
  label,
  detail,
  state,
}: {
  label: string;
  detail: string;
  state: RowState;
}) {
  const { t } = useTranslation("onboarding");
  return (
    <li
      className={cn(
        "grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-[background-color,opacity] duration-300",
        state === "found" && "bg-success/12",
        state === "queued" && "opacity-55",
      )}
    >
      <span aria-hidden className="flex justify-center">
        {state === "found" && <Check className="text-success size-4" />}
        {state === "checking" && (
          <Loader className="text-brand size-4 animate-spin" />
        )}
        {(state === "missing" || state === "not_set") && (
          <Minus className="text-muted-foreground size-4" />
        )}
      </span>
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        {detail && (
          <div
            className="text-caption text-muted-foreground truncate font-mono"
            title={detail}
          >
            {detail}
          </div>
        )}
      </div>
      {state === "found" ? (
        <Badge variant="success">{t("search.status.found")}</Badge>
      ) : (
        <span className="text-small text-muted-foreground">
          {t(`search.status.${state}`)}
        </span>
      )}
    </li>
  );
}

/** Row label and detail line for one checked group of places. */
export function describe(
  check: LocationCheck,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { label: string; detail: string } {
  const label = t(`search.kind.${check.kind}`);
  if (check.found) return { label, detail: tildify(check.found) };
  if (check.status === "not_set") {
    return { label, detail: t(`search.notSet.${check.kind}`) };
  }
  if (check.kind === "path") return { label, detail: "which adb" };
  const dirs = check.paths.map((p) =>
    tildify(p.replace(/[\\/]adb(\.exe)?$/, "")),
  );
  return { label, detail: dirs.join(", ") };
}
