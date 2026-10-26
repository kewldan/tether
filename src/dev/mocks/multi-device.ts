import { type MockHandlers, sleep } from "@/dev/mockBackend";
import type { MultiCapture, Thumbnail } from "@/features/multi-device/api";
import type { Capture } from "@/features/overview/api";

/** Screen sizes matching the P2 multi-device board. */
const SCREENS: Record<string, [number, number]> = {
  "38121FDJH00A4B": [1344, 2992],
  "192.168.1.42:37115": [1080, 2340],
  "emulator-5554": [1080, 2400],
};

/** A shop-app-like screen (the board's sketch), with a ticking clock. */
function screenSvg(serial: string, w: number, h: number): string {
  const now = new Date();
  const clock = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const accent = serial.startsWith("192") ? "#F2D6D6" : "#E2DDD6";
  const u = w / 100;
  const card = (y: number, height: number, fill = "#E2DDD6") =>
    `<rect x="${6 * u}" y="${y * u}" width="${88 * u}" height="${height * u}" rx="${3 * u}" fill="${fill}"/>`;
  const body = [
    `<rect width="${w}" height="${h}" fill="#F6F4F1"/>`,
    `<text x="${6 * u}" y="${8 * u}" font-family="Inter,sans-serif" font-size="${4.2 * u}" fill="#55524D">${clock}</text>`,
    `<rect x="${6 * u}" y="${14 * u}" width="${44 * u}" height="${7 * u}" rx="${2 * u}" fill="#E2DDD6"/>`,
    card(26, 18),
    card(48, 50),
    card(102, 50),
    card(156, 26, accent),
    `<rect x="0" y="${h - 22 * u}" width="${w}" height="${22 * u}" fill="#1A1A1A"/>`,
  ].join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const capture = (path: string, device: string): Capture => ({
  path,
  name: path.split("/").pop() ?? path,
  device,
  kind: "screenshot",
  sizeBytes: 1_240_000,
  modified: Date.now(),
  width: 1344,
  height: 2992,
});

const handlers: MockHandlers = {
  multi_thumbnail: async ({ serial }): Promise<Thumbnail> => {
    await sleep(250 + Math.random() * 300);
    const size = SCREENS[serial as string];
    if (!size)
      throw { kind: "device", message: "device unauthorized", hint: null };
    const [w, h] = size;
    return {
      dataUrl: screenSvg(serial as string, w, h),
      screenWidth: w,
      screenHeight: h,
    };
  },
  multi_screenshot: async ({ targets, stamp }): Promise<MultiCapture> => {
    await sleep(900);
    const folder = `Grid_${stamp}`;
    const dir = `/Users/me/Pictures/Tether/${folder}`;
    return {
      dir,
      elapsedMs: 1180,
      shots: (targets as { serial: string; name: string }[]).map((t) => ({
        serial: t.serial,
        capture: capture(`${dir}/${t.name}.png`, folder),
        error: null,
      })),
    };
  },
  multi_compose: async ({ paths }) => {
    await sleep(700);
    const first = String((paths as string[])[0] ?? "");
    const dir = first.slice(0, first.lastIndexOf("/"));
    return capture(`${dir}/Grid.png`, dir.split("/").pop() ?? "");
  },
};

export default handlers;
