import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { useSettings } from "@/lib/settings";

// Every `src/locales/<lang>/<namespace>.json` becomes a namespace, so each
// feature owns its own file (`files.json`, `logcat.json`, …).
const modules = import.meta.glob<Record<string, unknown>>(
  "../locales/*/*.json",
  { eager: true, import: "default" },
);

const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, messages] of Object.entries(modules)) {
  const [, lang, ns] = path.match(/locales\/(\w+)\/([\w-]+)\.json$/) ?? [];
  if (!lang || !ns) continue;
  resources[lang] = { ...resources[lang], [ns]: messages };
}

function resolveLanguage(): "en" | "ru" {
  const preference = useSettings.getState().language;
  if (preference !== "system") return preference;
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage(),
  fallbackLng: "en",
  defaultNS: "common",
  interpolation: { escapeValue: false },
});

useSettings.subscribe((state, previous) => {
  if (state.language !== previous.language) {
    void i18n.changeLanguage(resolveLanguage());
  }
});

export default i18n;
