import { type MockHandlers, sleep } from "@/dev/mockBackend";
import type {
  IntentCommand,
  IntentKind,
  IntentResult,
  IntentSpec,
} from "@/features/intents/api";

const FLAG_BITS: Record<string, number> = {
  NEW_TASK: 0x10000000,
  CLEAR_TOP: 0x04000000,
  SINGLE_TOP: 0x20000000,
  CLEAR_TASK: 0x00008000,
  NO_HISTORY: 0x40000000,
  EXCLUDE_FROM_RECENTS: 0x00800000,
};

const EXTRA_FLAG: Record<string, string> = {
  string: "--es",
  int: "--ei",
  long: "--el",
  float: "--ef",
  double: "--ed",
  boolean: "--ez",
  uri: "--eu",
  component: "--ecn",
  string_array: "--esa",
  int_array: "--eia",
  long_array: "--ela",
  float_array: "--efa",
};

const quote = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

const invalid = (message: string) => {
  throw {
    kind: "invalid_input",
    message: `invalid input: ${message}`,
    hint: null,
  };
};

/** Simplified port of `device::intents::build_am_args`. */
function build(kind: IntentKind, spec: IntentSpec): string[] {
  if (!spec.action.trim() && !spec.data.trim() && !spec.component.trim()) {
    invalid("set at least an action, data URI or component");
  }
  const verb = {
    activity: "start",
    broadcast: "broadcast",
    service: "startservice",
    foreground_service: "start-foreground-service",
  }[kind];
  const args = ["am", verb];
  if (spec.action.trim()) args.push("-a", spec.action.trim());
  if (spec.data.trim()) args.push("-d", spec.data.trim());
  if (spec.mimeType.trim()) args.push("-t", spec.mimeType.trim());
  for (const c of spec.categories.filter((c) => c.trim())) args.push("-c", c);
  if (spec.component.trim()) {
    if (!spec.component.includes("/")) {
      invalid(`component must be package/class: "${spec.component}"`);
    }
    args.push("-n", spec.component.trim());
  }
  for (const e of spec.extras) {
    if (!e.key.trim()) invalid("extra key is empty");
    if (e.type === "null") {
      args.push("--esn", e.key);
      continue;
    }
    if (e.type === "int" && !/^-?\d+$/.test(e.value.trim())) {
      invalid(`extra ${e.key}: "${e.value}" is not a valid int`);
    }
    args.push(EXTRA_FLAG[e.type] ?? "--es", e.key, e.value);
  }
  const flags = spec.flags.reduce((acc, f) => acc | (FLAG_BITS[f] ?? 0), 0);
  if (flags) args.push("-f", `0x${flags.toString(16).padStart(8, "0")}`);
  return args;
}

const handlers: MockHandlers = {
  intent_command: ({ kind, spec, serial }): IntentCommand => {
    const device = build(kind as IntentKind, spec as IntentSpec)
      .map(quote)
      .join(" ");
    const escaped = device.replace(/["\\$`]/g, "\\$&");
    const target = serial ? `-s ${serial} ` : "";
    return { device, adb: `adb ${target}shell "${escaped}"` };
  },
  intent_send: async ({ kind, spec }): Promise<IntentResult> => {
    const k = kind as IntentKind;
    const s = spec as IntentSpec;
    build(k, s);
    await sleep(180);
    const base: IntentResult = {
      outcome: "ok",
      errorKind: null,
      message: null,
      activity: null,
      totalTimeMs: null,
      launchState: null,
      broadcastResult: null,
      exitCode: 0,
      raw: "",
    };
    if (k === "broadcast") {
      return {
        ...base,
        broadcastResult: 0,
        raw: `Broadcasting: Intent { act=${s.action} flg=0x400000 }\nBroadcast completed: result=0`,
      };
    }
    if (k !== "activity") {
      return {
        ...base,
        outcome: "error",
        errorKind: "not_found",
        message: "Not found; no service started.",
        exitCode: 255,
        raw: `Starting service: Intent { cmp=${s.component} }\nError: Not found; no service started.`,
      };
    }
    if (s.data.startsWith("exampleshop://orders")) {
      return {
        ...base,
        outcome: "error",
        errorKind: "unresolved",
        message: "Activity not started, unable to resolve Intent",
        exitCode: 1,
        raw: `Starting: Intent { act=${s.action} dat=${s.data} }\nError: Activity not started, unable to resolve Intent { act=${s.action} dat=${s.data} flg=0x10000000 }`,
      };
    }
    const activity =
      s.component ||
      (s.data.startsWith("http")
        ? "com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity"
        : "com.example.shop/.deeplink.DeepLinkActivity");
    return {
      ...base,
      activity,
      totalTimeMs: 182,
      launchState: "WARM",
      raw: `Starting: Intent { act=${s.action} dat=${s.data} }\nStatus: ok\nLaunchState: WARM\nActivity: ${activity}\nTotalTime: 182\nWaitTime: 190\nComplete`,
    };
  },
  input_text: ({ text }) => {
    if (/[^\x20-\x7e]/.test(text as string)) {
      invalid("`input text` can only type printable ASCII");
    }
    return null;
  },
  input_key: () => null,
};

export default handlers;
