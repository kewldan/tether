import { useQuery } from "@tanstack/react-query";
import { Cpu, Play, TriangleAlert, Wifi } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { launchAvd, listAvds } from "@/features/devices/api";
import { useConnectSheet } from "@/features/devices/sheetStore";
import { useDevices } from "@/features/devices/store";
import type { AppError } from "@/lib/tauri";

/** 02 · No devices: shown instead of device pages until one connects. */
export function NoDevices() {
  const { t } = useTranslation("devices");
  const navigate = useNavigation((s) => s.navigate);
  const serverDown = useDevices((s) => s.error);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-7 overflow-auto p-10">
      <EmptyArt />
      <div className="max-w-[440px] text-center">
        <h1 className="text-title font-semibold">{t("empty.title")}</h1>
        <p className="text-secondary-foreground mt-1.5">{t("empty.text")}</p>
      </div>
      {serverDown && (
        <div
          role="alert"
          className="bg-warning/12 text-warning flex max-w-[440px] items-start gap-2.5 rounded-md px-3 py-2"
        >
          <TriangleAlert className="mt-0.5 size-4 flex-none" />
          <span className="text-foreground">{t("empty.serverDown")}</span>
        </div>
      )}
      <div className="flex gap-2.5">
        <Button size="lg" onClick={() => useConnectSheet.getState().show()}>
          <Wifi />
          {t("empty.wifi")}
        </Button>
        <Button
          size="lg"
          variant="outline"
          onClick={() => navigate("diagnostics")}
        >
          {t("empty.cantSee")}
        </Button>
      </div>
      <Emulators />
    </div>
  );
}

function Emulators() {
  const { t } = useTranslation("devices");
  const [launching, setLaunching] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["avds"],
    queryFn: listAvds,
    refetchInterval: launching ? 3000 : 15_000,
  });
  if (!data || data.avds.length === 0 || !data.canLaunch) return null;

  const launch = (name: string) => {
    setLaunching(name);
    launchAvd(name)
      .then(() => toast(t("empty.launching", { name })))
      .catch((e: AppError) => {
        setLaunching(null);
        toast.error(e.message);
      });
  };

  return (
    <div className="bg-card w-[440px] max-w-full overflow-hidden rounded-[10px] border">
      <div className="flex items-center justify-between border-b px-3.5 py-2.5">
        <span className="text-small font-semibold">{t("empty.emulators")}</span>
        <span className="text-small text-muted-foreground">
          {t("empty.fromAvd")}
        </span>
      </div>
      <ul className="divide-y">
        {data.avds.map((avd) => (
          <li key={avd.name} className="flex items-center gap-2.5 px-3.5 py-2">
            <Cpu className="text-secondary-foreground size-4" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {avd.displayName}
              {avd.api && (
                <span className="text-muted-foreground">
                  {" "}
                  · {t("empty.api", { api: avd.api })}
                </span>
              )}
            </span>
            {avd.running ? (
              <Badge variant="info">{t("empty.booting")}</Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={launching === avd.name}
                onClick={() => launch(avd.name)}
              >
                <Play className="size-3" />
                {launching === avd.name
                  ? t("empty.starting")
                  : t("empty.launch")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyArt() {
  return (
    <svg viewBox="0 0 320 180" className="h-[180px] w-[320px]" aria-hidden>
      <rect
        x="40"
        y="30"
        width="150"
        height="100"
        rx="10"
        strokeWidth="1.5"
        className="fill-card stroke-input"
      />
      <rect
        x="50"
        y="40"
        width="130"
        height="80"
        rx="4"
        className="fill-sidebar"
      />
      <rect
        x="95"
        y="130"
        width="40"
        height="8"
        rx="2"
        className="fill-input"
      />
      <rect
        x="75"
        y="138"
        width="80"
        height="6"
        rx="3"
        className="fill-input"
      />
      <path
        d="M190 100 C215 100 215 130 240 130"
        fill="none"
        strokeWidth="2"
        strokeDasharray="4 5"
        className="stroke-muted-foreground"
      />
      <rect
        x="234"
        y="58"
        width="50"
        height="94"
        rx="9"
        strokeWidth="1.5"
        className="fill-card stroke-brand"
      />
      <rect
        x="240"
        y="66"
        width="38"
        height="74"
        rx="4"
        className="fill-brand/15"
      />
      <circle
        cx="259"
        cy="103"
        r="10"
        fill="none"
        strokeWidth="1.5"
        className="stroke-brand"
      />
      <path
        d="M259 98v5l3 2"
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="stroke-brand"
      />
    </svg>
  );
}
