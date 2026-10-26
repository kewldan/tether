/**
 * Screenshot annotations: the shape model and canvas rendering shared by
 * the on-screen editor and the PNG export. All coordinates are image
 * pixels, so the export is exact whatever the preview scale.
 */

export type Tool = "arrow" | "rect" | "text" | "blur" | "crop";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Shape =
  | {
      kind: "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
    }
  | ({ kind: "rect"; color: string } & Rect)
  | { kind: "text"; x: number; y: number; text: string; color: string }
  | ({ kind: "blur" } & Rect)
  | ({ kind: "crop" } & Rect);

/**
 * Ink colors. They end up as pixels inside the saved PNG, so they are fixed
 * values rather than theme tokens (a red arrow must stay red in any theme).
 * The brand color is added at runtime from `--brand`.
 */
export const INKS = [
  { id: "red", value: "#F2555A" },
  { id: "yellow", value: "#FFC83D" },
  { id: "green", value: "#2BB673" },
  { id: "blue", value: "#3D8BFD" },
  { id: "black", value: "#111111" },
  { id: "white", value: "#FFFFFF" },
] as const;

/** A CSS custom property as an `rgb()` color a canvas understands. */
export function resolveCssColor(variable: string, fallback: string): string {
  try {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.fillStyle = fallback;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  } catch {
    return fallback;
  }
}

/** Normalizes a drag into a rectangle with positive size. */
export function rectFrom(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

/** Clamps a rectangle to the image and rounds it to whole pixels. */
export function clampRect(r: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const right = Math.min(width, Math.ceil(r.x + r.w));
  const bottom = Math.min(height, Math.ceil(r.y + r.h));
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/** Line width, arrow head and font size scale with the screenshot. */
export function metrics(width: number, height: number) {
  const short = Math.min(width, height);
  const stroke = Math.max(3, Math.round(short / 110));
  return {
    stroke,
    head: stroke * 4.2,
    font: Math.max(14, Math.round(short / 22)),
    block: Math.max(12, Math.round(short / 28)),
  };
}

/** The last crop wins; earlier ones stay in the history for undo. */
export function activeCrop(shapes: Shape[]): Rect | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.kind === "crop") return s;
  }
  return null;
}

/**
 * Replaces every pixel of `area` with the average of its block. The
 * original pixels are gone from the canvas, and so from the saved file.
 */
export function pixelate(
  ctx: CanvasRenderingContext2D,
  area: Rect,
  block: number,
) {
  const { x, y, w, h } = clampRect(area, ctx.canvas.width, ctx.canvas.height);
  if (w === 0 || h === 0) return;
  const image = ctx.getImageData(x, y, w, h);
  const d = image.data;
  for (let by = 0; by < h; by += block) {
    for (let bx = 0; bx < w; bx += block) {
      const bw = Math.min(block, w - bx);
      const bh = Math.min(block, h - by);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = by; yy < by + bh; yy++) {
        for (let xx = bx; xx < bx + bw; xx++) {
          const i = (yy * w + xx) * 4;
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
          a += d[i + 3];
        }
      }
      const n = bw * bh;
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      a = Math.round(a / n);
      for (let yy = by; yy < by + bh; yy++) {
        for (let xx = bx; xx < bx + bw; xx++) {
          const i = (yy * w + xx) * 4;
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
          d[i + 3] = a;
        }
      }
    }
  }
  ctx.putImageData(image, x, y);
}

/** Draws the screenshot with its blurred regions (no other shapes). */
export function drawBase(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  shapes: Shape[],
) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const { block } = metrics(width, height);
  for (const s of shapes) {
    if (s.kind === "blur") pixelate(ctx, s, block);
  }
}

function luminance(color: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  const [r, g, b] = hex
    ? [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16))
    : rgb
      ? [rgb[1], rgb[2], rgb[3]].map(Number)
      : [0, 0, 0];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Text color that reads on a label filled with `color`. */
export function inkText(color: string): string {
  return luminance(color) > 0.6 ? "#111111" : "#FFFFFF";
}

export function textFont(size: number) {
  return `600 ${size}px Inter, system-ui, sans-serif`;
}

/** Box of a text label drawn at (x, y), the label's top-left corner. */
export function textBox(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: number,
): { w: number; h: number; pad: number } {
  ctx.font = textFont(font);
  const pad = Math.round(font * 0.4);
  return {
    w: Math.ceil(ctx.measureText(text).width) + pad * 2,
    h: Math.round(font * 1.25) + pad,
    pad,
  };
}

function roundedRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(r.x, r.y, r.w, r.h, radius);
  } else {
    ctx.rect(r.x, r.y, r.w, r.h);
  }
}

/** Draws arrows, rectangles and labels on top of the base. */
export function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[]) {
  const { stroke, head, font } = metrics(ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of shapes) {
    if (s.kind === "arrow") {
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const h = Math.min(head, length * 0.6);
      const baseX = s.x2 - Math.cos(angle) * h * 0.8;
      const baseY = s.y2 - Math.sin(angle) * h * 0.8;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = stroke;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(baseX, baseY);
      ctx.stroke();
      const spread = Math.PI / 7;
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(
        s.x2 - Math.cos(angle - spread) * h,
        s.y2 - Math.sin(angle - spread) * h,
      );
      ctx.lineTo(
        s.x2 - Math.cos(angle + spread) * h,
        s.y2 - Math.sin(angle + spread) * h,
      );
      ctx.closePath();
      ctx.fill();
    } else if (s.kind === "rect") {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = stroke;
      roundedRect(ctx, s, stroke * 2);
      ctx.stroke();
    } else if (s.kind === "text") {
      const box = textBox(ctx, s.text, font);
      ctx.fillStyle = s.color;
      roundedRect(ctx, { x: s.x, y: s.y, w: box.w, h: box.h }, font * 0.3);
      ctx.fill();
      ctx.fillStyle = inkText(s.color);
      ctx.textBaseline = "middle";
      ctx.fillText(s.text, s.x + box.pad, s.y + box.h / 2);
    }
  }
}

/**
 * Renders the final image: base, blurs, shapes, then the crop. Returns a
 * new canvas at full resolution.
 */
export function renderFinal(
  image: CanvasImageSource,
  width: number,
  height: number,
  shapes: Shape[],
): HTMLCanvasElement {
  const full = document.createElement("canvas");
  full.width = width;
  full.height = height;
  const ctx = full.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas unavailable");
  drawBase(ctx, image, shapes);
  drawShapes(ctx, shapes);
  const crop = activeCrop(shapes);
  if (!crop) return full;
  const r = clampRect(crop, width, height);
  if (r.w < 2 || r.h < 2) return full;
  const out = document.createElement("canvas");
  out.width = r.w;
  out.height = r.h;
  out.getContext("2d")?.drawImage(full, -r.x, -r.y);
  return out;
}

export function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))),
      "image/png",
    ),
  );
}
