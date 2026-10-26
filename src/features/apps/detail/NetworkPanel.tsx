import { RefreshCw } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { NetworkPeriod, NetworkUsage, Traffic } from "../api";
import { formatBytes, formatDate } from "../format";
import { errorMessage, useAppNetwork } from "../queries";
import { Panel } from "./Panel";

const PERIODS = ["today", "sinceBoot", "last30Days"] as const;
const NETWORKS = ["wifi", "mobile", "ethernet", "other"] as const;

const sum = (t: Traffic) => t.rx + t.tx;

function total(p: NetworkPeriod): Traffic {
  return NETWORKS.reduce(
    (acc, n) => ({ rx: acc.rx + p[n].rx, tx: acc.tx + p[n].tx }),
    { rx: 0, tx: 0 },
  );
}

function Cell({
  traffic,
  strong,
  detail,
}: {
  traffic: Traffic;
  strong?: boolean;
  detail?: boolean;
}) {
  const bytes = sum(traffic);
  return (
    <span
      className="flex flex-col items-end tabular-nums"
      title={`↓ ${formatBytes(traffic.rx)}  ↑ ${formatBytes(traffic.tx)}`}
    >
      <span
        className={cn(
          strong && "font-medium",
          bytes === 0 && "text-muted-foreground",
        )}
      >
        {bytes === 0 ? "—" : formatBytes(bytes)}
      </span>
      {detail && bytes > 0 && (
        <span className="text-caption text-muted-foreground flex flex-col items-end whitespace-nowrap">
          <span>↓ {formatBytes(traffic.rx)}</span>
          <span>↑ {formatBytes(traffic.tx)}</span>
        </span>
      )}
    </span>
  );
}

function UsageTable({ usage }: { usage: NetworkUsage }) {
  const { t, i18n } = useTranslation("apps");
  // Wi-Fi and mobile always; ethernet / other only when they carried data.
  const rows = NETWORKS.filter(
    (n) =>
      n === "wifi" || n === "mobile" || PERIODS.some((p) => sum(usage[p][n])),
  );
  const month = usage.last30Days;
  const monthTotal = sum(total(month));
  const bootTime = new Date(usage.boot).toLocaleString(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <>
      <div className="text-small grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,112px))] items-start gap-x-3 px-3.5 py-3">
        <span />
        {PERIODS.map((p) => (
          <span
            key={p}
            className="text-muted-foreground pb-1.5 text-right"
            title={p === "sinceBoot" ? bootTime : undefined}
          >
            {t(`network.${p}`)}
          </span>
        ))}
        {rows.map((n) => (
          <Fragment key={n}>
            <span className="py-1">{t(`network.${n}`)}</span>
            {PERIODS.map((p) => (
              <span key={p} className="py-1">
                <Cell traffic={usage[p][n]} />
              </span>
            ))}
          </Fragment>
        ))}
        <span className="mt-1 border-t pt-2 font-medium">
          {t("network.total")}
        </span>
        {PERIODS.map((p) => (
          <span key={p} className="mt-1 border-t pt-2">
            <Cell traffic={total(usage[p])} strong detail />
          </span>
        ))}
      </div>
      <div className="text-caption text-muted-foreground flex flex-col gap-1 border-t px-3.5 py-2.5">
        {monthTotal > 0 && (
          <span>
            {t("network.foreground", {
              share: Math.round((sum(month.foreground) / monthTotal) * 100),
            })}
          </span>
        )}
        {sum(month.vpn) > 0 && (
          <span>
            {t("network.vpn", { bytes: formatBytes(sum(month.vpn)) })}
          </span>
        )}
        <span>
          {usage.historyStart
            ? t("network.source", {
                date: formatDate(usage.historyStart, i18n.language),
              })
            : t("network.noHistory")}
        </span>
      </div>
    </>
  );
}

/** Per-app data usage from `dumpsys netstats` (no root needed). */
export function NetworkPanel({
  serial,
  pkg,
  uid,
}: {
  serial: string;
  pkg: string;
  uid: number | null;
}) {
  const { t } = useTranslation("apps");
  const network = useAppNetwork(serial, pkg, uid);

  let body: ReactNode;
  if (uid === null) {
    body = <Note>{t("network.noUid")}</Note>;
  } else if (network.isPending) {
    body = (
      <div className="flex flex-col gap-2 px-3.5 py-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (network.error) {
    body = (
      <Note>
        <span className="text-error">{errorMessage(network.error)}</span>
      </Note>
    );
  } else if (!network.data.supported) {
    body = <Note>{t("network.unsupported")}</Note>;
  } else {
    body = <UsageTable usage={network.data} />;
  }

  return (
    <Panel
      title={t("network.title")}
      aside={
        uid !== null && (
          <>
            <span className="text-muted-foreground font-normal tabular-nums">
              UID {uid}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("network.refresh")}
              disabled={network.isFetching}
              onClick={() => void network.refetch()}
            >
              <RefreshCw className={cn(network.isFetching && "animate-spin")} />
            </Button>
          </>
        )
      }
    >
      {body}
    </Panel>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="text-small text-muted-foreground px-3.5 py-3">
      {children}
    </div>
  );
}
