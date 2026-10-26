import { MotionConfig } from "motion/react";
import { useEffect, useState } from "react";

import { AppShell } from "@/app/shell/AppShell";
import { Titlebar } from "@/app/shell/Titlebar";
import { useAutoReconnect } from "@/features/devices/useAutoReconnect";
import { useDeviceTracking } from "@/features/devices/useDeviceTracking";
import { scanAdb } from "@/features/onboarding/api";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { useLoginLaunch } from "@/features/settings/login";
import { useAdb } from "@/lib/adb";
import { useSettings } from "@/lib/settings";
import { useApplyTheme } from "@/lib/theme";

const REDUCED_MOTION = { system: "user", on: "always", off: "never" } as const;

type Flow = "boot" | "onboarding" | "app";

export function App() {
  useApplyTheme();
  useLoginLaunch();
  const adb = useAdb((s) => s.adb);
  const setAdb = useAdb((s) => s.setAdb);
  const onboardingDone = useSettings((s) => s.onboardingDone);
  const density = useSettings((s) => s.density);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  // Returning users skip straight to the app once adb is found; the
  // onboarding is shown only when it was never finished or adb is gone.
  const [flow, setFlow] = useState<Flow>(
    onboardingDone ? "boot" : "onboarding",
  );
  const [returning, setReturning] = useState(onboardingDone);

  useEffect(() => {
    if (flow !== "boot") return;
    setAdb({ status: "searching" });
    scanAdb()
      .then(({ install }) => {
        if (install) {
          setAdb({ status: "found", install });
          setFlow("app");
        } else {
          setAdb({ status: "missing" });
          setFlow("onboarding");
        }
      })
      .catch(() => {
        setAdb({ status: "missing" });
        setFlow("onboarding");
      });
  }, [flow, setAdb]);

  // "Run onboarding again" from Settings.
  useEffect(() => {
    if (!onboardingDone && flow === "app") {
      setReturning(false);
      setFlow("onboarding");
    }
  }, [onboardingDone, flow]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const found = adb.status === "found";
  useDeviceTracking(found);
  useAutoReconnect(found && flow === "app");

  const finish = () => {
    useSettings.getState().update({ onboardingDone: true });
    setReturning(true);
    setFlow("app");
  };

  return (
    <MotionConfig reducedMotion={REDUCED_MOTION[reduceMotion]}>
      {flow === "app" && found ? (
        <AppShell />
      ) : (
        <div className="bg-background flex h-full flex-col">
          <Titlebar />
          {flow === "onboarding" && (
            <Onboarding returning={returning} onFinish={finish} />
          )}
        </div>
      )}
    </MotionConfig>
  );
}
