import { createContext, type ReactNode } from "react";

/**
 * Lets the shell put a status banner under every page's header and dim
 * the page body (e.g. "Pixel 8 Pro disconnected"), without pages knowing.
 */
export const PageStatusContext = createContext<{
  banner: ReactNode;
  dimmed: boolean;
} | null>(null);
