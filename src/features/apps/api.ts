import { Channel, invoke } from "@tauri-apps/api/core";

/** One row of the apps table (`AppSummary` in Rust). */
export interface AppSummary {
  package: string;
  uid: number | null;
  apkPath: string;
  codePath: string | null;
  versionName: string | null;
  versionCode: number;
  installer: string | null;
  system: boolean;
  updatedSystem: boolean;
  disabled: boolean;
  suspended: boolean;
  stopped: boolean;
  debuggable: boolean;
  testOnly: boolean;
  overlay: boolean;
  splits: string[];
  launcher: string | null;
  firstInstall: number | null;
  lastUpdate: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  size: number | null;
}

export interface PermissionState {
  name: string;
  granted: boolean;
  flags: string[];
}

export interface AppDetails extends AppSummary {
  pid: number | null;
  dataDir: string | null;
  apks: { path: string; size: number | null }[];
  signingVersion: number | null;
  primaryAbi: string | null;
  sharedUser: string | null;
  initiatingInstaller: string | null;
  requestedPermissions: string[];
  installPermissions: PermissionState[];
  runtimePermissions: PermissionState[];
}

export type ComponentKind =
  | "activity"
  | "alias"
  | "service"
  | "receiver"
  | "provider";

export interface AppComponent {
  kind: ComponentKind;
  name: string;
  exported: boolean;
  enabled: boolean;
  permission: string | null;
  actions: string[];
  categories: string[];
  target: string | null;
}

export interface AppComponents {
  components: AppComponent[];
  launcher: string | null;
}

export interface AppStorage {
  apk: number | null;
  data: number | null;
  cache: number | null;
  external: number | null;
}

export interface AppOpEntry {
  op: string;
  mode: string;
  lastAccess: string | null;
  lastReject: string | null;
  running: boolean;
}

export interface AppOps {
  uid: AppOpEntry[];
  package: AppOpEntry[];
}

export interface AppBattery {
  standbyBucket: number | null;
  unrestricted: boolean;
  background: string | null;
}

/** One X.509 signer certificate (`Certificate` in Rust). */
export interface Certificate {
  /** `AB:CD:…` as printed by keytool / apksigner. */
  sha256: string;
  sha1: string;
  subject: string;
  issuer: string;
  subjectCn: string | null;
  subjectO: string | null;
  issuerCn: string | null;
  issuerO: string | null;
  serial: string;
  notBefore: number;
  notAfter: number;
  /** `RSA 2048`, `EC 256`… */
  key: string | null;
  /** The SDK's auto-generated debug key (CN=Android Debug). */
  debug: boolean;
}

export interface Signer {
  certificate: Certificate;
  /** `v1`, `v2`, `v3`, `v3.1`. */
  schemes: string[];
  minSdk: number | null;
  maxSdk: number | null;
}

export interface SigningInfo {
  schemes: string[];
  /** Newest scheme first. */
  signers: Signer[];
  /** v3 key rotation, oldest first; empty without rotation. */
  lineage: Certificate[];
}

export interface Traffic {
  rx: number;
  tx: number;
}

export interface NetworkPeriod {
  wifi: Traffic;
  mobile: Traffic;
  ethernet: Traffic;
  other: Traffic;
  /** Through a VPN; also counted on the underlying network. */
  vpn: Traffic;
  foreground: Traffic;
}

export interface NetworkUsage {
  supported: boolean;
  uid: number;
  now: number;
  boot: number;
  today: NetworkPeriod;
  sinceBoot: NetworkPeriod;
  last30Days: NetworkPeriod;
  historyStart: number | null;
}

export type AppIcon =
  | { kind: "bitmap"; src: string }
  | {
      kind: "adaptive";
      background: string | null;
      foreground: string | null;
    };

export interface AppMeta {
  package: string;
  label: string | null;
  icon: AppIcon | null;
}

export interface MetaRequest {
  package: string;
  apkPath: string;
  versionCode: number;
  lastUpdate: number | null;
}

export interface ApkPart {
  entry: string | null;
  split: string | null;
  size: number;
}

export interface PackageFile {
  path: string;
  fileName: string;
  fileSize: number;
  format: "apk" | "bundle";
  package: string;
  label: string | null;
  icon: AppIcon | null;
  versionName: string | null;
  versionCode: number;
  minSdk: number | null;
  targetSdk: number | null;
  debuggable: boolean;
  testOnly: boolean;
  signing: { v1: boolean; v2: boolean; v3: boolean; v31: boolean };
  parts: ApkPart[];
  obbs: { entry: string; size: number }[];
}

export interface InstalledVersion {
  versionName: string | null;
  versionCode: number;
  debuggable: boolean;
}

export interface InstallOptions {
  reinstall: boolean;
  downgrade: boolean;
  grantAll: boolean;
  testOnly: boolean;
  bypassLowTargetSdk: boolean;
  launch: boolean;
}

