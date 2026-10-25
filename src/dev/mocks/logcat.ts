import { channel, type MockHandlers } from "@/dev/mockBackend";
import type {
  Level,
  LogcatEvent,
  LogEntry,
  Package,
} from "@/features/logcat/api";

// Lines modelled on docs/design/project/Logcat.dc.html and real emulator
// output; a fake com.example.shop crashes and restarts every ~25 s.

const APP = "com.example.shop";
const APP_UID = "10312";

type Template = [uid: string, level: Level, tag: string, message: string];

const SYSTEM: Template[] = [
  ["1000", "D", "WifiScoreCard", "txRate: 1 txSpeed: 6"],
  [
    "1000",
    "D",
    "WifiClientModeImpl[8335:wlan0]",
    'ClientModeImpl$L2ConnectedState screen=on 1 0 "AndroidWifi" rssi=-50 f=2437 sc=83 link=6',
  ],
  [
    "1000",
    "V",
    "WindowManager",
    "Sent Transition (#39) createdAt=22:41:06.143",
  ],
  [
    "1000",
    "I",
    "ActivityTaskManager",
    "Displayed com.android.settings/.Settings for user 0: +412ms",
  ],
  [
    "10155",
    "I",
    "NetworkScheduler.Stats",
    "Task com.google.android.gms/.tapandpay.gcmtask.TapAndPayGcmTaskService started execution. cause:4",
  ],
  [
    "10191",
    "V",
    "WindowManagerShell",
    "Transition requested (#40): android.os.BinderProxy@7fa89e8 type = CLOSE",
  ],
  ["root", "D", "Zygote", "Forked child process 7763"],
  [
    "10169",
    "W",
    "chromium",
    "[WARNING:viz_main_impl.cc(85)] VizNullHypothesis is disabled (not a warning)",
  ],
  [
    "10169",
    "I",
    "chromium",
    '[INFO:CONSOLE(1)] "Uncaught (in promise) AbortError", source: https://m.example.com/ (1)',
  ],
  ["1000", "E", "BpTransactionCompletedListener", "Failed to transact (-32)"],
  [
    "10176",
    "I",
    "GoogleInputMethodService",
    "GoogleInputMethodService.onStartInput():1318 onStartInput(EditorInfo{inputType=0})",
  ],
  [
    "1000",
    "W",
    "ProcessStats",
    "Tracking association SourceState{b7b3de com.google.android.gms/10155 BTop #3552} whose proc state 2 is better than process",
  ],
  [
    "1000",
    "D",
    "ConnectivityService",
    "requestNetwork for uid/pid:10155/1282 activeRequest: null callbackRequest: 269",
  ],
  [
    "logd",
    "I",
    "logd",
    "logdr: UID=2000 GID=2000 PID=7619 n tail=500 logMask=99 pid=0 start=0ns deadline=0ns",
  ],
];

const APP_LINES: [Level, string, string][] = [
  [
    "D",
    "ShopApp",
    "onCreate() buildType=debug flavor=staging versionCode=2140",
  ],
  ["V", "FeatureFlags", 'Loaded 42 flags from remote config (etag "a9f3")'],
  ["D", "OkHttp", "--> GET https://api.example.shop/v2/catalog?page=1"],
  [
    "D",
    "OkHttp",
    "<-- 200 OK https://api.example.shop/v2/catalog?page=1 (110ms, 48.2kB body)",
  ],
  [
    "I",
    "Choreographer",
    "Skipped 31 frames!  The application may be doing too much work on its main thread.",
  ],
  ["D", "OkHttp", "--> GET https://api.example.shop/v2/cart"],
  ["V", "Glide", "Memory cache hit for key 7f2a…c91 (240x240)"],
  [
    "W",
    "OkHttp",
    "<-- HTTP FAILED: java.net.SocketTimeoutException: timeout (cart) Error(Timeout)",
  ],
  [
    "D",
    "OkHttp",
    "<-- 200 OK https://api.example.shop/v2/cart Content(items=3, total=12 730 ₽)",
  ],
  ["V", "Glide", "Decoded 1080x1080 in 18ms"],
  [
    "E",
    "ImageDecoder",
    "Failed to decode https://cdn.example.shop/img/sku-4410.webp: unsupported format",
  ],
  ["I", "ShopApp", "Analytics: screen_view cart (items=3)"],
  [
    "D",
    "OkHttp",
    "--> POST https://api.example.shop/v2/cart/items (64-byte body)",
  ],
  [
    "D",
    "OkHttp",
    '{"sku":"4410","qty":1,"source":"cart_upsell"}\n--> END POST (64-byte body)',
  ],
];

const STACK = `FATAL EXCEPTION: main
Process: ${APP}, PID: {pid}
java.lang.IllegalStateException: Cart must not be null
\tat com.example.shop.cart.CartViewModel.requireCart(CartViewModel.kt:87)
\tat com.example.shop.cart.CartFragment.render(CartFragment.kt:142)
\tat com.example.shop.cart.CartFragment.onViewCreated$lambda$3(CartFragment.kt:61)
\tat androidx.lifecycle.Observer.onChanged(Observer.kt:20)
\tat android.os.Handler.handleCallback(Handler.java:959)
\tat android.os.Looper.loop(Looper.java:317)
\tat android.app.ActivityThread.main(ActivityThread.java:8705)
\tat java.lang.reflect.Method.invoke(Native Method)
\tat com.android.internal.os.RuntimeInit$MethodAndArgsCaller.run(RuntimeInit.java:566)`;

let clock = Date.now() - 120_000;
let appPid = 4821;
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const sysPids: Record<string, number> = {
  "1000": 1534,
  "10155": 1282,
  "10191": 1011,
  root: 524,
  "10169": 7928,
  "10176": 1582,
  logd: 242,
};

