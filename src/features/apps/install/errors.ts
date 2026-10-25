import type { InstallFailure, InstallOptions } from "../api";

/** What the user can do about a failure, offered as a row button. */
export type FailureAction =
  | { kind: "retry"; overrides: Partial<InstallOptions>; label: string }
  | { kind: "uninstallFirst"; label: string };

export interface FailureInfo {
  /** Key under `apps:installErrors`, or null to show the raw message. */
  key: string | null;
  /** The row asks for a decision (warning style) instead of failing. */
  decision: boolean;
  action: FailureAction | null;
}

const KNOWN = new Set([
  "INSTALL_FAILED_ALREADY_EXISTS",
  "INSTALL_FAILED_INVALID_APK",
  "INSTALL_FAILED_INVALID_URI",
  "INSTALL_FAILED_INSUFFICIENT_STORAGE",
  "INSTALL_FAILED_DUPLICATE_PACKAGE",
  "INSTALL_FAILED_NO_SHARED_USER",
  "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
  "INSTALL_FAILED_SHARED_USER_INCOMPATIBLE",
  "INSTALL_FAILED_MISSING_SHARED_LIBRARY",
  "INSTALL_FAILED_DEXOPT",
  "INSTALL_FAILED_OLDER_SDK",
  "INSTALL_FAILED_CONFLICTING_PROVIDER",
  "INSTALL_FAILED_NEWER_SDK",
  "INSTALL_FAILED_TEST_ONLY",
  "INSTALL_FAILED_CPU_ABI_INCOMPATIBLE",
  "INSTALL_FAILED_NO_MATCHING_ABIS",
  "INSTALL_FAILED_MISSING_FEATURE",
  "INSTALL_FAILED_VERIFICATION_FAILURE",
  "INSTALL_FAILED_VERIFICATION_TIMEOUT",
  "INSTALL_FAILED_PACKAGE_CHANGED",
  "INSTALL_FAILED_DUPLICATE_PERMISSION",
  "INSTALL_FAILED_VERSION_DOWNGRADE",
  "INSTALL_FAILED_USER_RESTRICTED",
  "INSTALL_FAILED_ABORTED",
  "INSTALL_FAILED_INTERNAL_ERROR",
  "INSTALL_FAILED_MISSING_SPLIT",
  "INSTALL_FAILED_DEPRECATED_SDK_VERSION",
  "INSTALL_FAILED_SESSION_INVALID",
  "INSTALL_FAILED_MULTI_ARCH_NOT_MATCH_ALL_NATIVE_ABI",
  "INSTALL_PARSE_FAILED_NOT_APK",
  "INSTALL_PARSE_FAILED_BAD_MANIFEST",
  "INSTALL_PARSE_FAILED_NO_CERTIFICATES",
  "INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES",
  "INSTALL_PARSE_FAILED_CERTIFICATE_ENCODING",
  "INSTALL_PARSE_FAILED_BAD_PACKAGE_NAME",
  "INSTALL_PARSE_FAILED_MANIFEST_MALFORMED",
  "INSTALL_PARSE_FAILED_MANIFEST_EMPTY",
  "INSTALL_PARSE_FAILED_UNEXPECTED_EXCEPTION",
]);

/** Maps an `INSTALL_FAILED_*` code to its message key and fix. */
export function describeFailure(error: InstallFailure): FailureInfo {
  const code = error.code ?? "";
  const key = KNOWN.has(code) ? code : null;
  switch (code) {
    case "INSTALL_FAILED_VERSION_DOWNGRADE":
      return {
        key,
        decision: true,
        action: {
          kind: "retry",
          overrides: { downgrade: true, reinstall: true },
          label: "allowDowngrade",
        },
      };
    case "INSTALL_FAILED_ALREADY_EXISTS":
      return {
        key,
        decision: true,
        action: {
          kind: "retry",
          overrides: { reinstall: true },
          label: "reinstall",
        },
      };
    case "INSTALL_FAILED_TEST_ONLY":
      return {
        key,
        decision: true,
        action: {
          kind: "retry",
          overrides: { testOnly: true },
          label: "allowTestOnly",
        },
      };
    case "INSTALL_FAILED_DEPRECATED_SDK_VERSION":
      return {
        key,
        decision: true,
        action: {
          kind: "retry",
          overrides: { bypassLowTargetSdk: true },
          label: "bypassLowTarget",
        },
      };
    case "INSTALL_FAILED_UPDATE_INCOMPATIBLE":
    case "INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES":
      return {
        key,
        decision: true,
        action: { kind: "uninstallFirst", label: "uninstallFirst" },
      };
    case "INSTALL_FAILED_INSUFFICIENT_STORAGE":
    case "INSTALL_FAILED_ABORTED":
    case "INSTALL_FAILED_VERIFICATION_TIMEOUT":
    case "INSTALL_FAILED_INTERNAL_ERROR":
    case "INSTALL_FAILED_SESSION_INVALID":
      return {
        key,
        decision: false,
        action: { kind: "retry", overrides: {}, label: "retry" },
      };
    default:
      return {
        key,
        decision: false,
        action: key ? null : { kind: "retry", overrides: {}, label: "retry" },
      };
  }
}
