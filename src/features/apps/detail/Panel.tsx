import { cn } from "cn";
import type { ReactNode } from "react";

/** Titled card used across the detail tabs (`.pg` on the AppDetail board). */
export function Panel({
  title,
  icon,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("bg-card overflow-hidden rounded-[10px] border", className)}
    >
      <h3 className="bg-sidebar text-small flex items-center gap-2 border-b px-3.5 py-2.5 font-semibold [&_svg]:size-3.5">
        {icon}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}

/** Two-column key/value list inside a panel. */
export function KeyValues({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="text-small m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 px-3.5 py-3">
      {items.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="selectable m-0 truncate">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
