import { useTranslation } from "react-i18next";

import { ComingSoon } from "@/components/layout/ComingSoon";

export default function DiagnosticsPage() {
  const { t } = useTranslation();
  return <ComingSoon title={t("nav.diagnostics")} />;
}
