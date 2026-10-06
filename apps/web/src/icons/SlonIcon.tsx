/** Sloncord icon set — rounded stroke icons, 24×24, currentColor. */

export type SlonIconName =
  | "close"
  | "mic"
  | "mic-off"
  | "headphones"
  | "headphones-off"
  | "screen"
  | "expand"
  | "lock"
  | "speaker"
  | "phone"
  | "bell"
  | "bell-off"
  | "trash"
  | "reply"
  | "forward"
  | "attach"
  | "play"
  | "download"
  | "chevron-down"
  | "chevron-right"
  | "chevron-left"
  | "arrow-down"
  | "plus"
  | "kick"
  | "star"
  | "diamond"
  | "dots"
  | "send"
  | "profile"
  | "settings"
  | "logout"
  | "hangup";

type SlonIconProps = {
  name: SlonIconName;
  size?: number;
  className?: string;
  title?: string;
};

const S = {
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Slash() {
  return <path d="M5 5l14 14" {...S} />;
}

function SlashTight() {
  // Slightly shorter + centered slash for “off” glyphs on small buttons.
  return <path d="M7 7l10 10" {...S} />;
}

const ICON_PATHS: Record<SlonIconName, JSX.Element> = {
  close: <path d="M6 6l12 12M18 6L6 18" {...S} />,

  mic: (
    <>
      <rect x="9" y="4" width="6" height="10" rx="3" {...S} />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v3" {...S} />
    </>
  ),

  "mic-off": (
    <>
      <rect x="9" y="4" width="6" height="10" rx="3" {...S} />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v3" {...S} />
      <Slash />
    </>
  ),

  headphones: (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" {...S} />
      <rect x="3" y="13" width="4" height="7" rx="2" {...S} />
      <rect x="17" y="13" width="4" height="7" rx="2" {...S} />
    </>
  ),

  "headphones-off": (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" {...S} />
      <rect x="3" y="13" width="4" height="7" rx="2" {...S} />
      <rect x="17" y="13" width="4" height="7" rx="2" {...S} />
      <Slash />
    </>
  ),

  screen: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="2" {...S} />
      <path d="M9 20h6M12 17v3" {...S} />
    </>
  ),

  expand: (
    <>
      <path d="M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6" {...S} />
    </>
  ),

  lock: (
    <>
      <rect x="6" y="11" width="12" height="10" rx="2" {...S} />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" {...S} />
      <circle cx="12" cy="16" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),

  speaker: (
    <>
      <path d="M5 10v4h4l5 4V6l-5 4H5z" {...S} />
      <path d="M16 9.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10" {...S} />
    </>
  ),

  phone: (
    <path
      d="M8.5 4.2c.4 0 .8.2 1 .6l1.4 2.6c.2.4.1.9-.2 1.2l-1.6 1.6a12.5 12.5 0 0 0 5.7 5.7l1.6-1.6c.3-.3.8-.4 1.2-.2l2.6 1.4c.4.2.6.6.6 1v2.8c0 .6-.4 1-1 1.1-1.8.2-7.2-.6-10.6-4-3.4-3.4-4.2-8.8-4-10.6.1-.6.5-1 1.1-1H8.5z"
      {...S}
    />
  ),

  bell: (
    <>
      <path d="M12 4c-2.8 0-5 2.2-5 5v3.5L5 15h14l-2-2.5V9c0-2.8-2.2-5-5-5z" {...S} />
      <path d="M10 18a2 2 0 0 0 4 0" {...S} />
    </>
  ),

  "bell-off": (
    <>
      <path d="M12 4c-2.8 0-5 2.2-5 5v3.5L5 15h14l-2-2.5V9c0-2.8-2.2-5-5-5z" {...S} />
      <path d="M10 18a2 2 0 0 0 4 0" {...S} />
      <Slash />
    </>
  ),

  trash: (
    <>
      <path d="M4 7h16M9 7V5h6v2M8 7l1 12h6l1-12" {...S} />
      <path d="M10 11v5M14 11v5" {...S} />
    </>
  ),

  reply: (
    <>
      <path d="M10 9 6 12l4 3" {...S} />
      <path d="M6 12h9a5 5 0 0 1 5 5v2" {...S} />
    </>
  ),

  forward: (
    <>
      <path d="M14 9 18 12l-4 3" {...S} />
      <path d="M18 12H9a5 5 0 0 0-5 5v2" {...S} />
    </>
  ),

  attach: (
    <path
      d="M16 7.5l-7.2 7.2a3 3 0 0 0 4.2 4.2l7.8-7.8a5 5 0 0 0-7.1-7.1L6.3 14.7"
      {...S}
    />
  ),

  play: (
    <path
      d="M9 7.5l9 4.5-9 4.5V7.5z"
      fill="currentColor"
      stroke="none"
    />
  ),

  download: (
    <>
      <path d="M12 4v10M8.5 10.5 12 14l3.5-3.5" {...S} />
      <path d="M5 18h14" {...S} />
    </>
  ),

  "chevron-down": <path d="M6 9l6 6 6-6" {...S} />,

  "chevron-right": <path d="M9 6l6 6-6 6" {...S} />,

  "chevron-left": <path d="M15 6l-6 6 6 6" {...S} />,

  "arrow-down": (
    <>
      <path d="M12 5v10M8.5 11.5 12 15l3.5-3.5" {...S} />
    </>
  ),

  plus: <path d="M12 5v14M5 12h14" {...S} />,

  kick: <path d="M7 7l10 10M17 7 7 17" {...S} />,

  star: (
    <path
      d="M12 4.5l2.2 4.5 4.9.7-3.5 3.4.8 4.9L12 15.8l-4.4 2.3.8-4.9-3.5-3.4 4.9-.7L12 4.5z"
      fill="currentColor"
      stroke="none"
    />
  ),

  diamond: (
    <path
      d="M12 4l7 8-7 8-7-8 7-8z"
      fill="currentColor"
      stroke="none"
    />
  ),

  dots: (
    <>
      <circle cx="6" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="18" cy="12" r="1.5" fill="currentColor" />
    </>
  ),

  send: (
    <path
      d="M4 20l16-8L4 4v6l10 2-10 2v6z"
      fill="currentColor"
      stroke="none"
    />
  ),

  profile: (
    <>
      <circle cx="12" cy="9" r="3.5" {...S} />
      <path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" {...S} />
    </>
  ),

  settings: (
    <>
      <path
        d="M12.22 2h-.44l-.62 2.4c-.6.24-1.14.55-1.65.95L7.27 4.5l-2 2 1.85 2.24c-.4.51-.71 1.05-.95 1.65L3.77 11v2l2.4.62c.24.6.55 1.14.95 1.65L5.27 17.5l2 2 2.24-1.85c.51.4 1.05.71 1.65.95l.62 2.4h.44l.62-2.4c.6-.24 1.14-.55 1.65-.95l2.24 1.85 2-2-1.85-2.24c.4-.51.71-1.05.95-1.65l2.4-.62v-2l-2.4-.62c-.24-.6-.55-1.14-.95-1.65L18.73 6.5l-2-2-2.24 1.85c-.51-.4-1.05-.71-1.65-.95L12.22 2z"
        {...S}
      />
      <circle cx="12" cy="12" r="3" {...S} />
    </>
  ),

  logout: (
    <>
      <path d="M10 17H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4M14 16l4-4-4-4M18 12H10" {...S} />
    </>
  ),

  hangup: (
    <>
      {/* Discord-like handset (no slash): curve + two handles */}
      <path d="M6 13.5c2.2-1.2 4.6-1.8 6-1.8s3.8.6 6 1.8" {...S} />
      <path d="M6.5 13.1 4 15.6a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l2.2-2.2" {...S} />
      <path d="M17.5 13.1 20 15.6a1 1 0 0 1 0 1.4l-1.6 1.6a1 1 0 0 1-1.4 0l-2.2-2.2" {...S} />
    </>
  ),
};

export function SlonIcon({ name, size = 18, className, title }: SlonIconProps) {
  const cls = className ? `slon-icon ${className}` : "slon-icon";
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cls}
      data-icon={name}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/** All icon names for galleries / Storybook. */
export const SLON_ICON_NAMES = Object.keys(ICON_PATHS) as SlonIconName[];
