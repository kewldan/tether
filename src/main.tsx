import "@/lib/i18n";
import "./index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateNotifier } from "@/features/updater/UpdateNotifier";

if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  const { installMockBackend } = await import("@/dev/mockBackend");
  installMockBackend();
}
if (import.meta.env.DEV && import.meta.env.VITE_DEMO === "1") {
  const { startDemoDriver } = await import("@/dev/demoDriver");
  startDemoDriver();
}

// The screen-mirroring pop-out window loads the same page with
// `?popout=<serial>` and renders only the mirror view.
const params = new URLSearchParams(window.location.search);
const popout = params.get("popout");
const PopoutView = lazy(() => import("@/features/mirror/PopoutView"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          {popout ? (
            <Suspense fallback={null}>
              <PopoutView serial={popout} name={params.get("name") ?? ""} />
            </Suspense>
          ) : (
            <>
              <App />
              <UpdateNotifier />
            </>
          )}
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
