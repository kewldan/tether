/** Tether brand mark: a phone on a cable, on the primary tile. */
export function Logo() {
  return (
    <span className="bg-primary text-primary-foreground flex size-5 flex-none items-center justify-center rounded-md">
      <svg
        viewBox="0 0 24 24"
        className="size-[13px]"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="7" y="3" width="10" height="13" rx="2" />
        <path d="M12 16v2a3 3 0 0 0 3 3h4" />
      </svg>
    </span>
  );
}
