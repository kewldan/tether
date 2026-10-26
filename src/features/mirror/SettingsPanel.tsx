import { motion } from "motion/react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { MirrorInfo, VideoCodec } from "@/features/mirror/api";
import { canDecodeOpus } from "@/features/mirror/audio";
import {
  formatTimer,
  type MirrorRecording,
  useNow,
} from "@/features/mirror/recording";
import {
  BITRATE_RANGE,
  CODECS,
  FRAME_RATES,
  MAX_SIZES,
  samePrefs,
  useMirrorSettings,
} from "@/features/mirror/store";
import type { VideoSize } from "@/features/mirror/useMirrorSession";
import { formatBytes } from "@/features/overview/format";
import { spring } from "@/lib/motion";
import { modKey } from "@/lib/platform";
import { cn } from "@/lib/utils";

const CODEC_LABEL: Record<VideoCodec, string> = {
  h264: "H.264",
  h265: "H.265",
  av1: "AV1",
};

function Field({
  label,
  value,
  children,
}: {
  label: string;
  value?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-small text-secondary-foreground flex justify-between gap-2">
        <span>{label}</span>
        {value && (
          <span className="text-foreground font-medium tabular-nums">
            {value}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** Segmented control with a sliding thumb (snappy spring). */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <fieldset
      aria-label={label}
      className="bg-selected m-0 flex w-full min-w-0 gap-0.5 rounded-md border-0 p-0.5"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "text-small focus-visible:outline-ring relative h-6 flex-1 rounded-[6px] font-medium outline-none focus-visible:outline-2 disabled:opacity-50",
              on ? "text-foreground" : "text-secondary-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring.snappy}
                className="bg-card absolute inset-0 rounded-[6px] shadow-sm"
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-7 items-center justify-between gap-2.5">
      <label htmlFor={id} className="text-small flex min-w-0 flex-col">
        <span>{label}</span>
        {hint && (
          <span className="text-muted-foreground text-caption">{hint}</span>
        )}
      </label>
      <Switch
        id={id}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/** ⌘⇧R / Ctrl+Shift+R. */
export function RecordShortcut() {
  return (
    <span className="flex flex-none gap-[3px]">
      <Kbd>{modKey}</Kbd>
      <Kbd>⇧</Kbd>
      <Kbd>R</Kbd>
    </span>
  );
}

function RecordingSection({
  recording,
}: {
  recording: MirrorRecording | null;
}) {
  const { t } = useTranslation("mirror");
  const now = useNow(recording !== null);
  return (
    <>
      <span className="font-semibold">{t("recording.title")}</span>
      {recording ? (
        <div className="text-muted-foreground text-caption font-mono break-all">
          {recording.dir}
          <br />
          {recording.name}
        </div>
      ) : (
        <div className="text-muted-foreground text-caption">
          {t("recording.idle")}
        </div>
      )}
      <div className="text-muted-foreground text-small flex items-center justify-between gap-2">
        <span className="tabular-nums">
          {recording
            ? `${formatTimer(now - recording.startedAt)} · ${formatBytes(recording.bytes)}`
            : t("recording.notRecording")}
        </span>
        <RecordShortcut />
      </div>
    </>
  );
}

/** Right-hand stream and device settings of the mirror page. */
export function SettingsPanel({
  info,
  size,
  audioAvailable,
  supportedCodecs,
  recording,
}: {
  recording: MirrorRecording | null;
  info: MirrorInfo | null;
  size: VideoSize | null;
  audioAvailable: boolean;
  supportedCodecs: Partial<Record<VideoCodec, boolean>>;
}) {
  const { t } = useTranslation("mirror");
  const s = useMirrorSettings();
  const isDefault = samePrefs(s, s.defaults);
  // Without an Opus decoder the stream is raw PCM: heard, not recorded.
  const [opus, setOpus] = useState<boolean | null>(null);
  useEffect(() => {
    void canDecodeOpus().then(setOpus);
  }, []);

  const sizeLabel = (px: number) =>
    px === 0 ? t("settings.native") : t("settings.longSide", { px });

  return (
    <aside
      aria-label={t("settings.label")}
      className="flex w-[280px] flex-none flex-col gap-[18px] overflow-auto border-l p-4"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">{t("settings.stream")}</span>
        <button
          type="button"
          title={t("settings.resetHint")}
          disabled={isDefault}
          className="text-brand text-small focus-visible:outline-ring rounded-sm hover:underline focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-50"
          onClick={s.resetToDefaults}
        >
          {t("settings.reset")}
        </button>
      </div>

      <Field
        label={t("settings.bitrate")}
        value={t("settings.mbps", { value: s.bitrateMbps })}
      >
        <Slider
          aria-label={t("settings.bitrate")}
          min={BITRATE_RANGE.min}
          max={BITRATE_RANGE.max}
          step={1}
          value={s.bitrateMbps}
          onValueChange={(v) =>
            s.set({ bitrateMbps: Array.isArray(v) ? (v[0] ?? 8) : v })
          }
          className="py-1.5"
        />
      </Field>

      <Field label={t("settings.maxSize")}>
        <Select
          value={String(s.maxSize)}
          items={MAX_SIZES.map((px) => ({
            value: String(px),
            label: sizeLabel(px),
          }))}
          onValueChange={(v) => s.set({ maxSize: Number(v) })}
        >
          <SelectTrigger size="sm" className="text-small w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MAX_SIZES.map((px) => (
              <SelectItem key={px} value={String(px)} className="text-small">
                {sizeLabel(px)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label={t("settings.frameRate")}>
        <Segmented
          label={t("settings.frameRate")}
          value={s.maxFps}
          options={FRAME_RATES.map((fps) => ({
            value: fps,
            label: String(fps),
          }))}
          onChange={(maxFps) => s.set({ maxFps })}
        />
      </Field>

      <Field label={t("settings.codec")}>
        <Segmented
          label={t("settings.codec")}
          value={s.codec}
          options={CODECS.map((codec) => ({
            value: codec,
            label: CODEC_LABEL[codec],
            disabled: supportedCodecs[codec] === false,
          }))}
          onChange={(codec) => s.set({ codec })}
        />
      </Field>

      <div className="bg-border h-px flex-none" />
      <span className="font-semibold">{t("settings.device")}</span>
      <Toggle
        label={t("settings.screenOff")}
        checked={s.screenOff}
        onChange={(screenOff) => s.set({ screenOff })}
      />
      <Toggle
        label={t("settings.showTouches")}
        checked={s.showTouches}
        onChange={(showTouches) => s.set({ showTouches })}
      />
      <Toggle
        label={t("settings.stayAwake")}
        hint={t("settings.stayAwakeHint")}
        checked={s.stayAwake}
        onChange={(stayAwake) => s.set({ stayAwake })}
      />
      <Toggle
        label={t("settings.audio")}
        hint={
          !audioAvailable
            ? t("settings.audioHint")
            : opus === false && s.audio
              ? t("settings.audioNotRecorded")
              : undefined
        }
        checked={s.audio && audioAvailable}
        disabled={!audioAvailable}
        onChange={(audio) => s.set({ audio })}
      />
      <div className="flex flex-col gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={isDefault}
          onClick={() => {
            s.saveAsDefaults();
            toast.success(t("settings.savedAsDefault"));
          }}
        >
          {t("settings.saveAsDefault")}
        </Button>
        <span className="text-muted-foreground text-caption">
          {isDefault ? t("settings.usingDefaults") : t("settings.defaultHint")}
        </span>
      </div>

      <div className="bg-border h-px flex-none" />
      <RecordingSection recording={recording} />

      <div className="text-muted-foreground text-caption mt-auto">
        {info
          ? [
              `scrcpy ${info.scrcpyVersion}`,
              CODEC_LABEL[info.videoCodec],
              size && `${size.width}×${size.height}`,
            ]
              .filter(Boolean)
              .join(" · ")
          : t("settings.notStreaming")}
      </div>
    </aside>
  );
}
