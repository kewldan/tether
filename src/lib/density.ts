import { useSettings } from "@/lib/settings";

/**
 * True in compact density. CSS follows `html[data-density]` through the
 * `h-row` / `h-ctl` tokens; this is for virtualized lists that need row
 * heights in JS.
 */
export function useCompact(): boolean {
  return useSettings((s) => s.density === "compact");
}
