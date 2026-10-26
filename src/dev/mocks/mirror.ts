import { channel, type MockHandlers, sleep } from "@/dev/mockBackend";
import { addMockCapture } from "@/dev/mocks/gallery";
import type {
  ControlMessage,
  MirrorInfo,
  MirrorOptions,
  RecordEvent,
  RecordingStarted,
} from "@/features/mirror/api";
import { encodeRecord, FLAG_KEY, RECORD } from "@/features/mirror/records";

/**
 * Browser stand-in for scrcpy: draws a fake app on an OffscreenCanvas,
 * encodes it with WebCodecs' VideoEncoder (H.264, AVCC) and streams the
 * same binary records the Rust side produces, so the real decoder path
 * runs. Touches are drawn as circles; HOME/BACK change the fake screen.
 */
interface Fake {
  stop: () => void;
  touches: { x: number; y: number; at: number }[];
  screen: "shop" | "home";
}

const sessions = new Map<string, Fake>();
let nextSession = 1;

const PRODUCTS = [
  ["Runner Pro 2", "8 990 ₽", "#D9CFC2"],
  ["Canvas Tote", "2 450 ₽", "#B9C7C9"],
  ["Wool Beanie", "1 290 ₽", "#CFC4D8"],
  ["Trail Cap", "1 790 ₽", "#E3D3B4"],
] as const;

// Colors of the fake *device content* (an app on the phone), not UI.
function draw(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  fake: Fake,
) {
  const s = w / 300;
  ctx.fillStyle = fake.screen === "shop" ? "#F6F4F1" : "#1B2A3A";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fake.screen === "shop" ? "#1A1A1A" : "#FFFFFF";
  ctx.font = `600 ${10 * s}px Inter, sans-serif`;
  const now = new Date();
  ctx.fillText(
    `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`,
    16 * s,
    18 * s,
  );
  ctx.fillText("82%", w - 40 * s, 18 * s);
  if (fake.screen === "home") {
    ctx.font = `600 ${28 * s}px Inter, sans-serif`;
    ctx.fillText("Home screen", 24 * s, h / 3);
    ctx.font = `${12 * s}px Inter, sans-serif`;
    ctx.fillText("Press Back to return to the shop", 24 * s, h / 3 + 28 * s);
  } else {
    ctx.font = `700 ${17 * s}px Inter, sans-serif`;
    ctx.fillText("Example Shop", 14 * s, 52 * s);
    ctx.fillStyle = "#E9E5DF";
    ctx.beginPath();
    ctx.roundRect(14 * s, 66 * s, w - 28 * s, 30 * s, 15 * s);
    ctx.fill();
    ctx.fillStyle = "#6E6A64";
    ctx.font = `${11 * s}px Inter, sans-serif`;
    ctx.fillText("Search 12,400 products", 26 * s, 85 * s);
    const cell = (w - 36 * s) / 2;
    PRODUCTS.forEach(([name, price, color], i) => {
      const x = 14 * s + (i % 2) * (cell + 8 * s);
      const y = 112 * s + Math.floor(i / 2) * (cell + 44 * s);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, cell, cell, 12 * s);
      ctx.fill();
      ctx.fillStyle = "#1A1A1A";
      ctx.font = `600 ${10 * s}px Inter, sans-serif`;
      ctx.fillText(name, x, y + cell + 16 * s);
      ctx.fillStyle = "#6E6A64";
      ctx.fillText(price, x, y + cell + 30 * s);
    });
  }
  const t = performance.now();
  fake.touches = fake.touches.filter((p) => t - p.at < 500);
  for (const p of fake.touches) {
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.strokeStyle = "rgba(0,0,0,.35)";
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 15 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

async function startFake(
  options: MirrorOptions,
  onVideo: (b: ArrayBuffer) => void,
): Promise<Fake> {
  if (
    typeof VideoEncoder === "undefined" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    throw {
      kind: "device",
      message:
        "Mirroring failed: this browser has no VideoEncoder for the mock.",
      hint: null,
    };
  }
  const long = options.maxSize > 0 ? Math.min(options.maxSize, 1280) : 1280;
  const height = long - (long % 16);
  const width = Math.round((height * 9) / 20 / 16) * 16;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw { kind: "device", message: "no 2d context", hint: null };

  const fake: Fake = { stop: () => {}, touches: [], screen: "shop" };
  const send = (record: Uint8Array) => onVideo(record.slice().buffer);
  const size = new Uint8Array(8);
  new DataView(size.buffer).setUint32(0, width);
  new DataView(size.buffer).setUint32(4, height);
  send(encodeRecord(RECORD.session, 0, 0, size));

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const config = meta?.decoderConfig;
      if (config?.description) {
        const codec = new TextEncoder().encode(config.codec);
        const desc = new Uint8Array(
          config.description instanceof ArrayBuffer
            ? config.description
            : (config.description as ArrayBufferView).buffer,
        );
        const body = new Uint8Array(1 + codec.length + desc.length);
        body[0] = codec.length;
        body.set(codec, 1);
        body.set(desc, 1 + codec.length);
        send(encodeRecord(RECORD.videoConfig, 0, 0, body));
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      send(
        encodeRecord(
          RECORD.videoFrame,
          chunk.type === "key" ? FLAG_KEY : 0,
          chunk.timestamp,
          data,
        ),
      );
    },
    error: (e) => console.warn("[mock mirror] encoder", e),
  });
  encoder.configure({
    codec: "avc1.42E01F",
    width,
    height,
    bitrate: options.videoBitRate,
    framerate: 30,
    latencyMode: "realtime",
    avc: { format: "avc" },
  });

  let frame = 0;
  const started = performance.now();
  const timer = setInterval(() => {
    if (encoder.encodeQueueSize > 2) return;
    draw(ctx, width, height, fake);
    const video = new VideoFrame(canvas, {
      timestamp: Math.round((performance.now() - started) * 1000),
    });
    encoder.encode(video, { keyFrame: frame % 90 === 0 });
    video.close();
    frame += 1;
  }, 1000 / 30);
  fake.stop = () => {
    clearInterval(timer);
    if (encoder.state !== "closed") encoder.close();
  };
  return fake;
}

