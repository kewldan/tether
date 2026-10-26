import { type MockHandlers, sleep } from "@/dev/mockBackend";
import type { DevChange, DevSettings } from "@/features/device-settings/api";

const initial = (): DevSettings => ({
  darkTheme: true,
  animationScale: 1,
  fontScale: 1,
  physicalSize: { width: 1344, height: 2992 },
  screenSize: null,
  physicalDensity: 480,
  density: null,
  showTouches: false,
  pointerLocation: false,
  layoutBounds: false,
  gpuProfiling: false,
  stayAwake: true,
  demoMode: false,
  wifi: true,
  mobileData: true,
  airplane: false,
  locale: "en-US",
  localeSettable: true,
});

const LOCALES = [
  "en-US",
  "en-GB",
  "de-DE",
  "fr-FR",
  "es-ES",
  "ru-RU",
  "uk-UA",
  "ja-JP",
  "ar-EG",
  "he-IL",
  "zh-CN",
  "en-XA",
  "ar-XB",
];
const appLocales = new Map<string, string[]>();

const bySerial = new Map<string, DevSettings>();
const get = (serial: string) => {
  let s = bySerial.get(serial);
  if (!s) {
    s = initial();
    bySerial.set(serial, s);
  }
  return s;
};

const handlers: MockHandlers = {
  read_dev_settings: async ({ serial }) => {
    await sleep(150);
    return { ...get(serial as string) };
  },
  apply_dev_setting: async ({ serial, change }) => {
    await sleep(250);
    const s = get(serial as string);
    const c = change as DevChange;
    Object.assign(s, { [c.key]: c.value });
    return { ...s };
  },
  device_locales: () => [...LOCALES],
  app_locales: async ({ serial, package: pkg }) => {
    await sleep(120);
    return appLocales.get(`${serial}|${pkg}`) ?? [];
  },
  set_app_locales: async ({ serial, package: pkg, locales }) => {
    await sleep(200);
    appLocales.set(`${serial}|${pkg}`, locales as string[]);
    return [...(locales as string[])];
  },
};

export default handlers;
