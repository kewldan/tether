import { useId } from "react";

/**
 * Tether mark: a phone with a terminal prompt on a short cable, on the Iris
 * tile (docs/design/project/AppIcon.dc.html, "Brand · App icon"). Cropped to
 * the tile like the Linux launcher icon. At 48 px and below the screen and
 * prompt merge into one chevron and the cable gets heavier, as in the
 * design's size ladder.
 */
export function Logo({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const id = useId();
  const iris = `${id}-iris`;
  const shine = `${id}-shine`;
  const screen = `${id}-screen`;
  const tile = `${id}-tile`;
  const small = size <= 48;

  return (
    <svg
      viewBox="100 100 824 824"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Tether"
    >
      <defs>
        <linearGradient id={iris} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9483FB" />
          <stop offset=".55" stopColor="#6D5AE6" />
          <stop offset="1" stopColor="#4A37C4" />
        </linearGradient>
        <linearGradient id={shine} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".28" />
          <stop offset=".45" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={screen} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2B2170" />
          <stop offset="1" stopColor="#17113F" />
        </linearGradient>
        <clipPath id={tile}>
          <rect x="100" y="100" width="824" height="824" rx="186" />
        </clipPath>
      </defs>
      <rect
        x="100"
        y="100"
        width="824"
        height="824"
        rx="186"
        fill={`url(#${iris})`}
      />
      <g clipPath={`url(#${tile})`}>
        {small ? (
          <>
            <path
              d="M512 690 V730 C512 800 560 812 640 812 H980"
              fill="none"
              stroke="#fff"
              strokeWidth="78"
              strokeLinecap="round"
            />
            <rect
              x="322"
              y="196"
              width="380"
              height="520"
              rx="90"
              fill="#fff"
            />
            <path
              d="M432 366 L512 430 L432 494"
              fill="none"
              stroke="#6D5AE6"
              strokeWidth="64"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <rect
              x="100"
              y="100"
              width="824"
              height="824"
              fill={`url(#${shine})`}
            />
            <path
              d="M512 676 V716 C512 790 556 806 626 806 H980"
              fill="none"
              stroke="#fff"
              strokeWidth="46"
              strokeLinecap="round"
            />
            <rect
              x="352"
              y="214"
              width="320"
              height="476"
              rx="66"
              fill="#fff"
            />
            <rect
              x="378"
              y="256"
              width="268"
              height="356"
              rx="30"
              fill={`url(#${screen})`}
            />
            <path
              d="M424 384 L478 428 L424 472"
              fill="none"
              stroke="#C4BBFC"
              strokeWidth="30"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M508 478 H588"
              stroke="#C4BBFC"
              strokeWidth="30"
              strokeLinecap="round"
            />
            <rect
              x="476"
              y="638"
              width="72"
              height="16"
              rx="8"
              fill="#C9C2F7"
            />
          </>
        )}
      </g>
      <rect
        x="100.5"
        y="100.5"
        width="823"
        height="823"
        rx="186"
        fill="none"
        stroke="#fff"
        strokeOpacity=".18"
        strokeWidth="2"
      />
    </svg>
  );
}
