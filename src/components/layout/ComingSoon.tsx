import { Construction } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Page } from "@/components/layout/Page";

/** Temporary page body for sections that are not built yet. */
export function ComingSoon({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <Page title={title}>
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-center">
        <Construction className="size-8" aria-hidden />
        <p>{t("comingSoon")}</p>
      </div>
    </Page>
  );
}