export interface InstallFailure {
  code: string | null;
  message: string;
  raw: string;
}

export type InstallStage =
  | "preparing"
  | "uploading"
  | "committing"
  | "launching";

export type InstallEvent =
  | { type: "stage"; serial: string; stage: InstallStage }
  | { type: "progress"; serial: string; sent: number; total: number }
  | { type: "done"; serial: string; elapsedMs: number }
  | { type: "failed"; serial: string; error: InstallFailure }
  | { type: "cancelled"; serial: string };

export type ExtractEvent =
  | { type: "progress"; package: string; received: number; total: number }
  | { type: "done"; package: string; path: string }
  | { type: "failed"; package: string; message: string };

export type OpMode = "allow" | "ignore" | "deny" | "default" | "foreground";
export type StandbyBucket =
  | "active"
  | "working_set"
  | "frequent"
  | "rare"
  | "restricted";

type Pkg = { serial: string; package: string };

export const listApps = (serial: string) =>
  invoke<AppSummary[]>("list_apps", { serial });
export const appDetails = (a: Pkg) => invoke<AppDetails>("app_details", a);
export const appComponents = (a: Pkg) =>
  invoke<AppComponents>("app_components", a);
export const appStorage = (a: Pkg) => invoke<AppStorage>("app_storage", a);
export const appOps = (a: Pkg & { uid: number | null }) =>
  invoke<AppOps>("app_ops", a);
export const appBattery = (a: Pkg) => invoke<AppBattery>("app_battery", a);
export const appSigning = (a: Pkg) => invoke<SigningInfo>("app_signing", a);
export const appNetwork = (a: { serial: string; uid: number }) =>
  invoke<NetworkUsage>("app_network", a);

/** Streams labels/icons in batches; a new call for the serial stops the old. */
export function loadAppMeta(
  serial: string,
  apps: MetaRequest[],
  onMeta: (batch: AppMeta[]) => void,
) {
  const channel = new Channel<AppMeta[]>();
  channel.onmessage = onMeta;
  return invoke<void>("load_app_meta", { serial, apps, onEvent: channel });
}

export const launchApp = (a: Pkg) => invoke<void>("launch_app", a);
export const startActivity = (a: { serial: string; component: string }) =>
  invoke<void>("start_activity", a);
export const forceStopApp = (a: Pkg) => invoke<void>("force_stop_app", a);
export const clearAppData = (a: Pkg & { cacheOnly: boolean }) =>
  invoke<void>("clear_app_data", a);
export const setAppEnabled = (a: Pkg & { enabled: boolean }) =>
  invoke<void>("set_app_enabled", a);
export const uninstallApp = (a: Pkg & { keepData: boolean; system: boolean }) =>
  invoke<void>("uninstall_app", a);
export const installExistingApp = (a: Pkg) =>
  invoke<void>("install_existing_app", a);
export const setAppPermission = (
  a: Pkg & { permission: string; granted: boolean },
) => invoke<void>("set_app_permission", a);
export const resetAppPermissions = (a: Pkg & { permissions: string[] }) =>
  invoke<void>("reset_app_permissions", a);
export const setAppOp = (
  a: Pkg & { op: string; mode: OpMode; uidScope: boolean },
) => invoke<void>("set_app_op", a);
export const setStandbyBucket = (a: Pkg & { bucket: StandbyBucket }) =>
  invoke<void>("set_standby_bucket", a);
export const setBatteryUnrestricted = (a: Pkg & { unrestricted: boolean }) =>
  invoke<void>("set_battery_unrestricted", a);

export const inspectPackageFile = (path: string, locale: string) =>
  invoke<PackageFile>("inspect_package_file", { path, locale });
export const installedVersion = (a: Pkg) =>
  invoke<InstalledVersion | null>("installed_version", a);

export function installPackage(
  args: {
    jobId: string;
    serials: string[];
    path: string;
    options: InstallOptions;
  },
  onEvent: (event: InstallEvent) => void,
) {
  const channel = new Channel<InstallEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("install_package", { ...args, onEvent: channel });
}

export const cancelAppsJob = (jobId: string, serial?: string) =>
  invoke<void>("cancel_apps_job", { jobId, serial: serial ?? null });

export function extractApks(
  args: { jobId: string; serial: string; packages: string[]; dest: string },
  onEvent: (event: ExtractEvent) => void,
) {
  const channel = new Channel<ExtractEvent>();
  channel.onmessage = onEvent;
  return invoke<string[]>("extract_apks", { ...args, onEvent: channel });
}

/** Extensions the installer accepts. */
export const PACKAGE_EXTENSIONS = ["apk", "apks", "xapk", "apkm"];

export function isPackageFile(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return PACKAGE_EXTENSIONS.includes(ext);
}
