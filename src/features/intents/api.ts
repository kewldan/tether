import { invoke } from "@tauri-apps/api/core";

export type IntentKind =
  | "activity"
  | "broadcast"
  | "service"
  | "foreground_service";

export type ExtraType =
  | "string"
  | "int"
  | "long"
  | "float"
  | "double"
  | "boolean"
  | "uri"
  | "component"
  | "string_array"
  | "int_array"
  | "long_array"
  | "float_array"
  | "null";

export const EXTRA_TYPES: ExtraType[] = [
  "string",
  "int",
  "long",
  "float",
  "double",
  "boolean",
  "uri",
  "component",
  "string_array",
  "int_array",
  "long_array",
  "float_array",
  "null",
];

export interface Extra {
  key: string;
  type: ExtraType;
  value: string;
}

export interface IntentSpec {
  action: string;
  data: string;
  categories: string[];
  component: string;
  mimeType: string;
  /** Names without the FLAG_ACTIVITY_ prefix. */
  flags: string[];
  extras: Extra[];
}

export const FLAGS = [
  "NEW_TASK",
  "CLEAR_TOP",
  "SINGLE_TOP",
  "CLEAR_TASK",
  "NO_HISTORY",
  "EXCLUDE_FROM_RECENTS",
] as const;

export const EMPTY_SPEC: IntentSpec = {
  action: "",
  data: "",
  categories: [],
  component: "",
  mimeType: "",
  flags: [],
  extras: [],
};

export type Outcome = "ok" | "warning" | "error";

export interface IntentResult {
  outcome: Outcome;
  errorKind:
    | "unresolved"
    | "not_found"
    | "security"
    | "exception"
    | "failed"
    | null;
  message: string | null;
  activity: string | null;
  totalTimeMs: number | null;
  launchState: string | null;
  broadcastResult: number | null;
  exitCode: number | null;
  raw: string;
}

export interface IntentCommand {
  /** Command line for the device shell. */
  device: string;
  /** The same, wrapped as `adb -s … shell "…"` for a terminal. */
  adb: string;
}

export const sendIntent = (
  serial: string,
  kind: IntentKind,
  spec: IntentSpec,
) => invoke<IntentResult>("intent_send", { serial, kind, spec });

export const intentCommand = (
  kind: IntentKind,
  spec: IntentSpec,
  serial: string | null,
) => invoke<IntentCommand>("intent_command", { kind, spec, serial });

export const inputText = (serial: string, text: string) =>
  invoke<void>("input_text", { serial, text });

export const inputKey = (serial: string, key: string) =>
  invoke<void>("input_key", { serial, key });

/** A deep link is a VIEW intent with only a data URI. */
export function deepLinkSpec(uri: string): IntentSpec {
  return {
    ...EMPTY_SPEC,
    action: "android.intent.action.VIEW",
    data: uri.trim(),
  };
}

/** `com.example/.deeplink.DeepLinkActivity` → `DeepLinkActivity`. */
export function shortComponent(component: string): string {
  const cls = component.split("/").pop() ?? component;
  return cls.split(".").pop() || cls;
}

/** Short label for history rows. */
export function specLabel(kind: IntentKind, spec: IntentSpec): string {
  const main = spec.data || spec.action || spec.component;
  if (kind === "activity") return main;
  const prefix = kind === "broadcast" ? "broadcast" : "service";
  const target = spec.action || spec.component || spec.data;
  const short = target.length > 28 ? `…${target.slice(-24)}` : target;
  return `${prefix} ${short}`;
}
