import {
  ArrowUpRight,
  ChevronDown,
  Crop,
  Grid3x3,
  Redo2,
  Square,
  Type,
  Undo2,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  activeCrop,
  clampRect,
  drawBase,
  drawShapes,
  INKS,
  inkText,
  metrics,
  rectFrom,
  renderFinal,
  resolveCssColor,
  type Shape,
  type Tool,
  textBox,
  textFont,
  toPngBlob,
} from "@/features/gallery/annotate";
import {
  type Capture,
  readCaptureBlob,
  saveAnnotated,
} from "@/features/gallery/api";
import { isMac } from "@/lib/platform";
import type { AppError } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export interface AnnotatorHandle {
  /** The screenshot as shown: annotated, blurred and cropped. */
  exportPng: () => Promise<Blob>;
}

interface Draft {
  shapes: Shape[];
  redo: Shape[];
}

/**
 * Unsaved annotations by capture path, so switching to another capture
 * and back keeps the work.
 */
const drafts = new Map<string, Draft>();
const prefs: { tool: Tool; color: string } = { tool: "arrow", color: "red" };

const TOOLS: { id: Tool; icon: typeof Square; key: string }[] = [
  { id: "arrow", icon: ArrowUpRight, key: "A" },
  { id: "rect", icon: Square, key: "R" },
  { id: "text", icon: Type, key: "T" },
  { id: "blur", icon: Grid3x3, key: "B" },
  { id: "crop", icon: Crop, key: "C" },
];

function errorText(error: unknown) {
  return (error as Partial<AppError>)?.message ?? String(error);
}

