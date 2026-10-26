import type { ReactNode } from "react";

/** One settings row, as `SettingsPage` renders it. */
export interface SettingsRow {
  id: string;
  title: string;
  desc?: ReactNode;
  /** Extra words that should match the search. */
  keywords?: string;
  control: ReactNode;
}
