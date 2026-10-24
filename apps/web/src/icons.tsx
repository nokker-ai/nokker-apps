import React from "react";

type IconName =
  | "disk" | "search" | "bell" | "timer" | "terminal" | "play" | "page" | "bot" | "shield"
  | "chevronDown" | "chevronUp" | "share" | "close" | "send" | "plus" | "grip" | "arrowRight"
  | "link" | "check" | "soundOn" | "soundOff" | "menu" | "chat" | "crew" | "goto" | "sun" | "moon";

const P: Record<IconName, React.ReactNode> = {
  disk: (<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>),
  search: (<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.8-3.8" /></>),
  bell: (<><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></>),
  timer: (<><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9 2h6" /></>),
  terminal: (<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 9l3 3-3 3M12 15h5" /></>),
  play: (<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M10 9v6l5-3z" /></>),
  page: (<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>),
  bot: (<><rect x="4" y="8" width="16" height="12" rx="4" /><path d="M12 8V4M8 14h.01M16 14h.01M9 17h6" /></>),
  shield: (<><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>),
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  share: (<><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6" /></>),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  send: <path d="M5 12h14M13 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  grip: (<><circle cx="9" cy="6" r="1.3" /><circle cx="15" cy="6" r="1.3" /><circle cx="9" cy="12" r="1.3" /><circle cx="15" cy="12" r="1.3" /><circle cx="9" cy="18" r="1.3" /><circle cx="15" cy="18" r="1.3" /></>),
  arrowRight: (<><path d="M4 12h12M12 7l5 5-5 5" /><path d="M20 5v14" /></>),
  link: (<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" /></>),
  check: <path d="M5 12l5 5 9-10" />,
  soundOn: (<><path d="M4 10v4h4l5 4V6L8 10z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></>),
  soundOff: (<><path d="M4 10v4h4l5 4V6L8 10z" /><path d="M17 9l5 6M22 9l-5 6" /></>),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  chat: <path d="M5 5h14v10H9l-4 4z" />,
  crew: (<><rect x="3" y="5" width="7" height="14" rx="2" /><rect x="14" y="5" width="7" height="9" rx="2" /></>),
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  goto: (<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>),
};

export function Icon({ name, size = 16, stroke = 1.9, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  const filled = name === "grip";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {P[name]}
    </svg>
  );
}

export type { IconName };
