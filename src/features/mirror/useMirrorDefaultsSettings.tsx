import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { VideoCodec } from "@/features/mirror/api";
import {
  BITRATE_RANGE,
  CODECS,
  FACTORY_DEFAULTS,
  FRAME_RATES,
  MAX_SIZES,
  type MirrorPrefs,
  samePrefs,
  useMirrorSettings,
} from "@/features/mirror/store";
import { Segmented } from "@/features/settings/Segmented";

const CODEC_LABEL: Record<VideoCodec, string> = {
  h264: "H.264",
  h265: "H.265",
  av1: "AV1",
};

type BoolKey = "audio" | "screenOff" | "showTouches" | "stayAwake";

/** Same shape as a Settings page row. */
interface SettingsRow {
  id: string;
  title: string;
  desc?: ReactNode;
  keywords?: string;
  control: ReactNode;
}

/**
 * "Mirroring" section of the Settings page: the saved defaults every new
 * mirroring session starts with.
 */
export function useMirrorDefaultsSettings(): {
  title: string;
  rows: SettingsRow[];
} {
  const { t } = useTranslation("mirror");
  const defaults = useMirrorSettings((s) => s.defaults);
  const setDefaults = useMirrorSettings((s) => s.setDefaults);
  const resetDefaults = useMirrorSettings((s) => s.resetDefaults);

  const sizeLabel = (px: number) =>
    px === 0 ? t("settings.native") : t("settings.longSide", { px });
  const toggle = (key: BoolKey, label: string) => (
    <Switch
      aria-label={label}
      checked={defaults[key]}
      onCheckedChange={(on) => {
        const patch: Partial<MirrorPrefs> = {};
        patch[key] = on;
        setDefaults(patch);
      }}
    />
  );

  return {
    title: t("defaults.title"),
    rows: [
      {
        id: "mirror-bitrate",
        title: t("settings.bitrate"),
        desc: t("defaults.bitrateDesc"),
        keywords: "mirror scrcpy Mbps",
        control: (
          <div className="flex w-[240px] items-center gap-3">
            <Slider
              aria-label={t("settings.bitrate")}
              min={BITRATE_RANGE.min}
              max={BITRATE_RANGE.max}
              step={1}
              value={defaults.bitrateMbps}
              onValueChange={(v) =>
                setDefaults({
                  bitrateMbps: Array.isArray(v)
                    ? (v[0] ?? FACTORY_DEFAULTS.bitrateMbps)
                    : v,
                })
              }
              className="min-w-0 flex-1 py-1.5"
            />
            <span className="text-small w-[60px] flex-none text-right font-medium tabular-nums">
              {t("settings.mbps", { value: defaults.bitrateMbps })}
            </span>
          </div>
        ),
      },
      {
        id: "mirror-max-size",
        title: t("settings.maxSize"),
        keywords: "mirror resolution",
        control: (
          <Select
            value={String(defaults.maxSize)}
            items={MAX_SIZES.map((px) => ({
              value: String(px),
              label: sizeLabel(px),
            }))}
            onValueChange={(v) => setDefaults({ maxSize: Number(v) })}
          >
            <SelectTrigger
              className="w-[200px]"
              aria-label={t("settings.maxSize")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MAX_SIZES.map((px) => (
                <SelectItem key={px} value={String(px)}>
                  {sizeLabel(px)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ),
      },
      {
        id: "mirror-fps",
        title: t("settings.frameRate"),
        keywords: "mirror fps",
        control: (
          <Segmented
            label={t("settings.frameRate")}
            value={String(defaults.maxFps)}
            onChange={(fps) => setDefaults({ maxFps: Number(fps) })}
            options={FRAME_RATES.map((fps) => ({
              value: String(fps),
              label: String(fps),
            }))}
          />
        ),
      },
      {
        id: "mirror-codec",
        title: t("settings.codec"),
        desc: t("defaults.codecDesc"),
        keywords: "mirror h264 h265 hevc av1",
        control: (
          <Segmented
            label={t("settings.codec")}
            value={defaults.codec}
            onChange={(codec) => setDefaults({ codec })}
            options={CODECS.map((codec) => ({
              value: codec,
              label: CODEC_LABEL[codec],
            }))}
          />
        ),
      },
      {
        id: "mirror-audio",
        title: t("settings.audio"),
        desc: t("defaults.audioDesc"),
        keywords: "mirror sound",
        control: toggle("audio", t("settings.audio")),
      },
      {
        id: "mirror-screen-off",
        title: t("settings.screenOff"),
        desc: t("defaults.screenOffDesc"),
        keywords: "mirror display",
        control: toggle("screenOff", t("settings.screenOff")),
      },
      {
        id: "mirror-show-touches",
        title: t("settings.showTouches"),
        keywords: "mirror",
        control: toggle("showTouches", t("settings.showTouches")),
      },
      {
        id: "mirror-stay-awake",
        title: t("settings.stayAwake"),
        desc: t("settings.stayAwakeHint"),
        keywords: "mirror",
        control: toggle("stayAwake", t("settings.stayAwake")),
      },
      {
        id: "mirror-reset",
        title: t("defaults.reset"),
        desc: t("defaults.resetDesc"),
        keywords: "mirror defaults",
        control: (
          <Button
            size="sm"
            variant="outline"
            disabled={samePrefs(defaults, FACTORY_DEFAULTS)}
            onClick={resetDefaults}
          >
            {t("defaults.resetButton")}
          </Button>
        ),
      },
    ],
  };
}
