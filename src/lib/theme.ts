import { useEffect, useSyncExternalStore } from "react";

import { useSettings } from "@/lib/settings";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function subscribe(onChange: () => void) {
  darkQuery.addEventListener("change", onChange);
  return () => darkQuery.removeEventListener("change", onChange);
}

/** The theme actually shown, after resolving "system". */
export function useResolvedTheme(): "dark" | "light" {
  const preference = useSettings((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribe, () => darkQuery.matches);
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** Keeps the `dark` class on <html> in sync with the preference. */
export function useApplyTheme() {
  const theme = useResolvedTheme();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
}
