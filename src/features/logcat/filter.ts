import { LEVELS, type Level } from "./api";
import type { LogLine } from "./buffer";

/** Everything that decides which lines are shown. Persisted and saved in presets. */
export interface LogFilter {
  query: string;
  regex: boolean;
  matchCase: boolean;
  /** Highlight matches but keep other lines visible. */
  highlight: boolean;
  levels: Record<Level, boolean>;
  includeTags: string[];
  excludeTags: string[];
  packageName: string | null;
  onlyCrashes: boolean;
}

export const ALL_LEVELS: Record<Level, boolean> = {
  V: true,
  D: true,
  I: true,
  W: true,
  E: true,
  F: true,
};

export const DEFAULT_FILTER: LogFilter = {
  query: "",
  regex: false,
  matchCase: false,
  highlight: false,
  levels: ALL_LEVELS,
  includeTags: [],
  excludeTags: [],
  packageName: null,
  onlyCrashes: false,
};

/** Where the filtered package runs; updated as it restarts. */
export interface PackageScope {
  name: string;
  uid: number | null;
  pids: ReadonlySet<number>;
}

export type Range = [start: number, end: number];

/** Finds search matches in a string. */
export interface Matcher {
  test(text: string): boolean;
  ranges(text: string): Range[];
}

export interface CompiledFilter {
  /** Applies every filter except the search when highlighting. */
  test(line: LogLine): boolean;
  matcher: Matcher | null;
  /** The regex did not compile. */
  invalid: boolean;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildMatcher(
  query: string,
  regex: boolean,
  matchCase: boolean,
): Matcher | null | "invalid" {
  if (!query) return null;
  let re: RegExp;
  try {
    re = new RegExp(regex ? query : escapeRegex(query), matchCase ? "g" : "gi");
  } catch {
    return "invalid";
  }
  // A non-global copy for `test`, which must not carry `lastIndex`.
  const probe = new RegExp(re.source, matchCase ? "" : "i");
  return {
    test: (text) => probe.test(text),
    ranges: (text) => {
      const out: Range[] = [];
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        out.push([m.index, m.index + m[0].length]);
        if (out.length > 200) break;
      }
      return out;
    },
  };
}

/** True when a line belongs to the filtered package. */
export function inPackage(line: LogLine, scope: PackageScope): boolean {
  if (scope.pids.has(line.pid)) return true;
  // App uids are unique per package; system uids (< 10000) are shared, so
  // those apps are matched by pid only.
  if (scope.uid !== null && scope.uid >= 10_000 && line.uid === `${scope.uid}`)
    return true;
  const proc = line.processEvent?.process ?? line.crash?.process;
  return (
    proc !== undefined &&
    proc !== null &&
    (proc === scope.name || proc.startsWith(`${scope.name}:`))
  );
}

export function compileFilter(
  filter: LogFilter,
  scope: PackageScope | null,
): CompiledFilter {
  const m = buildMatcher(filter.query, filter.regex, filter.matchCase);
  const matcher = m === "invalid" ? null : m;
  const searchFilters = matcher !== null && !filter.highlight;
  const levels = filter.levels;
  const include = new Set(filter.includeTags);
  const exclude = new Set(filter.excludeTags);
  const allLevels = LEVELS.every((l) => levels[l]);

  return {
    matcher,
    invalid: m === "invalid",
    test(line) {
      if (filter.onlyCrashes && !line.crash) return false;
      if (!allLevels && !levels[line.level]) return false;
      if (include.size > 0 && !include.has(line.tag)) return false;
      if (exclude.has(line.tag)) return false;
      if (scope && !inPackage(line, scope)) return false;
      if (
        searchFilters &&
        !matcher.test(line.message) &&
        !matcher.test(line.tag)
      )
        return false;
      return true;
    },
  };
}

/** Stable key of the parts of a filter that change which lines match. */
export function filterKey(filter: LogFilter, scope: PackageScope | null) {
  return JSON.stringify([
    filter.query,
    filter.regex,
    filter.matchCase,
    filter.highlight,
    filter.levels,
    filter.includeTags,
    filter.excludeTags,
    filter.onlyCrashes,
    scope ? [scope.name, scope.uid, [...scope.pids].sort()] : null,
  ]);
}

/** True when nothing narrows the view. */
export function isDefaultFilter(filter: LogFilter) {
  return (
    !filter.query &&
    LEVELS.every((l) => filter.levels[l]) &&
    filter.includeTags.length === 0 &&
    filter.excludeTags.length === 0 &&
    filter.packageName === null &&
    !filter.onlyCrashes
  );
}
