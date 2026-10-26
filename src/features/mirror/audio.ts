import type { AudioCodec } from "@/features/mirror/api";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** Target latency of the jitter buffer, in seconds. */
const LEAD = 0.06;
const MAX_LEAD = 0.3;

const OPUS_CONFIG = {
  codec: "opus",
  sampleRate: SAMPLE_RATE,
  numberOfChannels: CHANNELS,
} as const;

let opusSupport: Promise<boolean> | null = null;

/**
 * Whether this web view decodes Opus with WebCodecs (`AudioDecoder`):
 * WebKit on macOS 26+ and Chromium do; older WebKitGTK may not. Checked
 * once per window.
 */
export function canDecodeOpus(): Promise<boolean> {
  if (!opusSupport) {
    opusSupport =
      typeof AudioDecoder === "undefined"
        ? Promise.resolve(false)
        : AudioDecoder.isConfigSupported(OPUS_CONFIG).then(
            (r) => r.supported === true,
            () => false,
          );
  }
  return opusSupport;
}

/** The audio codec to ask the server for in this web view. */
export async function preferredAudioCodec(): Promise<AudioCodec> {
  return (await canDecodeOpus()) ? "opus" : "raw";
}

/**
 * Schedules decoded audio back to back on an `AudioContext`; drifts beyond
 * the window resync to `LEAD`.
 */
class Output {
  private readonly ctx: AudioContext;
  private next = 0;

  constructor() {
    this.ctx = new AudioContext({
      sampleRate: SAMPLE_RATE,
      latencyHint: "interactive",
    });
  }

  get closed() {
    return this.ctx.state === "closed";
  }

  resume() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Plays planar channels (one Float32Array each). */
  play(planes: Float32Array[], sampleRate: number) {
    const frames = planes[0]?.length ?? 0;
    if (frames === 0 || this.closed) return;
    const buffer = this.ctx.createBuffer(planes.length, frames, sampleRate);
    planes.forEach((plane, i) => {
      buffer.copyToChannel(plane as Float32Array<ArrayBuffer>, i);
    });
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.next < now || this.next > now + MAX_LEAD) this.next = now + LEAD;
    source.start(this.next);
    this.next += buffer.duration;
  }

  close() {
    void this.ctx.close();
  }
}

export interface AudioPlayer {
  /** Autoplay policies need a user gesture; call from input handlers. */
  resume(): void;
  push(pts: number, data: Uint8Array): void;
  close(): void;
}

/** scrcpy `raw` audio: s16le, stereo, 48 kHz. */
class PcmPlayer implements AudioPlayer {
  private readonly out = new Output();

  resume() {
    this.out.resume();
  }

  push(_pts: number, pcm: Uint8Array) {
    const frames = Math.floor(pcm.byteLength / 4);
    if (frames === 0) return;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 4);
    for (let i = 0; i < frames; i++) {
      left[i] = view.getInt16(i * 4, true) / 32768;
      right[i] = view.getInt16(i * 4 + 2, true) / 32768;
    }
    this.out.play([left, right], SAMPLE_RATE);
  }

  close() {
    this.out.close();
  }
}

/** Opus packets decoded with WebCodecs' `AudioDecoder`. */
class OpusPlayer implements AudioPlayer {
  private readonly out = new Output();
  private readonly decoder: AudioDecoder;

  constructor(head: Uint8Array, onError: (message: string) => void) {
    this.decoder = new AudioDecoder({
      output: (data) => {
        try {
          if (this.out.closed) return;
          const planes: Float32Array[] = [];
          for (let i = 0; i < data.numberOfChannels; i++) {
            const plane = new Float32Array(data.numberOfFrames);
            // f32-planar is the one conversion every engine must offer.
            data.copyTo(plane, { planeIndex: i, format: "f32-planar" });
            planes.push(plane);
          }
          this.out.play(planes, data.sampleRate);
        } finally {
          data.close();
        }
      },
      error: (e) => onError(e.message),
    });
    this.decoder.configure({
      ...OPUS_CONFIG,
      description: head.byteLength > 0 ? head.slice() : undefined,
    });
  }

  resume() {
    this.out.resume();
  }

  push(pts: number, packet: Uint8Array) {
    if (this.decoder.state !== "configured") return;
    this.decoder.decode(
      new EncodedAudioChunk({ type: "key", timestamp: pts, data: packet }),
    );
  }

  close() {
    if (this.decoder.state !== "closed") this.decoder.close();
    this.out.close();
  }
}

/**
 * A player for the stream's audio config record, or null when this web
 * view can't play it.
 */
export function createAudioPlayer(
  codec: string,
  description: Uint8Array,
  onError: (message: string) => void,
): AudioPlayer | null {
  if (codec === "pcm-s16") return new PcmPlayer();
  if (codec === "opus" && typeof AudioDecoder !== "undefined") {
    return new OpusPlayer(description, onError);
  }
  return null;
}
