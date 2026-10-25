import type { MouseEvent, RefObject } from "react";

import type { FileEntry } from "../api";

/** Shared by the table and the grid view. */
export interface ListProps {
  entries: FileEntry[];
  selected: Set<string>;
  /** Keyboard cursor. */
  focused: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onRowClick: (entry: FileEntry, event: MouseEvent) => void;
  onToggle: (entry: FileEntry) => void;
  onToggleAll: () => void;
  onOpen: (entry: FileEntry) => void;
}
