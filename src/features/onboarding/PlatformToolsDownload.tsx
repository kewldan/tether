import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertCircle, Download, X } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import {
  type AdbInstall,
  type AppError,
  cancelPlatformToolsInstall,
  installPlatformTools,
} from "@/lib/tauri";

const LICENSE_URL = "https://developer.android.com/studio/terms";

type Phase =
  | { phase: "idle" }
  | { phase: "downloading"; downloaded: number; total: number | null }
  | { phase: "extracting" }
  | { phase: "failed"; error: AppError };

export function PlatformToolsDownload({
  onInstalled,
}: {
  onInstalled: (install: AdbInstall) => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [state, setState] = useState<Phase>({ phase: "idle" });
  const busy = state.phase === "downloading" || state.phase === "extracting";

  const start = () => {
    setState({ phase: "downloading", downloaded: 0, total: null });
    installPlatformTools((event) => {
      setState(
        event.type === "downloading"
          ? { phase: "downloading", ...event }
          : { phase: "extracting" },
      );
    })
      .then(onInstalled)
      .catch((error: AppError) =>
        setState(
          error.kind === "cancelled"
            ? { phase: "idle" }
            : { phase: "failed", error },
        ),
      );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Download automatically
          <Badge variant="secondary">Recommended</Badge>
        </CardTitle>
        <CardDescription>
          Official Android platform-tools from Google, about 10 MB. They are
          stored inside the app and don't touch your system.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {busy ? (
          <DownloadProgress state={state} />
        ) : (
          <Label className="text-muted-foreground items-start gap-2 text-sm font-normal">
            <Checkbox
              className="mt-0.5"
              aria-labelledby="license-consent"
              checked={accepted}
              onCheckedChange={setAccepted}
            />
            <span id="license-consent">
              I accept the{" "}
              <button
                type="button"
                className="text-foreground underline underline-offset-4"
                onClick={() => openUrl(LICENSE_URL)}
              >
                Android SDK License Agreement
              </button>
            </span>
          </Label>
        )}

        {state.phase === "failed" && (
          <div className="bg-destructive/10 text-destructive flex gap-2 rounded-lg px-3 py-2 text-sm">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div>
              {state.error.message}
              {state.error.hint && (
                <span className="text-muted-foreground block">
                  {state.error.hint}
                </span>
              )}
            </div>
          </div>
        )}

        <div>
          {busy ? (
            <Button
              variant="outline"
              disabled={state.phase === "extracting"}
              onClick={() => cancelPlatformToolsInstall()}
            >
              <X />
              Cancel
            </Button>
          ) : (
            <Button disabled={!accepted} onClick={start}>
              <Download />
              {state.phase === "failed" ? "Try again" : "Download"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DownloadProgress({ state }: { state: Phase }) {
  if (state.phase === "extracting") {
    return (
      <Progress value={null}>
        <ProgressLabel>Unpacking…</ProgressLabel>
      </Progress>
    );
  }
  if (state.phase !== "downloading") return null;

  const { downloaded, total } = state;
  return (
    <Progress
      value={total ? (downloaded / total) * 100 : null}
      getAriaValueText={() => formatProgress(downloaded, total)}
    >
      <ProgressLabel>Downloading…</ProgressLabel>
      <ProgressValue>{() => formatProgress(downloaded, total)}</ProgressValue>
    </Progress>
  );
}

function formatProgress(downloaded: number, total: number | null) {
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return total ? `${mb(downloaded)} / ${mb(total)} MB` : `${mb(downloaded)} MB`;
}
