// Public surface of the Apps feature for the app shell.
// Mount <ApkInstallHost /> once in AppShell so `.apk/.apks/.xapk` files
// dropped anywhere open the install dialog (the Apps page mounts its own
// copy too; only the first mounted host is active).
export { ApkInstallHost } from "./install/ApkInstallHost";
export { openInstallerWith, pickAndInstall } from "./install/openInstaller";
