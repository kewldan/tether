import { type MirrorRecord, parseRecords } from "@/features/mirror/records";

export type PipelineError =
  | { kind: "unsupported"; codec: string }
  | { kind: "decode"; message: string };

interface Callbacks {
  /** Size of the capture session; touches must be sent in this space. */
  onSession: (width: number, height: number) => void;
  onFirstFrame: () => void;
  onError: (error: PipelineError) => void;
  onAudio: (pcm: Uint8Array) => void;
  /** Ask the device encoder for a key frame (decoder recovered). */
  requestKeyFrame: () => void;
}

/** True when this engine has WebCodecs video decoding at all. */
export const hasWebCodecs = () => typeof VideoDecoder !== "undefined";

const MAX_RECOVERIES = 3;

/**
 * Decodes the record stream with WebCodecs and paints frames on a canvas
 * as soon as they come out of the decoder (no buffering, lowest latency).
 */
export class VideoPipeline {
  private decoder: VideoDecoder | null = null;
  private config: VideoDecoderConfig | null = null;
  /** Frames that arrived while `isConfigSupported` was pending. */
  private queue: MirrorRecord[] | null = null;
  private needKey = true;
  private recoveries = 0;
  private painted = false;
  private closed = false;
  private readonly ctx: CanvasRenderingContext2D | null;

  /** Counters for the live badge; reset by the reader. */
  frames = 0;
  bytes = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: Callbacks,
  ) {
    this.ctx = canvas.getContext("2d", { alpha: false });
  }

  push(buffer: ArrayBuffer) {
    if (this.closed) return;
    this.bytes += buffer.byteLength;
    for (const record of parseRecords(buffer)) {
      if (this.queue && record.kind === "frame") {
        this.queue.push(record);
        continue;
      }
      this.handle(record);
    }
  }

  close() {
    this.closed = true;
    this.queue = null;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }

  private handle(record: MirrorRecord) {
    switch (record.kind) {
      case "session":
        this.callbacks.onSession(record.width, record.height);
        break;
      case "config":
        this.configure({
          codec: record.codec,
          description:
            record.description.byteLength > 0
              ? record.description.slice()
              : undefined,
          optimizeForLatency: true,
        });
        break;
      case "frame":
        this.decode(record.key, record.pts, record.data);
        break;
      case "audio":
        this.callbacks.onAudio(record.data);
        break;
    }
  }

  private configure(config: VideoDecoderConfig) {
    this.queue = [];
    void VideoDecoder.isConfigSupported(config)
      .then((support) => {
        if (this.closed) return;
        if (!support.supported) {
          this.queue = null;
          this.callbacks.onError({ kind: "unsupported", codec: config.codec });
          return;
        }
        this.config = config;
        this.ensureDecoder().configure(config);
        this.needKey = true;
        const queued = this.queue ?? [];
        this.queue = null;
        for (const record of queued) this.handle(record);
      })
      .catch((e: unknown) => {
        this.queue = null;
        this.callbacks.onError({ kind: "decode", message: String(e) });
      });
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state !== "closed") return this.decoder;
    this.decoder = new VideoDecoder({
      output: (frame) => this.paint(frame),
      error: (e) => this.recover(e),
    });
    return this.decoder;
  }

  private decode(key: boolean, pts: number, data: Uint8Array) {
    const decoder = this.decoder;
    if (decoder?.state !== "configured") return;
    if (this.needKey && !key) return;
    this.needKey = false;
    decoder.decode(
      new EncodedVideoChunk({
        type: key ? "key" : "delta",
        timestamp: pts,
        data,
      }),
    );
  }

  private paint(frame: VideoFrame) {
    if (this.closed || !this.ctx) {
      frame.close();
      return;
    }
    const { displayWidth: w, displayHeight: h } = frame;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(frame, 0, 0, w, h);
    frame.close();
    this.frames += 1;
    this.recoveries = 0;
    if (!this.painted) {
      this.painted = true;
      this.callbacks.onFirstFrame();
    }
  }

  /** A decode error closes the decoder: reopen it and wait for a key frame. */
  private recover(error: DOMException) {
    if (this.closed) return;
    this.recoveries += 1;
    if (!this.config || this.recoveries > MAX_RECOVERIES) {
      this.callbacks.onError({ kind: "decode", message: error.message });
      return;
    }
    this.decoder = null;
    this.ensureDecoder().configure(this.config);
    this.needKey = true;
    this.callbacks.requestKeyFrame();
  }
}
