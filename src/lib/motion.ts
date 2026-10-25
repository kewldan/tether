import type { Transition } from "motion/react";

/**
 * The three springs of the design system (docs/design/project/Motion.dc.html).
 * - snappy: menus, presses, tab/segment indicators. Never overshoots.
 * - smooth: dialogs, sheets, sidebar collapse, list insert/remove.
 * - bouncy: toasts, drop landing, success checks only.
 * Logcat, terminal output and charts are never animated.
 */
export const spring = {
  snappy: { type: "spring", stiffness: 632, damping: 50.3, mass: 1 },
  smooth: { type: "spring", stiffness: 322, damping: 33.0, mass: 1 },
  bouncy: { type: "spring", stiffness: 224, damping: 23.3, mass: 1 },
} as const satisfies Record<string, Transition>;

/** Fades only: 120–160 ms ease-out. */
export const fade = {
  duration: 0.14,
  ease: [0.2, 0.8, 0.2, 1],
} as const satisfies Transition;