function useImage(path: string) {
  const [state, setState] = useState<{
    image: HTMLImageElement | null;
    error: string | null;
  }>({ image: null, error: null });
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setState({ image: null, error: null });
    readCaptureBlob(path)
      .then(async (blob) => {
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        await img.decode();
        if (!cancelled) setState({ image: img, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ image: null, error: errorText(e) });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return state;
}

export function Annotator({
  capture,
  onSaved,
  ref,
}: {
  capture: Capture;
  onSaved: (saved: Capture, original: Capture) => void;
  ref?: Ref<AnnotatorHandle>;
}) {
  const { t } = useTranslation("gallery");
  const { t: tc } = useTranslation();
  const { image, error } = useImage(capture.path);
  const [draft, setDraftState] = useState<Draft>(
    () => drafts.get(capture.path) ?? { shapes: [], redo: [] },
  );
  const [tool, setToolState] = useState<Tool>(prefs.tool);
  const [colorId, setColorId] = useState(prefs.color);
  const [live, setLive] = useState<Shape | null>(null);
  const [text, setText] = useState<{
    x: number;
    y: number;
    value: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const brand = useMemo(() => resolveCssColor("--brand", "#5B47D6"), []);
  const inks = useMemo(() => [...INKS, { id: "brand", value: brand }], [brand]);
  const color = inks.find((i) => i.id === colorId)?.value ?? INKS[0].value;
  const { shapes, redo } = draft;
  const canOverwrite = /\.png$/i.test(capture.name);

  const setDraft = useCallback(
    (next: Draft) => {
      if (next.shapes.length === 0 && next.redo.length === 0) {
        drafts.delete(capture.path);
      } else {
        drafts.set(capture.path, next);
      }
      setDraftState(next);
    },
    [capture.path],
  );
  const push = (shape: Shape) =>
    setDraft({ shapes: [...shapes, shape], redo: [] });
  const undo = useCallback(() => {
    const last = shapes.at(-1);
    if (last) setDraft({ shapes: shapes.slice(0, -1), redo: [...redo, last] });
  }, [shapes, redo, setDraft]);
  const redoOne = useCallback(() => {
    const next = redo.at(-1);
    if (next) setDraft({ shapes: [...shapes, next], redo: redo.slice(0, -1) });
  }, [shapes, redo, setDraft]);
  const setTool = (next: Tool) => {
    prefs.tool = next;
    setToolState(next);
  };
  const pickColor = (id: string) => {
    prefs.color = id;
    setColorId(id);
  };

  // Screenshot plus blurred regions, recomputed only when blurs change.
  const blurKey = JSON.stringify(shapes.filter((s) => s.kind === "blur"));
  const base = useMemo(() => {
    if (!image) return null;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    drawBase(ctx, image, JSON.parse(blurKey) as Shape[]);
    return canvas;
  }, [image, blurKey]);

  // Paint the preview: base, shapes, the shape being drawn, crop shade.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !base) return;
    canvas.width = base.width;
    canvas.height = base.height;
    ctx.drawImage(base, 0, 0);
    const visible = live && live.kind !== "blur" && live.kind !== "crop";
    drawShapes(ctx, visible ? [...shapes, live] : shapes);
    const { stroke } = metrics(canvas.width, canvas.height);
    const crop = live?.kind === "crop" ? live : activeCrop(shapes);
    if (crop) {
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(crop.x, crop.y, crop.w, crop.h);
      ctx.fill("evenodd");
      ctx.restore();
    }
    const outline =
      live?.kind === "blur" || live?.kind === "crop" ? live : null;
    if (outline) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.lineWidth = Math.max(2, stroke / 2);
      ctx.setLineDash([stroke * 2, stroke * 1.5]);
      ctx.strokeRect(outline.x, outline.y, outline.w, outline.h);
      ctx.restore();
    }
  }, [base, shapes, live]);

  const exportPng = useCallback(async () => {
    if (!image) throw new Error(t("annotate.notLoaded"));
    const out = renderFinal(
      image,
      image.naturalWidth,
      image.naturalHeight,
      shapes,
    );
    return toPngBlob(out);
  }, [image, shapes, t]);
  useImperativeHandle(ref, () => ({ exportPng }), [exportPng]);

  const toImage = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0, scale: 1 };
    const r = canvas.getBoundingClientRect();
    const scale = canvas.width / r.width;
    return {
      x: Math.min(canvas.width, Math.max(0, (e.clientX - r.left) * scale)),
      y: Math.min(canvas.height, Math.max(0, (e.clientY - r.top) * scale)),
      scale,
    };
  };

  const shapeFor = (x1: number, y1: number, x2: number, y2: number): Shape => {
    switch (tool) {
      case "arrow":
        return { kind: "arrow", x1, y1, x2, y2, color };
      case "rect":
        return { kind: "rect", ...rectFrom(x1, y1, x2, y2), color };
      case "blur":
        return { kind: "blur", ...rectFrom(x1, y1, x2, y2) };
      default:
        return { kind: "crop", ...rectFrom(x1, y1, x2, y2) };
    }
  };

  const commitText = () => {
    if (text?.value.trim()) {
      push({
        kind: "text",
        x: text.x,
        y: text.y,
        text: text.value.trim(),
        color,
      });
    }
    setText(null);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !image) return;
    if (text) {
      commitText();
      return;
    }
    const p = toImage(e);
    if (tool === "text") {
      e.preventDefault();
      setText({ x: p.x, y: p.y, value: "" });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: p.x, y: p.y };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = start.current;
    if (!s) return;
    const p = toImage(e);
    setLive(shapeFor(s.x, s.y, p.x, p.y));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = start.current;
    start.current = null;
    setLive(null);
    if (!s || !image) return;
    const p = toImage(e);
    // Ignore clicks: anything shorter than ~4 screen pixels.
    const min = 4 * p.scale;
    const shape = shapeFor(s.x, s.y, p.x, p.y);
    if (shape.kind === "arrow") {
      if (Math.hypot(p.x - s.x, p.y - s.y) >= min) push(shape);
    } else if (shape.kind !== "text") {
      const r = clampRect(shape, image.naturalWidth, image.naturalHeight);
      if (r.w >= min && r.h >= min) push({ ...shape, ...r });
    }
  };

  // Shortcuts: tools, undo/redo, Escape cancels the shape being drawn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, [contenteditable=true], [role=dialog], [role=menu]",
        )
      )
        return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redoOne();
        else undo();
      } else if (mod && key === "y" && !isMac) {
        e.preventDefault();
        redoOne();
      } else if (!mod && !e.altKey && !e.shiftKey) {
        const next = TOOLS.find((x) => x.key.toLowerCase() === key);
        if (next) {
          prefs.tool = next.id;
          setToolState(next.id);
        } else if (e.key === "Escape") {
          start.current = null;
          setLive(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redoOne]);

  const save = async (overwrite: boolean) => {
    setSaving(true);
    try {
      const blob = await exportPng();
      const saved = await saveAnnotated(capture.path, blob, overwrite);
      drafts.delete(capture.path);
      setDraftState({ shapes: [], redo: [] });
      toast.success(
        overwrite
          ? t("annotate.overwritten", { name: saved.name })
          : t("annotate.saved", { name: saved.name }),
      );
      onSaved(saved, capture);
    } catch (e) {
      toast.error(t("annotate.saveFailed"), { description: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      const blob = await exportPng();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      toast.success(t("imageCopied"));
    } catch (e) {
      toast.error(t("copyFailed"), { description: errorText(e) });
    }
  };

  // Where the text box sits on screen.
  const textStyle = (() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!text || !canvas || !stage) return undefined;
    const c = canvas.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const scale = c.width / canvas.width;
    const { font } = metrics(canvas.width, canvas.height);
    const ctx = canvas.getContext("2d");
    const box = ctx ? textBox(ctx, text.value || "M", font) : null;
    return {
      left: c.left - s.left + text.x * scale,
      top: c.top - s.top + text.y * scale,
      font: textFont(Math.max(10, font * scale)),
      height: (box?.h ?? font * 1.6) * scale,
      minWidth: 80,
      paddingInline: (box?.pad ?? 4) * scale,
      backgroundColor: color,
      color: inkText(color),
    };
  })();

  const mod = isMac ? "⌘" : "Ctrl";
  const dirty = shapes.length > 0;

  return (
    <>
      <div
        role="toolbar"
        aria-label={t("annotate.toolbar")}
        className="flex flex-wrap items-center gap-0.5 gap-y-1.5 border-b px-3.5 py-2"
      >
        {TOOLS.map(({ id, icon: Icon, key }) => (
          <button
            key={id}
            type="button"
            aria-label={t(`annotate.tools.${id}`)}
            aria-pressed={tool === id}
            title={`${t(`annotate.tools.${id}`)} (${key})`}
            onClick={() => setTool(id)}
            className={cn(
              "focus-visible:outline-ring flex size-[30px] items-center justify-center rounded-[7px] outline-none focus-visible:outline-2",
              tool === id
                ? "bg-brand/15 text-brand"
                : "text-secondary-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        ))}
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={t("annotate.color", {
                  name: t(`annotate.colors.${colorId}`),
                })}
                title={t(`annotate.colors.${colorId}`)}
                className="hover:bg-accent focus-visible:outline-ring ml-1.5 flex size-[30px] items-center justify-center rounded-[7px] outline-none focus-visible:outline-2"
              />
            }
          >
            <span
              aria-hidden
              className="ring-muted-foreground ring-offset-background size-3.5 rounded-full ring-1 ring-offset-2"
              style={{ backgroundColor: color }}
            />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-2">
            <fieldset className="grid grid-cols-7 gap-1">
              <legend className="sr-only">{t("annotate.colorLabel")}</legend>
              {inks.map((ink) => (
                <button
                  key={ink.id}
                  type="button"
                  aria-pressed={ink.id === colorId}
                  aria-label={t(`annotate.colors.${ink.id}`)}
                  title={t(`annotate.colors.${ink.id}`)}
                  onClick={() => pickColor(ink.id)}
                  className={cn(
                    "hover:bg-accent focus-visible:outline-ring flex size-7 items-center justify-center rounded-md outline-none focus-visible:outline-2",
                    ink.id === colorId && "bg-selected",
                  )}
                >
                  <span
                    aria-hidden
                    className="border-input size-4 rounded-full border"
                    style={{ backgroundColor: ink.value }}
                  />
                </button>
              ))}
            </fieldset>
          </PopoverContent>
        </Popover>
        <span className="bg-border mx-1.5 h-4 w-px" aria-hidden />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("annotate.undo")}
          title={`${t("annotate.undo")} (${mod}Z)`}
          disabled={shapes.length === 0}
          onClick={undo}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("annotate.redo")}
          title={`${t("annotate.redo")} (${isMac ? "⇧⌘Z" : "Ctrl+Y"})`}
          disabled={redo.length === 0}
          onClick={redoOne}
        >
          <Redo2 />
        </Button>
        <div className="ml-auto flex items-center">
          <Button
            variant="outline"
            size="sm"
            className="rounded-r-none"
            disabled={!dirty || saving || !image}
            onClick={() => void save(false)}
          >
            {t("annotate.saveCopy")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="-ml-px rounded-l-none"
                  aria-label={t("annotate.more")}
                  disabled={saving || !image}
                />
              }
            >
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem
                disabled={!dirty || !canOverwrite}
                onClick={() => setConfirmOverwrite(true)}
              >
                {canOverwrite
                  ? t("annotate.overwrite")
                  : t("annotate.overwritePngOnly")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copy()}>
                {t("copyImage")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!dirty}
                onClick={() => setDraft({ shapes: [], redo: [] })}
              >
                {t("annotate.discard")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div
        ref={stageRef}
        className="bg-sidebar relative flex min-h-0 flex-1 items-center justify-center p-4"
      >
        {error ? (
          <p className="text-error text-small text-center">{error}</p>
        ) : !image ? (
          <Skeleton className="aspect-[9/19] h-full max-h-[560px] rounded-[14px]" />
        ) : null}
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t("annotate.canvas", { name: capture.name })}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            start.current = null;
            setLive(null);
          }}
          className={cn(
            "ring-input max-h-full max-w-full touch-none rounded-[14px] ring-1",
            tool === "text" ? "cursor-text" : "cursor-crosshair",
            !image && "hidden",
          )}
        />
        {text && textStyle && (
          <input
            // biome-ignore lint/a11y/noAutofocus: opened by a click on the canvas
            autoFocus
            value={text.value}
            aria-label={t("annotate.textLabel")}
            placeholder={t("annotate.textPlaceholder")}
            onChange={(e) => setText({ ...text, value: e.target.value })}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              if (e.key === "Escape") setText(null);
            }}
            style={textStyle}
            className="absolute rounded-sm outline-none placeholder:text-current placeholder:opacity-60"
          />
        )}
      </div>

      <AlertDialog open={confirmOverwrite} onOpenChange={setConfirmOverwrite}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("annotate.overwriteTitle", { name: capture.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("annotate.overwriteBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOverwrite(false);
                void save(true);
              }}
            >
              {t("annotate.overwriteConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
