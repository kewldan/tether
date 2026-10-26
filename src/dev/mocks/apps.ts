import { channel, type MockHandlers, sleep } from "@/dev/mockBackend";
import type {
  AppDetails,
  AppMeta,
  AppSummary,
  Certificate,
  ExtractEvent,
  InstallEvent,
  InstallOptions,
  NetworkUsage,
  PackageFile,
  SigningInfo,
} from "@/features/apps/api";

// Sample apps from docs/design/project/Apps.dc.html.
const MIN = 60_000;
const DAY = 86_400_000;
const now = Date.now();

const cert = (
  sha256: string,
  cn: string,
  o: string | null,
  years: [number, number],
  key = "RSA 2048",
): Certificate => {
  const name = [o && `O=${o}`, `CN=${cn}`].filter(Boolean).join(", ");
  return {
    sha256,
    sha1: sha256.slice(0, 59),
    subject: name,
    issuer: name,
    subjectCn: cn,
    subjectO: o,
    issuerCn: cn,
    issuerO: o,
    serial: "01",
    notBefore: Date.UTC(years[0], 0, 1),
    notAfter: Date.UTC(years[1], 0, 1),
    key,
    debug: cn === "Android Debug",
  };
};

// Fingerprints of real certificates (debug key, AOSP platform key).
const DEBUG_CERT = cert(
  "AF:AF:CB:42:DF:D8:7D:A5:5D:C4:47:CC:64:BB:6A:5D:A5:23:BC:D1:2C:25:15:41:2F:48:28:59:C2:AB:42:E8",
  "Android Debug",
  "Android",
  [2024, 2054],
);
const PLATFORM_CERT = cert(
  "6C:EC:C5:0E:34:AE:31:BF:B5:67:89:86:D6:D6:D3:73:6C:57:1D:ED:2F:24:59:52:77:93:E1:F0:54:EB:0C:9B",
  "Android",
  "Android",
  [2008, 2035],
);
const RELEASE_CERT = cert(
  "3F:9A:12:5B:E0:77:41:C2:9D:08:6A:F3:21:B4:5E:90:CC:17:38:A2:64:DF:0B:59:E1:7A:83:2C:46:F5:C4:0B",
  "Example Inc. release",
  "Example Inc.",
  [2019, 2049],
);
const ROTATED_CERT = cert(
  "8A:92:2B:36:35:7D:2A:E2:D5:85:D7:15:29:7D:B6:14:46:20:26:75:03:C6:06:40:52:BA:AB:39:62:B9:11:5A",
  "Example Inc. rotation 2024",
  "Example Inc.",
  [2024, 2054],
  "RSA 4096",
);

type Seed = Partial<AppSummary> & {
  package: string;
  label: string;
  versionName: string;
  versionCode: number;
  size: number;
};

