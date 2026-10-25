import type { MockHandlers } from "@/dev/mockBackend";
import type { CaptureList } from "@/features/gallery/api";
import type { Capture } from "@/features/overview/api";

// Mock thumbnails: a phone-shaped SVG in the tones of the design board.
// Mock-only visuals, so literal colors are fine here.
function phoneSvg(bg: string, label: string): string {
  const dark = bg.charAt(1) < "5";
  const fg = dark ? "#ECEEF2" : "#1A1A1A";
  const block = dark ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.08)";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 780"><rect width="360" height="780" fill="${bg}"/><text x="28" y="88" font-family="Inter,sans-serif" font-weight="700" font-size="34" fill="${fg}">${label}</text><rect x="28" y="130" width="304" height="120" rx="20" fill="${block}"/><rect x="28" y="270" width="304" height="120" rx="20" fill="${block}"/><rect x="28" y="410" width="304" height="120" rx="20" fill="${block}"/><rect x="28" y="680" width="304" height="64" rx="32" fill="${fg}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const now = Date.now();
const min = 60_000;
const SAMPLES: [string, string, "png" | "mp4", number, string, string][] = [
  ["Screenshot_22-38-12", "Pixel 8 Pro", "png", 2, "#F6F4F1", "Cart"],
  ["Screenshot_22-31-04", "Pixel 8 Pro", "png", 9, "#E9EEF5", "Search"],
  ["checkout-flow", "Galaxy S23", "mp4", 18, "#1E2129", "Checkout"],
  ["Screenshot_21-58-40", "emulator-5554", "png", 45, "#F3EDE4", "Orders"],
  ["cart-empty-state", "Pixel 8 Pro", "png", 60, "#EAF2EC", "Cart"],
  ["onboarding-dark", "Galaxy S23", "png", 70, "#202432", "Welcome"],
  ["crash-repro", "Pixel 8 Pro", "mp4", 120, "#F6F4F1", "Profile"],
  ["Screenshot_19-12-09", "emulator-5554", "png", 180, "#ECE8F4", "Settings"],
  ["login-dark", "Pixel 8 Pro", "png", 26 * 60, "#141619", "Sign in"],
  ["Screenshot_18-03-55", "Galaxy S23", "png", 28 * 60, "#F1F1F1", "Home"],
];

export const mockCaptures: Capture[] = SAMPLES.map(
  ([name, device, ext, ago, bg, label], i) => ({
    path: `${phoneSvg(bg, label)}#${i}`,
    name: `${name}.${ext}`,
    device,
    kind: ext === "png" ? "screenshot" : "recording",
    sizeBytes: ext === "png" ? 412_000 + i * 9_000 : 8_400_000 + i * 120_000,
    modified: now - ago * min,
    width: ext === "png" ? 1344 : null,
    height: ext === "png" ? 2992 : null,
  }),
);

/** Adds a capture made through the overview mocks. */
export function addMockCapture(
  device: string,
  name: string,
  kind: Capture["kind"],
) {
  const capture: Capture = {
    path: `${phoneSvg("#E9EEF5", "New")}#${mockCaptures.length}`,
    name,
    device,
    kind,
    sizeBytes: kind === "screenshot" ? 398_000 : 6_100_000,
    modified: Date.now(),
    width: kind === "screenshot" ? 1344 : null,
    height: kind === "screenshot" ? 2992 : null,
  };
  mockCaptures.unshift(capture);
  return capture;
}

const handlers: MockHandlers = {
  list_captures: (): CaptureList => ({
    dir: "/Users/me/Pictures/Tether",
    captures: [...mockCaptures],
  }),
  delete_capture: ({ path }) => {
    const i = mockCaptures.findIndex((c) => c.path === path);
    if (i >= 0) mockCaptures.splice(i, 1);
    return null;
  },
  "plugin:opener|reveal_item_in_dir": () => null,
};

export default handlers;