function stamp(): Pick<LogEntry, "date" | "time"> {
  clock += 1 + Math.floor(Math.random() * 6);
  const d = new Date(clock);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
      d.getMilliseconds(),
      3,
    )}`,
  };
}

function entry(
  seq: number,
  uid: string,
  pid: number,
  level: Level,
  tag: string,
  message: string,
  extra: Partial<LogEntry> = {},
): LogEntry {
  const tid =
    Math.random() < 0.6 ? pid : pid + 1 + Math.floor(Math.random() * 60);
  return { seq, ...stamp(), uid, pid, tid, level, tag, message, ...extra };
}

function noise(seq: number): LogEntry {
  if (Math.random() < 0.3) {
    const [level, tag, message] = pick(APP_LINES);
    return entry(seq, APP_UID, appPid, level, tag, message);
  }
  const [uid, level, tag, message] = pick(SYSTEM);
  return entry(seq, uid, sysPids[uid] ?? 1534, level, tag, message);
}

/** Crash, death and restart of the app, as ActivityManager reports them. */
function crashSequence(seq: number): LogEntry[] {
  const old = appPid;
  appPid = old + 200 + Math.floor(Math.random() * 300);
  const out: LogEntry[] = [
    entry(seq, APP_UID, old, "D", "AndroidRuntime", "Shutting down VM"),
    entry(
      seq + 1,
      APP_UID,
      old,
      "E",
      "AndroidRuntime",
      STACK.replace("{pid}", String(old)),
      {
        crash: {
          kind: "java",
          title: "java.lang.IllegalStateException: Cart must not be null",
          process: APP,
          pid: old,
        },
      },
    ),
    entry(
      seq + 2,
      "1000",
      1534,
      "W",
      "ActivityTaskManager",
      `  Force finishing activity ${APP}/.MainActivity`,
    ),
    entry(
      seq + 3,
      APP_UID,
      old,
      "I",
      "Process",
      `Sending signal. PID: ${old} SIG: 9`,
    ),
    entry(
      seq + 4,
      "1000",
      1534,
      "I",
      "ActivityManager",
      `Process ${APP} (pid ${old}) has died: fg  TOP `,
      {
        processEvent: { kind: "died", pid: old, process: APP },
      },
    ),
    entry(
      seq + 5,
      "root",
      524,
      "D",
      "Zygote",
      `Forked child process ${appPid}`,
    ),
    entry(
      seq + 6,
      "1000",
      1534,
      "I",
      "ActivityManager",
      `Start proc ${appPid}:${APP}/u0a312 for top-activity {${APP}/.MainActivity}`,
      { processEvent: { kind: "started", pid: appPid, process: APP } },
    ),
    entry(
      seq + 7,
      APP_UID,
      appPid,
      "D",
      "ShopApp",
      "onCreate() buildType=debug flavor=staging versionCode=2140",
    ),
  ];
  return out;
}

interface MockSession {
  timer: ReturnType<typeof setInterval>;
}
const sessions = new Map<number, MockSession>();
let nextSession = 1;

const PACKAGES: Package[] = [
  { name: APP, uid: 10312, thirdParty: true },
  { name: "com.example.shop.debug", uid: 10313, thirdParty: true },
  { name: "org.telegram.messenger", uid: 10224, thirdParty: true },
  { name: "com.whatsapp", uid: 10225, thirdParty: true },
  { name: "android", uid: 1000, thirdParty: false },
  { name: "com.android.settings", uid: 1000, thirdParty: false },
  { name: "com.android.systemui", uid: 10191, thirdParty: false },
  { name: "com.google.android.gms", uid: 10155, thirdParty: false },
  { name: "com.google.android.youtube", uid: 10169, thirdParty: false },
];

const handlers: MockHandlers = {
  logcat_start: ({ onEvent, options }) => {
    const send = channel<LogcatEvent>(onEvent);
    const { tail } = (options ?? {}) as { tail?: number | null };
    let seq = 0;
    const id = nextSession++;

    // Backlog in chunks, like the real stream.
    const backlog: LogEntry[] = [];
    const count = Math.min(tail ?? 0, 3000);
    for (let i = 0; i < count; i++) {
      if (i === Math.floor(count * 0.7)) {
        const crash = crashSequence(seq);
        backlog.push(...crash);
        seq += crash.length;
      } else backlog.push(noise(seq++));
    }
    for (let i = 0; i < backlog.length; i += 2000)
      setTimeout(
        () => send({ type: "batch", entries: backlog.slice(i, i + 2000) }),
        80 + i / 50,
      );

    clock = Date.now();
    let tick = 0;
    const timer = setInterval(() => {
      tick++;
      const entries: LogEntry[] = [];
      const n = 20 + Math.floor(Math.random() * 50);
      for (let i = 0; i < n; i++) entries.push(noise(seq++));
      if (tick % 500 === 0) {
        const crash = crashSequence(seq);
        entries.push(...crash);
        seq += crash.length;
      }
      send({ type: "batch", entries });
    }, 50);
    sessions.set(id, { timer });
    return id;
  },
  logcat_stop: ({ session }) => {
    const s = sessions.get(session as number);
    if (s) clearInterval(s.timer);
    sessions.delete(session as number);
    return null;
  },
  logcat_clear: () => null,
  logcat_packages: () => PACKAGES,
  logcat_package_processes: ({ package: name }) =>
    name === APP
      ? { uid: 10312, processes: [{ pid: appPid, name: APP }] }
      : {
          uid: PACKAGES.find((p) => p.name === name)?.uid ?? null,
          processes: [],
        },
  logcat_export: ({ fileName }) => `/Users/me/Downloads/${fileName as string}`,
};

export default handlers;