const SEEDS: Seed[] = [
  {
    package: "com.example.shop",
    label: "Example Shop",
    versionName: "2.14.0",
    versionCode: 2140,
    size: 48_200_000,
    lastUpdate: now - 2 * MIN,
    debuggable: true,
    splits: ["config.arm64_v8a", "config.en", "config.xxhdpi"],
    installer: "adb",
    minSdk: 26,
    targetSdk: 35,
  },
  {
    package: "com.example.shop.staging",
    label: "Example Shop (staging)",
    versionName: "2.15.0-rc1",
    versionCode: 2150,
    size: 51_000_000,
    lastUpdate: now - DAY - 3 * 3_600_000,
    debuggable: true,
    testOnly: true,
    installer: "adb",
  },
  {
    package: "org.telegram.messenger",
    label: "Telegram",
    versionName: "11.2.3",
    versionCode: 52411,
    size: 212_600_000,
    lastUpdate: now - 2 * DAY,
    installer: "com.android.vending",
  },
  {
    package: "com.whatsapp",
    label: "WhatsApp",
    versionName: "2.24.21.8",
    versionCode: 242118,
    size: 156_000_000,
    lastUpdate: now - 4 * DAY,
    installer: "com.android.vending",
  },
  {
    package: "com.google.android.youtube",
    label: "YouTube",
    versionName: "19.42.37",
    versionCode: 1_548_600_000,
    size: 341_900_000,
    lastUpdate: now - 5 * DAY,
    system: true,
    updatedSystem: true,
    installer: "com.android.vending",
  },
  {
    package: "com.android.chrome",
    label: "Chrome",
    versionName: "130.0.6723.58",
    versionCode: 672_305_833,
    size: 402_300_000,
    lastUpdate: now - 7 * DAY,
    system: true,
    updatedSystem: true,
  },
  {
    package: "com.facebook.appmanager",
    label: "Meta App Manager",
    versionName: "198.0.0.21",
    versionCode: 198_000_021,
    size: 22_400_000,
    lastUpdate: now - 84 * DAY,
    system: true,
    disabled: true,
  },
  {
    package: "com.google.android.apps.maps",
    label: "Maps",
    versionName: "11.152.0101",
    versionCode: 1_152_010_100,
    size: 288_700_000,
    lastUpdate: now - 10 * DAY,
    system: true,
  },
  {
    package: "com.termux",
    label: "Termux",
    versionName: "0.119.0",
    versionCode: 1002,
    size: 96_100_000,
    lastUpdate: now - 23 * DAY,
    installer: "org.fdroid.fdroid",
  },
  {
    package: "com.google.android.gm",
    label: "Gmail",
    versionName: "2024.10.06",
    versionCode: 64_890_000,
    size: 184_200_000,
    lastUpdate: now - 25 * DAY,
    system: true,
  },
];

const FILLER = [
  "com.android.settings",
  "com.android.systemui",
  "com.android.phone",
  "com.android.providers.media",
  "com.android.bluetooth",
  "com.android.nfc",
  "com.google.android.gms",
  "com.android.vending",
  "com.android.camera2",
  "com.android.deskclock",
  "com.android.calculator2",
  "com.android.contacts",
  "com.android.documentsui",
  "com.android.packageinstaller",
  "com.android.shell",
  "com.android.keychain",
  "com.android.wallpaper.livepicker",
  "com.android.printspooler",
];

function summary(seed: Seed, i: number): AppSummary {
  return {
    uid: 10_100 + i,
    apkPath: `/data/app/~~x${i}==/${seed.package}-y==/base.apk`,
    codePath: `/data/app/~~x${i}==/${seed.package}-y==`,
    installer: null,
    system: false,
    updatedSystem: false,
    disabled: false,
    suspended: false,
    stopped: false,
    debuggable: false,
    testOnly: false,
    overlay: false,
    splits: [],
    launcher: `${seed.package}/.MainActivity`,
    firstInstall: (seed.lastUpdate ?? now) - 40 * DAY,
    lastUpdate: now - 30 * DAY,
    minSdk: 24,
    targetSdk: 34,
    ...seed,
  };
}

const APPS: AppSummary[] = [
  ...SEEDS.map(summary),
  ...FILLER.map((pkg, i) =>
    summary(
      {
        package: pkg,
        label: "",
        versionName: "16",
        versionCode: 36,
        size: 2_000_000 + i * 1_700_000,
        system: true,
        lastUpdate: now - (120 + i) * DAY,
        installer: null,
      },
      100 + i,
    ),
  ),
  summary(
    {
      package: "com.android.systemui.emulation.pixel_9a",
      label: "",
      versionName: "1",
      versionCode: 1,
      size: 61_000,
      system: true,
      overlay: true,
      launcher: null,
    },
    300,
  ),
];

const LABELS: Record<string, string> = Object.fromEntries(
  SEEDS.map((s) => [s.package, s.label]),
);
Object.assign(LABELS, {
  "com.android.settings": "Settings",
  "com.android.systemui": "System UI",
  "com.android.phone": "Phone Services",
  "com.google.android.gms": "Google Play services",
  "com.android.vending": "Google Play Store",
  "com.android.camera2": "Camera",
  "com.android.deskclock": "Clock",
  "com.android.calculator2": "Calculator",
  "com.android.contacts": "Contacts",
  "com.android.documentsui": "Files",
});

