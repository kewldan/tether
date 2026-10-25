import { useTranslation } from "react-i18next";

import { ComingSoon } from "@/components/layout/ComingSoon";

export default function AppsPage() {
  const { t } = useTranslation();
  return <ComingSoon title={t("nav.apps")} />;
}
