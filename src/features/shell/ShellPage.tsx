import { useTranslation } from "react-i18next";

import { ComingSoon } from "@/components/layout/ComingSoon";

export default function ShellPage() {
  const { t } = useTranslation();
  return <ComingSoon title={t("nav.shell")} />;
}
