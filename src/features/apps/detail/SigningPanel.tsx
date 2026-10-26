import type { TFunction } from "i18next";
import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Certificate, Signer } from "../api";
import { formatDate } from "../format";
import { errorMessage, useAppSigning } from "../queries";
import { KeyValues, Panel } from "./Panel";

/** `3F:9A:12:…:C4:0B` — first three and last two bytes. */
export function shortFingerprint(sha: string) {
  const bytes = sha.split(":");
  if (bytes.length <= 6) return sha;
  return [...bytes.slice(0, 3), "…", ...bytes.slice(-2)].join(":");
}

/** `CN=Android Debug, O=Android` from the parsed name parts. */
function distinguished(cn: string | null, o: string | null, raw: string) {
  const parts = [cn && `CN=${cn}`, o && `O=${o}`].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : raw;
}

function Fingerprint({ sha }: { sha: string }) {
  const { t } = useTranslation("apps");
  const { t: tc } = useTranslation();
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="selectable truncate font-mono" title={sha}>
        {shortFingerprint(sha)}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t("signing.copySha")}
        onClick={() =>
          void navigator.clipboard
            .writeText(sha)
            .then(() => toast.success(tc("actions.copied")))
        }
      >
        <Copy />
      </Button>
    </span>
  );
}

function sdkRange(signer: Signer, t: TFunction<"apps">) {
  if (signer.minSdk === null) return null;
  return signer.maxSdk === null
    ? t("signing.sdkFrom", { min: signer.minSdk })
    : t("signing.sdkRange", { min: signer.minSdk, max: signer.maxSdk });
}

/** Signer certificate of the base APK (Signing card on AppDetail board). */
export function SigningPanel({ serial, pkg }: { serial: string; pkg: string }) {
  const { t, i18n } = useTranslation("apps");
  const signing = useAppSigning(serial, pkg);

  let body: ReactNode;
  if (signing.isPending) {
    body = (
      <div className="flex flex-col gap-2 px-3.5 py-3">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (signing.error) {
    body = (
      <div
        className="text-small text-muted-foreground px-3.5 py-3"
        title={errorMessage(signing.error)}
      >
        {t("signing.unavailable")}
      </div>
    );
  } else {
    const info = signing.data;
    const [main, ...older] = info.signers;
    const cert: Certificate | undefined = main?.certificate;
    const expired = cert ? cert.notAfter < Date.now() : false;
    const rows: [ReactNode, ReactNode][] = [
      [t("signing.scheme"), info.schemes.join(" + ") || "—"],
    ];
    if (cert) {
      rows.push(
        [t("signing.sha256"), <Fingerprint key="sha" sha={cert.sha256} />],
        [
          t("signing.issuer"),
          <span key="issuer" title={cert.issuer}>
            {distinguished(cert.issuerCn, cert.issuerO, cert.issuer)}
          </span>,
        ],
      );
      if (cert.subject !== cert.issuer) {
        rows.push([
          t("signing.subject"),
          <span key="subject" title={cert.subject}>
            {distinguished(cert.subjectCn, cert.subjectO, cert.subject)}
          </span>,
        ]);
      }
      rows.push(
        [
          t("signing.validUntil"),
          <span
            key="valid"
            className={cn("tabular-nums", expired && "text-error")}
            title={`${formatDate(cert.notBefore, i18n.language)} – ${formatDate(cert.notAfter, i18n.language)}`}
          >
            {expired
              ? t("signing.expired", {
                  date: formatDate(cert.notAfter, i18n.language),
                })
              : formatDate(cert.notAfter, i18n.language)}
          </span>,
        ],
        [t("signing.key"), cert.key ?? "—"],
      );
    }
    if (info.lineage.length > 1) {
      rows.push([
        t("signing.rotation"),
        <span
          key="rotation"
          title={info.lineage
            .map((c, i) => `${i + 1}. ${c.subject}\n   ${c.sha256}`)
            .join("\n")}
        >
          {t("signing.rotated", { count: info.lineage.length })}
        </span>,
      ]);
    }
    body = (
      <>
        {cert?.debug && (
          <div className="px-3.5 pt-3">
            <Badge variant="warning">
              <StatusDot tone="warning" />
              {t("signing.debug")}
            </Badge>
          </div>
        )}
        <KeyValues items={rows} />
        {older.map((s) => (
          <div
            key={s.certificate.sha256}
            className="text-small grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 border-t px-3.5 py-2"
          >
            <span className="text-muted-foreground">
              {s.schemes.join(" + ")}
            </span>
            <span className="flex min-w-0 flex-col">
              <Fingerprint sha={s.certificate.sha256} />
              <span className="text-muted-foreground truncate">
                {[
                  distinguished(
                    s.certificate.subjectCn,
                    s.certificate.subjectO,
                    s.certificate.subject,
                  ),
                  sdkRange(s, t),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          </div>
        ))}
      </>
    );
  }

  return <Panel title={t("signing.title")}>{body}</Panel>;
}
