import { deviceExec } from "@/features/devices/api";
import { useDevices } from "@/features/devices/store";
import { inputKey, inputText } from "@/features/intents/api";
import { useMulti } from "@/features/multi-device/store";

/** Ready devices that grid actions apply to. */
export function selectedSerials(): string[] {
  const { excluded } = useMulti.getState();
  return useDevices
    .getState()
    .devices.filter((d) => d.state.kind === "device")
    .map((d) => d.serial)
    .filter((s) => !excluded.includes(s));
}

/** Where a tap on `origin`'s screen goes: just it, or every selected one. */
function tapTargets(origin: string): string[] {
  if (!useMulti.getState().broadcast) return [origin];
  const all = selectedSerials();
  return all.includes(origin) ? all : [origin, ...all];
}

function toScreen(serial: string, fx: number, fy: number) {
  const screen = useMulti.getState().screens[serial];
  if (!screen) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x: Math.round(clamp(fx) * (screen.width - 1)),
    y: Math.round(clamp(fy) * (screen.height - 1)),
  };
}

async function settle(runs: Promise<unknown>[]) {
  const results = await Promise.allSettled(runs);
  useMulti.getState().bump();
  return results;
}

/**
 * Taps (or swipes, when `to` is given) at a point given as a fraction of
 * the screen, mapped onto each target's own resolution.
 */
export function sendGesture(
  origin: string,
  from: { fx: number; fy: number },
  to?: { fx: number; fy: number },
) {
  return settle(
    tapTargets(origin).map((serial) => {
      const a = toScreen(serial, from.fx, from.fy);
      if (!a) return Promise.resolve();
      const b = to && toScreen(serial, to.fx, to.fy);
      return deviceExec(
        serial,
        b
          ? `input swipe ${a.x} ${a.y} ${b.x} ${b.y} 250`
          : `input tap ${a.x} ${a.y}`,
      );
    }),
  );
}

/** A key (`BACK`, `HOME`, `APP_SWITCH`) on every selected device. */
export function sendKey(key: string) {
  return settle(selectedSerials().map((serial) => inputKey(serial, key)));
}

/** Types `text` on every selected device. */
export function sendText(text: string) {
  return settle(selectedSerials().map((serial) => inputText(serial, text)));
}
