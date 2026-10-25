import { mockIPC } from "@tauri-apps/api/mocks";

/**
 * Browser-only fake backend so the UI can be developed and checked with
 * `bun run dev` outside Tauri. Each `src/dev/mocks/<feature>.ts` default-
 * exports a map of command name → handler; they are merged here.
 * Never imported in a Tauri build (see main.tsx).
 */
export type MockHandler = (args: Record<string, unknown>) => unknown;
export type MockHandlers = Record<string, MockHandler>;

const modules = import.meta.glob<MockHandlers>("./mocks/*.ts", {
  eager: true,
  import: "default",
});

export function installMockBackend() {
  const handlers: MockHandlers = Object.assign({}, ...Object.values(modules));
  mockIPC((cmd, args) => {
    const handler = handlers[cmd];
    if (!handler) {
      console.warn(`[mock backend] no handler for ${cmd}`, args);
      return null;
    }
    return handler((args ?? {}) as Record<string, unknown>);
  });
}

/** A Tauri `Channel` passed as a command argument, as seen by the mock. */
export function channel<T>(value: unknown): (message: T) => void {
  const ch = value as { onmessage: (message: T) => void };
  return (message) => ch.onmessage(message);
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
