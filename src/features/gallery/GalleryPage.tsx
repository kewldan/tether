import { useTranslation } from "react-i18next";

import { ComingSoon } from "@/components/layout/ComingSoon";

export default function GalleryPage() {
  const { t } = useTranslation();
  return <ComingSoon title={t("nav.gallery")} />;
}