// Tiny solid PNG as a stand-in launcher icon.
const DOT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function find(pkg: unknown) {
  const app = APPS.find((a) => a.package === pkg);
  if (!app)
    throw {
      kind: "device",
      message: `${String(pkg)} is not installed`,
      hint: null,
    };
  return app;
}

function details(pkg: unknown): AppDetails {
  const app = find(pkg);
  const perms = (names: [string, boolean, string[]?][]) =>
    names.map(([name, granted, flags]) => ({
      name: `android.permission.${name}`,
      granted,
      flags: flags ?? [],
    }));
  return {
    ...app,
    pid: app.package === "com.example.shop" ? 4821 : null,
    dataDir: `/data/user/0/${app.package}`,
    apks: [
      { path: app.apkPath, size: Math.round((app.size ?? 0) * 0.8) },
      ...app.splits.map((s) => ({
        path: `${app.codePath}/split_${s}.apk`,
        size: Math.round(((app.size ?? 0) * 0.2) / app.splits.length),
      })),
    ],
    signingVersion: 3,
    primaryAbi: "arm64-v8a",
    sharedUser: null,
    initiatingInstaller: "com.android.shell",
    requestedPermissions: [
      "android.permission.CAMERA",
      "android.permission.INTERNET",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.REQUEST_INSTALL_PACKAGES",
    ],
    installPermissions: perms([
      ["INTERNET", true],
      ["ACCESS_NETWORK_STATE", true],
      ["WAKE_LOCK", true],
      ["FOREGROUND_SERVICE", true],
      ["VIBRATE", true],
    ]),
    runtimePermissions: perms([
      ["CAMERA", true, ["USER_SET", "USER_SENSITIVE_WHEN_GRANTED"]],
      ["RECORD_AUDIO", false],
      ["ACCESS_FINE_LOCATION", true],
      ["ACCESS_COARSE_LOCATION", true],
      ["ACCESS_BACKGROUND_LOCATION", false],
      ["POST_NOTIFICATIONS", true],
      ["READ_MEDIA_IMAGES", false],
      ["READ_MEDIA_VIDEO", false],
      ["READ_MEDIA_VISUAL_USER_SELECTED", true],
      ["READ_CONTACTS", false],
      ["READ_PHONE_STATE", false, ["SYSTEM_FIXED"]],
    ]),
  };
}

const FILE: PackageFile = {
  path: "",
  fileName: "shop-2.15.0-release.apk",
  fileSize: 49_800_000,
  format: "apk",
  package: "com.example.shop",
  label: "Example Shop",
  icon: null,
  versionName: "2.15.0",
  versionCode: 2150,
  minSdk: 26,
  targetSdk: 35,
  debuggable: false,
  testOnly: false,
  signing: { v1: false, v2: true, v3: true, v31: false },
  parts: [{ entry: null, split: null, size: 49_800_000 }],
  obbs: [],
};

