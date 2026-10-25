const SAMPLE_RATE = 48_000;
/** Target latency of the jitter buffer, in seconds. */
const LEAD = 0.06;
const MAX_LEAD = 0.3;

/**
 * Plays scrcpy `raw` audio (s16le, stereo, 48 kHz) by scheduling small
 * buffers back to back; drifts beyond the window resync to `LEAD`.
 */
export class PcmPlayer {
  private readonly ctx: AudioContext;
  private next = 0;

  constructor() {
    this.ctx = new AudioContext({
      sampleRate: SAMPLE_RATE,
      latencyHint: "interactive",
    });
  }

  /** Autoplay policies need a user gesture; call from input handlers. */
  resume() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  push(pcm: Uint8Array) {
    const frames = Math.floor(pcm.byteLength / 4);
    if (frames === 0 || this.ctx.state === "closed") return;
    const buffer = this.ctx.createBuffer(2, frames, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 4);
    for (let i = 0; i < frames; i++) {
      left[i] = view.getInt16(i * 4, true) / 32768;
      right[i] = view.getInt16(i * 4 + 2, true) / 32768;
    }
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
