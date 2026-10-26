import { create } from "zustand";

import { closePopout, openPopout } from "@/features/mirror/api";
import type { VideoSize } from "@/features/mirror/useMirrorSession";

interface PopoutState {
  /** Serials whose session is shown in a pop-out window. */
  open: Record<string, true>;
  set: (serial: string, open: boolean) => void;
}

/** Pop-outs opened from this (main) window. */
export const usePopouts = create<PopoutState>()((set) => ({
  open: {},
  set: (serial, open) =>
    set((s) => {
      const next = { ...s.open };
      if (open) next[serial] = true;
      else delete next[serial];
      return { open: next };
    }),
}));

/** Height of the pop-out's screen area; the width follows the video. */
const SCREEN_HEIGHT = 560;
/** Pop-out padding (6 px around) plus the header and footer rows. */
const CHROME = { width: 12, height: 12 + 24 + 34 };

/**
 * Moves the running session of `serial` into a small always-on-top
 * window. When it closes, the main window takes the session back.
 */
export async function popOut(
  serial: string,
  name: string,
  video: VideoSize | null,
) {
  const aspect = video ? video.width / video.height : 9 / 20;
  const size = {
    width: Math.round(SCREEN_HEIGHT * aspect) + CHROME.width,
    height: SCREEN_HEIGHT + CHROME.height,
  };
  await openPopout(serial, name, size, () =>
    usePopouts.getState().set(serial, false),
  );
  usePopouts.getState().set(serial, true);
}

/** Closes the pop-out of `serial`; the main window shows the device again. */
export const popIn = (serial: string, focusMain = true) =>
  closePopout(serial, focusMain);

/** The serial a pop-out window shows (`index.html?popout=<serial>`). */
export function popoutSerial(): string | null {
  return new URLSearchParams(window.location.search).get("popout");
}