const MOCK_OPTIONS: MirrorOptions = {
  videoCodec: "h264",
  maxSize: 1280,
  videoBitRate: 8_000_000,
  maxFps: 60,
  audio: false,
  showTouches: false,
  stayAwake: true,
};

/** Recordings in progress: progress timer and file name. */
const recordings = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; device: string; name: string }
>();
/** Pop-outs are browser popups here; each runs its own mock backend. */
const popups = new Map<string, Window>();

const handlers: MockHandlers = {
  mirror_start: async ({ serial, options, onVideo }) => {
    const id = serial as string;
    sessions.get(id)?.stop();
    await sleep(700);
    // Mirrors what a device without an AV1 encoder reports.
    if ((options as MirrorOptions).videoCodec === "av1") {
      throw {
        kind: "device",
        message:
          "Mirroring failed: Could not find encoder for av1 (try another codec)",
        hint: null,
      };
    }
    const fake = await startFake(
      options as MirrorOptions,
      channel<ArrayBuffer>(onVideo),
    );
    sessions.set(id, fake);
    const info: MirrorInfo = {
      sessionId: nextSession++,
      deviceName: "sdk_gphone64_arm64",
      videoCodec: "h264",
      audio: false,
      scrcpyVersion: "5.0.1",
    };
    return info;
  },
  // The pop-out page has its own fake stream in the browser.
  mirror_attach: async ({ serial, onVideo }) => {
    const id = serial as string;
    sessions.get(id)?.stop();
    await sleep(300);
    sessions.set(id, await startFake(MOCK_OPTIONS, channel(onVideo)));
    const info: MirrorInfo = {
      sessionId: nextSession++,
      deviceName: "sdk_gphone64_arm64",
      videoCodec: "h264",
      audio: false,
      scrcpyVersion: "5.0.1",
    };
    return info;
  },
  mirror_popout: ({ serial, name, width, height, onClosed }) => {
    const id = serial as string;
    const url = `${location.pathname}?popout=${encodeURIComponent(id)}&name=${encodeURIComponent(name as string)}`;
    const popup = window.open(
      url,
      `popout-${id}`,
      `popup,width=${width as number},height=${height as number}`,
    );
    if (!popup) throw { kind: "device", message: "popup blocked", hint: null };
    popups.set(id, popup);
    const closed = channel<null>(onClosed);
    const poll = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(poll);
      popups.delete(id);
      closed(null);
    }, 400);
    return null;
  },
  mirror_popout_close: ({ serial }) => {
    popups.get(serial as string)?.close();
    window.focus();
    return null;
  },
  "plugin:window|close": () => {
    window.close();
    return null;
  },
  mirror_record_start: ({ serial, deviceName, stamp, onEvent }) => {
    const id = serial as string;
    if (recordings.has(id)) {
      throw { kind: "invalid_input", message: "already recording", hint: null };
    }
    const send = channel<RecordEvent>(onEvent);
    const started = Date.now();
    const timer = setInterval(() => {
      const ms = Date.now() - started;
      send({ type: "progress", bytes: Math.round(ms * 460), durationMs: ms });
    }, 1000);
    const name = `Recording_${stamp as string}.mp4`;
    recordings.set(id, { timer, device: deviceName as string, name });
    const result: RecordingStarted = {
      path: `/Users/me/Pictures/Tether/${deviceName as string}/${name}`,
      name,
      dir: `~/Pictures/Tether/${deviceName as string}/`,
    };
    return result;
  },
  mirror_record_stop: async ({ serial }) => {
    const rec = recordings.get(serial as string);
    if (!rec) {
      throw { kind: "invalid_input", message: "not recording", hint: null };
    }
    recordings.delete(serial as string);
    clearInterval(rec.timer);
    await sleep(300);
    return addMockCapture(rec.device, rec.name, "recording");
  },
  mirror_stop: ({ serial }) => {
    sessions.get(serial as string)?.stop();
    sessions.delete(serial as string);
    return null;
  },
  mirror_control: ({ serial, message }) => {
    const fake = sessions.get(serial as string);
    const msg = message as ControlMessage;
    if (!fake) throw { kind: "device", message: "not mirroring", hint: null };
    if (msg.type === "touch") {
      fake.touches.push({ x: msg.x, y: msg.y, at: performance.now() });
    } else if (msg.type === "key" && msg.action === "up" && msg.keycode === 3) {
      fake.screen = "home";
    } else if (msg.type === "backOrScreenOn" && msg.action === "up") {
      fake.screen = "shop";
    }
    return null;
  },
  "plugin:window|set_always_on_top": () => null,
  "plugin:window|set_fullscreen": () => null,
};

export default handlers;