const handlers: MockHandlers = {
  list_apps: async () => {
    await sleep(400);
    return APPS;
  },
  load_app_meta: ({ apps, onEvent }) => {
    const send = channel<AppMeta[]>(onEvent);
    const list = apps as { package: string }[];
    void (async () => {
      for (const { package: pkg } of list) {
        await sleep(15);
        const label = LABELS[pkg] || null;
        send([
          {
            package: pkg,
            label,
            icon:
              pkg === "com.android.settings"
                ? { kind: "bitmap", src: DOT_PNG }
                : null,
          },
        ]);
      }
    })();
    return null;
  },
  app_details: async ({ package: pkg }) => {
    await sleep(200);
    return details(pkg);
  },
  app_components: async ({ package: pkg }) => {
    await sleep(250);
    const p = String(pkg);
    const activity = (name: string, exported: boolean, launcher = false) => ({
      kind: "activity",
      name: `${p}${name}`,
      exported,
      enabled: true,
      permission: null,
      actions: launcher ? ["android.intent.action.MAIN"] : [],
      categories: launcher ? ["android.intent.category.LAUNCHER"] : [],
      target: null,
    });
    return {
      launcher: `${p}/.MainActivity`,
      components: [
        activity(".MainActivity", true, true),
        activity(".checkout.CheckoutActivity", true),
        activity(".debug.FeatureFlagsActivity", true),
        activity(".deeplink.DeepLinkActivity", true),
        activity(".settings.SettingsActivity", false),
        {
          kind: "service",
          name: `${p}.sync.SyncService`,
          exported: false,
          enabled: true,
          permission: null,
          actions: [],
          categories: [],
          target: null,
        },
        {
          kind: "receiver",
          name: `${p}.BootReceiver`,
          exported: true,
          enabled: true,
          permission: "android.permission.RECEIVE_BOOT_COMPLETED",
          actions: ["android.intent.action.BOOT_COMPLETED"],
          categories: [],
          target: null,
        },
        {
          kind: "provider",
          name: "androidx.startup.InitializationProvider",
          exported: false,
          enabled: true,
          permission: null,
          actions: [],
          categories: [],
          target: null,
        },
      ],
    };
  },
  app_storage: async ({ package: pkg }) => {
    await sleep(300);
    const app = find(pkg);
    return {
      apk: app.size,
      data: app.debuggable ? 31_700_000 : null,
      cache: app.debuggable ? 12_400_000 : null,
      external: 4_200_000,
    };
  },
  app_ops: async () => {
    await sleep(150);
    return {
      uid: [
        {
          op: "CAMERA",
          mode: "allow",
          lastAccess: null,
          lastReject: null,
          running: false,
        },
        {
          op: "RECORD_AUDIO",
          mode: "ignore",
          lastAccess: null,
          lastReject: null,
          running: false,
        },
      ],
      package: [
        {
          op: "SYSTEM_ALERT_WINDOW",
          mode: "default",
          lastAccess: null,
          lastReject: "+8m50s387ms",
          running: false,
        },
        {
          op: "WAKE_LOCK",
          mode: "allow",
          lastAccess: "+2h14m52s826ms",
          lastReject: null,
          running: false,
        },
        {
          op: "REQUEST_INSTALL_PACKAGES",
          mode: "allow",
          lastAccess: "+44d13h27m6s",
          lastReject: null,
          running: false,
        },
        {
          op: "START_FOREGROUND",
          mode: "allow",
          lastAccess: "+8m49s237ms",
          lastReject: null,
          running: true,
        },
      ],
    };
  },
  app_battery: async () => {
    await sleep(150);
    return { standbyBucket: 10, unrestricted: false, background: "allow" };
  },
  app_signing: async ({ package: pkg }): Promise<SigningInfo> => {
    await sleep(180);
    // The sample app is debug-signed (design board); system apps get the
    // platform key, and Maps a rotated key with a v3.1 signer.
    const debug = pkg === "com.example.shop";
    const rotated = pkg === "com.google.android.apps.maps";
    const platform = String(pkg).startsWith("com.android");
    const signer = debug ? DEBUG_CERT : platform ? PLATFORM_CERT : RELEASE_CERT;
    return {
      schemes: rotated ? ["v2", "v3", "v3.1"] : ["v2", "v3"],
      signers: rotated
        ? [
            {
              certificate: ROTATED_CERT,
              schemes: ["v3.1"],
              minSdk: 33,
              maxSdk: null,
            },
            {
              certificate: RELEASE_CERT,
              schemes: ["v3", "v2"],
              minSdk: 24,
              maxSdk: 32,
            },
          ]
        : [
            {
              certificate: signer,
              schemes: ["v3", "v2"],
              minSdk: 24,
              maxSdk: null,
            },
          ],
      lineage: rotated ? [RELEASE_CERT, ROTATED_CERT] : [],
    };
  },
  app_network: async ({ uid }): Promise<NetworkUsage> => {
    await sleep(250);
    const mb = 1_000_000;
    const t = (rx: number, tx: number) => ({ rx: rx * mb, tx: tx * mb });
    const zero = t(0, 0);
    const period = (scale: number) => ({
      wifi: t(41.3 * scale, 3.9 * scale),
      mobile: t(12.8 * scale, 1.1 * scale),
      ethernet: zero,
      other: zero,
      vpn: scale > 1 ? t(4.2, 0.6) : zero,
      foreground: t(39 * scale, 3.4 * scale),
    });
    return {
      supported: true,
      uid: Number(uid),
      now,
      boot: now - 9 * 3_600_000,
      today: period(0.12),
      sinceBoot: period(0.31),
      last30Days: period(4.6),
      historyStart: now - 74 * DAY,
    };
  },
  launch_app: () => null,
  start_activity: ({ component }) => {
    if (String(component).includes("Settings"))
      throw {
        kind: "device",
        message:
          "Error: Activity not started, permission denial (not exported)",
        hint: null,
      };
    return null;
  },
  force_stop_app: () => null,
  clear_app_data: async ({ cacheOnly }) => {
    await sleep(300);
    if (cacheOnly) return null;
    return null;
  },
  set_app_enabled: async ({ package: pkg, enabled }) => {
    await sleep(200);
    find(pkg).disabled = !enabled;
    return null;
  },
  uninstall_app: async ({ package: pkg }) => {
    await sleep(400);
    const i = APPS.findIndex((a) => a.package === pkg);
    if (i >= 0) APPS.splice(i, 1);
    return null;
  },
  install_existing_app: () => null,
  set_app_permission: async () => {
    await sleep(150);
    return null;
  },
  reset_app_permissions: () => null,
  set_app_op: () => null,
  set_standby_bucket: () => null,
  set_battery_unrestricted: () => null,
  inspect_package_file: async ({ path }) => {
    await sleep(300);
    const p = String(path);
    if (!/\.(apks?|xapk|apkm)$/i.test(p))
      throw {
        kind: "invalid_input",
        message: `${p} is not an APK`,
        hint: null,
      };
    return { ...FILE, path: p, fileName: p.split(/[\\/]/).pop() ?? p };
  },
  installed_version: async ({ serial }) => {
    await sleep(200);
    if (serial === "38121FDJH00A4B")
      return { versionName: "2.14.0", versionCode: 2140, debuggable: false };
    if (serial === "192.168.1.42:37115")
      return {
        versionName: "2.16.0-beta2",
        versionCode: 2162,
        debuggable: true,
      };
    return null;
  },
  install_package: async ({ serials, options, onEvent }) => {
    const send = channel<InstallEvent>(onEvent);
    const opts = options as InstallOptions;
    await Promise.all(
      (serials as string[]).map(async (serial, n) => {
        const total = FILE.fileSize;
        send({ type: "stage", serial, stage: "preparing" });
        await sleep(300 + n * 200);
        send({ type: "stage", serial, stage: "uploading" });
        for (let i = 1; i <= 20; i++) {
          await sleep(120);
          send({ type: "progress", serial, sent: (total * i) / 20, total });
        }
        send({ type: "stage", serial, stage: "committing" });
        await sleep(600);
        if (serial === "192.168.1.42:37115" && !opts.downgrade) {
          send({
            type: "failed",
            serial,
            error: {
              code: "INSTALL_FAILED_VERSION_DOWNGRADE",
              message:
                "Downgrade detected: Update version code 2150 is older than current 2162",
              raw: "Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 2150 is older than current 2162]",
            },
          });
          return;
        }
        send({ type: "done", serial, elapsedMs: 4200 + n * 900 });
      }),
    );
    return null;
  },
  cancel_apps_job: () => null,
  extract_apks: async ({ packages, dest, onEvent }) => {
    const send = channel<ExtractEvent>(onEvent);
    const out: string[] = [];
    for (const pkg of packages as string[]) {
      for (let i = 1; i <= 5; i++) {
        await sleep(150);
        send({
          type: "progress",
          package: pkg,
          received: i * 1_000_000,
          total: 5_000_000,
        });
      }
      const path = `${String(dest)}/${pkg}.apk`;
      send({ type: "done", package: pkg, path });
      out.push(path);
    }
    return out;
  },
  "plugin:dialog|open": ({ options }) => {
    const o = options as { directory?: boolean } | undefined;
    return o?.directory
      ? "/Users/me/Downloads"
      : "/Users/me/Downloads/shop-2.15.0-release.apk";
  },
  "plugin:opener|reveal_item_in_dir": () => null,
};

export default handlers;
