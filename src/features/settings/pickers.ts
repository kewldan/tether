import { open } from "@tauri-apps/plugin-dialog";

/** Native "open file" dialog for an adb binary; null when cancelled. */
export async function pickFile(title: string): Promise<string | null> {
  const picked = await open({ title, multiple: false, directory: false });
  return typeof picked === "string" ? picked : null;
}

/** Native folder picker; null when cancelled. */
export async function pickFolder(
  title: string,
  defaultPath?: string | null,
): Promise<string | null> {
  const picked = await open({
    title,
    multiple: false,
    directory: true,
    defaultPath: defaultPath ?? undefined,
  });
  return typeof picked === "string" ? picked : null;
}
