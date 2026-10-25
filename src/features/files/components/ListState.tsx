import {
  ChevronUp,
  CircleAlert,
  FolderOpen,
  Home,
  Lock,
  RotateCw,
  SearchX,
  Upload,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AppError } from "@/lib/tauri";

type Props =
  | { kind: "loading" }
  | {
      kind: "error";
      error: AppError;
      onRetry: () => void;
      onHome: () => void;
    }
  | { kind: "denied"; path: string; onUp: () => void }
  | { kind: "empty"; onUpload: () => void }
  | {
      kind: "noMatches";
      query: string;
      hiddenCount: number;
      onClear: () => void;
      onShowHidden?: () => void;
    };

/** Loading, error, permission-denied, empty and no-match states. */
export function ListState(props: Props) {
  const { t } = useTranslation("files");

  if (props.kind === "loading") {
    return (
      <div aria-busy className="flex flex-col">
        <div className="h-8 border-b" />
        {Array.from({ length: 9 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          <div key={i} className="flex h-8 items-center gap-3 border-b px-3">
            <Skeleton className="bg-selected size-4 rounded-xs" />
            <Skeleton className="bg-selected size-4 rounded-xs" />
            <Skeleton
              className="bg-selected h-3 rounded-xs"
              style={{ width: `${30 + ((i * 37) % 35)}%` }}
            />
            <Skeleton className="bg-selected ml-auto h-3 w-16 rounded-xs" />
            <Skeleton className="bg-selected h-3 w-24 rounded-xs" />
          </div>
        ))}
      </div>
    );
  }

  if (props.kind === "error") {
    return (
      <Centered
        icon={<CircleAlert className="text-error size-8" aria-hidden />}
        title={t("state.errorTitle")}
        body={props.error.hint ?? undefined}
        details={props.error.message}
      >
        <Button variant="outline" size="sm" onClick={props.onRetry}>
          <RotateCw />
          {t("common:actions.retry")}
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onHome}>
          <Home />
          {t("state.goHome")}
        </Button>
      </Centered>
    );
  }

  if (props.kind === "denied") {
    return (
      <Centered
        icon={<Lock className="text-warning size-8" aria-hidden />}
        title={t("state.deniedTitle")}
        body={t("state.deniedBody", { path: props.path })}
      >
        <Button variant="outline" size="sm" onClick={props.onUp}>
          <ChevronUp />
          {t("state.goUp")}
        </Button>
      </Centered>
    );
  }

  if (props.kind === "empty") {
    return (
      <Centered
        icon={
          <FolderOpen className="text-muted-foreground size-8" aria-hidden />
        }
        title={t("state.emptyTitle")}
        body={t("state.emptyBody")}
      >
        <Button variant="outline" size="sm" onClick={props.onUpload}>
          <Upload />
          {t("actions.upload")}
        </Button>
      </Centered>
    );
  }

  return (
    <Centered
      icon={<SearchX className="text-muted-foreground size-8" aria-hidden />}
      title={
        props.query
          ? t("state.noMatches", { query: props.query })
          : t("state.onlyHidden", { count: props.hiddenCount })
      }
    >
      {props.query && (
        <Button variant="outline" size="sm" onClick={props.onClear}>
          {t("toolbar.clearSearch")}
        </Button>
      )}
      {props.onShowHidden && (
        <Button variant="ghost" size="sm" onClick={props.onShowHidden}>
          {t("actions.showHidden")}
        </Button>
      )}
    </Centered>
  );
}

function Centered({
  icon,
  title,
  body,
  details,
  children,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  details?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation("files");
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 px-6 text-center">
      {icon}
      <div className="flex max-w-md flex-col gap-1">
        <p className="font-medium">{title}</p>
        {body && <p className="text-muted-foreground text-small">{body}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
      {details && (
        <div className="flex max-w-md flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowDetails((s) => !s)}
            className="text-muted-foreground hover:text-foreground text-small underline-offset-4 hover:underline"
          >
            {showDetails ? t("state.hideDetails") : t("state.details")}
          </button>
          {showDetails && (
            <pre className="selectable bg-sidebar text-secondary-foreground text-caption max-w-md rounded-md px-3 py-2 text-left font-mono break-all whitespace-pre-wrap">
              {details}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
