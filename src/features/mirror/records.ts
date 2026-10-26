/**
 * Binary records of the video channel (`mirror::protocol::record` in Rust):
 * `kind u8 · flags u8 · reserved u16 · length u32 · pts u64`, big-endian,
 * then `length` payload bytes. One message holds several records.
 */
export const RECORD = {
  session: 1,
  videoConfig: 2,
  videoFrame: 3,
  audio: 4,
  audioConfig: 5,
} as const;

export const FLAG_KEY = 1;
const HEADER = 16;

export type MirrorRecord =
  | { kind: "session"; width: number; height: number }
  | { kind: "config"; codec: string; description: Uint8Array }
  | { kind: "frame"; key: boolean; pts: number; data: Uint8Array }
  | { kind: "audio"; pts: number; data: Uint8Array }
  /** `opus` (description: the OpusHead) or `pcm-s16` (s16le stereo 48 kHz). */
  | { kind: "audioConfig"; codec: string; description: Uint8Array };

export function* parseRecords(buffer: ArrayBuffer): Generator<MirrorRecord> {
  const view = new DataView(buffer);
  let at = 0;
  while (at + HEADER <= buffer.byteLength) {
    const kind = view.getUint8(at);
    const flags = view.getUint8(at + 1);
    const length = view.getUint32(at + 4);
    // PTS in microseconds fits a double for ~285 years of uptime.
    const pts = Number(view.getBigUint64(at + 8));
    const start = at + HEADER;
    const data = new Uint8Array(buffer, start, length);
    at = start + length;
    switch (kind) {
      case RECORD.session:
        yield {
          kind: "session",
          width: view.getUint32(start),
          height: view.getUint32(start + 4),
        };
        break;
      case RECORD.videoConfig:
      case RECORD.audioConfig: {
        const n = data[0] ?? 0;
        yield {
          kind: kind === RECORD.videoConfig ? "config" : "audioConfig",
          codec: new TextDecoder().decode(data.subarray(1, 1 + n)),
          description: data.subarray(1 + n),
        };
        break;
      }
      case RECORD.videoFrame:
        yield { kind: "frame", key: (flags & FLAG_KEY) !== 0, pts, data };
        break;
      case RECORD.audio:
        yield { kind: "audio", pts, data };
        break;
    }
  }
}

/** Encodes one record; used by the browser mock backend. */
export function encodeRecord(
  kind: number,
  flags: number,
  pts: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(HEADER + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  view.setUint8(1, flags);
  view.setUint32(4, payload.byteLength);
  view.setBigUint64(8, BigInt(Math.max(0, Math.round(pts))));
  out.set(payload, HEADER);
  return out;
}
