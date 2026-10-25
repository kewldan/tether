import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

/** Opens the system file manager at a pulled file or folder. */
export function reveal(path: string) {
  revealItemInDir(path).catch((e: { message?: string }) =>
    toast.error(e?.message ?? String(e)),
  );
}
