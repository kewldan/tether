import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useDeviceName } from "@/features/devices/naming";
import { useDevices } from "@/features/devices/store";
import { adbKeyFingerprint } from "@/features/onboarding/api";
import { Steps } from "@/features/onboarding/parts";
import { Segmented } from "@/features/settings/Segmented";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type Brand = "pixel" | "samsung" | "xiaomi" | "other";

const BOLD = { b: <b className="text-foreground font-semibold" /> };

/** The phone's RSA fingerprint as Android shows it, shortened. */
function useFingerprint() {
  const { data } = useQuery({
    queryKey: ["adb-key-fingerprint"],
    queryFn: adbKeyFingerprint,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!data) return null;
  const parts = data.split(":");
  return {
    short: `${parts.slice(0, 3).join(":")}:…:${parts.slice(-2).join(":")}`,
    tail: parts.slice(-2).join(":"),
  };
}

/** The four illustrated steps; reused by Diagnostics' "Show me how". */
export function PhoneSteps({
  brand,
  highlight,
  compact = false,
}: {
  brand: Brand;
  /** Step to outline in brand color (1-based). */
  highlight?: number;
  compact?: boolean;
}) {
  const { t } = useTranslation("onboarding");
  const fp = useFingerprint();
  const steps: { art: ReactNode; title: string; text: ReactNode }[] = [
    {
      art: <AboutPhoneArt brand={brand} />,
      title: t("phone.step1.title"),
      text: <Trans t={t} i18nKey={`phone.step1.${brand}`} components={BOLD} />,
    },
    {
      art: <DevOptionsArt />,
      title: t("phone.step2.title"),
      text: <Trans t={t} i18nKey={`phone.step2.${brand}`} components={BOLD} />,
    },
    {
      art: <CableArt />,
      title: t("phone.step3.title"),
      text: t("phone.step3.text"),
    },
    {
      art: <PromptArt fingerprint={fp?.short ?? "5F:2A:9C:…:E1:07"} />,
      title: t("phone.step4.title"),
      text: (
        <>
          <Trans t={t} i18nKey="phone.step4.text" components={BOLD} />
          {fp && (
            <>
              {" "}
              <Trans
                t={t}
                i18nKey="phone.step4.fingerprint"
                values={{ tail: fp.tail }}
                components={{ m: <span className="font-mono" /> }}
              />
            </>
          )}
        </>
      ),
    },
  ];
  return (
    <ol className="grid grid-cols-4 gap-4">
      {steps.map((s, i) => (
        <li
          key={s.title}
          className={cn(
            "bg-card flex flex-col gap-4 rounded-xl border p-5",
            highlight === i + 1 && "border-brand",
          )}
        >
          {!compact && s.art}
          <div className="flex items-start gap-2.5">
            <span className="bg-brand/15 text-brand text-small flex size-6 flex-none items-center justify-center rounded-full font-bold">
              {i + 1}
            </span>
            <div>
              <div className="font-semibold">{s.title}</div>
              <div className="text-small text-secondary-foreground leading-[18px]">
                {s.text}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function BrandSwitch({
  value,
  onChange,
}: {
  value: Brand;
  onChange: (b: Brand) => void;
}) {
  const { t } = useTranslation("onboarding");
  return (
    <Segmented
      label={t("phone.brand")}
      value={value}
      onChange={onChange}
      options={(["pixel", "samsung", "xiaomi", "other"] as const).map((b) => ({
        value: b,
        label: t(`phone.brands.${b}`),
      }))}
    />
  );
}

/** Step 3 of onboarding: waits until a phone shows up. */
export function PhoneGuide({
  onFinish,
  onWifi,
  onDiagnose,
}: {
  onFinish: () => void;
  onWifi: () => void;
  onDiagnose: () => void;
}) {
  const { t } = useTranslation("onboarding");
  const [brand, setBrand] = useState<Brand>("pixel");
  const devices = useDevices((s) => s.devices);
  const ready = devices.find((d) => d.state.kind === "device") ?? null;
  const pending = devices.find(
    (d) => d.state.kind === "unauthorized" || d.state.kind === "authorizing",
  );
  const name = useDeviceName(ready);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-auto px-14 py-12">
      <Steps current={3} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] leading-8 font-semibold">
            {t("phone.title")}
          </h1>
          <p className="text-secondary-foreground mt-1 text-[14px]">
            {t("phone.subtitle")}
          </p>
        </div>
        <BrandSwitch value={brand} onChange={setBrand} />
      </div>

      <PhoneSteps brand={brand} highlight={pending ? 4 : undefined} />

      <div
        role="status"
        className={cn(
          "bg-card mt-auto flex items-center gap-4 rounded-xl border px-5 py-4",
          ready && "border-success",
        )}
      >
        {ready ? (
          <motion.span
            initial={{ scale: 0.6 }}
            animate={{ scale: 1 }}
            transition={spring.bouncy}
            className="bg-success/12 text-success flex size-6 items-center justify-center rounded-full"
          >
            <Check className="size-3.5" strokeWidth={2.6} />
          </motion.span>
        ) : (
          <span className="bg-brand ring-brand/15 size-2.5 rounded-full ring-4" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {ready
              ? t("phone.connected", { name })
              : pending
                ? t("phone.unauthorized")
                : t("phone.waiting")}
          </div>
          {!ready && (
            <div className="bg-selected mt-2 h-[3px] max-w-[360px] overflow-hidden rounded-full">
              <motion.div
                className="bg-primary h-full w-[30%] rounded-full"
                animate={{ x: ["-100%", "340%"] }}
                transition={{
                  duration: 1.6,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />
            </div>
          )}
        </div>
        {ready ? (
          <Button size="lg" autoFocus onClick={onFinish}>
            {t("phone.open")}
            <ArrowRight />
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onWifi}>
              {t("phone.wifi")}
            </Button>
            <Button variant="outline" onClick={onDiagnose}>
              {t("phone.cantSee")}
            </Button>
            <Button variant="ghost" onClick={onFinish}>
              {t("phone.skip")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// Illustrations: a 150×250 phone; colors are tokens so both themes work.

function Phone({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className="bg-foreground dark:bg-background ring-input mx-auto h-[250px] w-[150px] rounded-[22px] p-[7px] ring-1"
    >
      <div
        className={cn(
          "bg-secondary text-foreground relative flex h-full flex-col gap-1.5 overflow-hidden rounded-2xl px-2.5 pt-[22px] pb-2.5 text-[9px] leading-3",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

function Line({
  children,
  ring = false,
}: {
  children: ReactNode;
  ring?: boolean;
}) {
  return (
    <div
      className={cn(
        "bg-card flex h-[22px] items-center justify-between rounded-md px-[7px]",
        ring && "ring-brand ring-[1.5px]",
      )}
    >
      {children}
    </div>
  );
}

function Toggle({ on = false }: { on?: boolean }) {
  return (
    <span
      className={cn(
        "relative h-2.5 w-[18px] rounded-full",
        on ? "bg-primary" : "bg-input",
      )}
    >
      {on && (
        <span className="bg-primary-foreground absolute top-px right-px size-2 rounded-full" />
      )}
    </span>
  );
}

function AboutPhoneArt({ brand }: { brand: Brand }) {
  const { t } = useTranslation("onboarding");
  const model = {
    pixel: "Pixel 8 Pro",
    samsung: "Galaxy S23",
    xiaomi: "Redmi Note 12",
    other: "Android",
  }[brand];
  return (
    <Phone>
      <div className="mb-1 text-[11px] font-semibold">
        {t("phone.art.about")}
      </div>
      <Line>
        <span>{t("phone.art.model")}</span>
        <span className="opacity-60">{model}</span>
      </Line>
      <Line>
        <span>{t("phone.art.android")}</span>
        <span className="opacity-60">15</span>
      </Line>
      <Line ring>
        <span>
          {brand === "xiaomi" ? t("phone.art.miui") : t("phone.art.build")}
        </span>
        <span className="text-brand font-bold">×7</span>
      </Line>
      <div className="bg-foreground text-background mt-auto self-center rounded-[10px] px-[9px] py-[5px] text-[8.5px]">
        {t("phone.art.developer")}
      </div>
    </Phone>
  );
}

function DevOptionsArt() {
  const { t } = useTranslation("onboarding");
  return (
    <Phone>
      <div className="mb-1 text-[11px] font-semibold">{t("phone.art.dev")}</div>
      <Line>
        <span>{t("phone.art.awake")}</span>
        <Toggle />
      </Line>
      <Line ring>
        <span className="font-semibold">{t("phone.art.usbDebugging")}</span>
        <Toggle on />
      </Line>
      <Line>
        <span>{t("phone.art.wireless")}</span>
        <Toggle />
      </Line>
      <Line>
        <span>{t("phone.art.usbConfig")}</span>
        <span className="opacity-60">{t("phone.art.fileTransfer")}</span>
      </Line>
    </Phone>
  );
}

function CableArt() {
  return (
    <div aria-hidden className="flex h-[250px] items-center justify-center">
      <svg viewBox="0 0 200 220" className="h-[220px] w-[180px]" aria-hidden>
        <rect
          x="20"
          y="20"
          width="90"
          height="150"
          rx="16"
          className="fill-foreground dark:fill-background stroke-input"
        />
        <rect
          x="26"
          y="26"
          width="78"
          height="138"
          rx="11"
          className="fill-secondary"
        />
        <rect
          x="55"
          y="170"
          width="20"
          height="10"
          rx="2"
          className="fill-muted-foreground"
        />
        <path
          d="M65 180 C65 205 120 205 150 180 L150 120"
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          className="stroke-brand"
        />
        <rect
          x="132"
          y="70"
          width="46"
          height="54"
          rx="6"
          className="fill-card stroke-input"
        />
        <rect
          x="144"
          y="62"
          width="22"
          height="12"
          rx="2"
          className="fill-muted-foreground"
        />
        <text
          x="155"
          y="104"
          textAnchor="middle"
          fontSize="11"
          fontWeight="600"
          className="fill-secondary-foreground font-sans"
        >
          USB
        </text>
      </svg>
    </div>
  );
}

function PromptArt({ fingerprint }: { fingerprint: string }) {
  const { t } = useTranslation("onboarding");
  return (
    <Phone className="bg-background/55 justify-center">
      <div className="bg-card flex flex-col gap-1.5 rounded-xl p-2.5">
        <div className="text-[10px] font-semibold">{t("phone.art.allow")}</div>
        <div className="text-[8px] leading-[11px] opacity-70">
          {t("phone.art.rsa")}
          <br />
          <span className="font-mono">{fingerprint}</span>
        </div>
        <div className="flex items-center gap-1 text-[8px]">
          <span className="bg-primary size-2 rounded-[2px]" />
          {t("phone.art.always")}
        </div>
        <div className="text-brand flex justify-end gap-2.5 text-[9px] font-semibold">
          <span>{t("phone.art.cancel")}</span>
          <span className="ring-brand rounded-xs px-1 ring-[1.5px]">
            {t("phone.art.allowBtn")}
          </span>
        </div>
      </div>
    </Phone>
  );
}
