import React from "react";

type IconName =
  | "disk" | "search" | "bell" | "timer" | "terminal" | "play" | "page" | "image" | "bot" | "shield" | "screen" | "pointer"
  | "chevronDown" | "chevronUp" | "share" | "close" | "send" | "plus" | "grip" | "arrowRight"
  | "link" | "check" | "soundOn" | "soundOff" | "menu" | "chat" | "crew" | "goto" | "sun" | "moon" | "folder"
  | "user" | "users" | "home" | "box" | "plug" | "alert" | "plan" | "code" | "cpu" | "back" | "mic" | "micOff" | "pause";

const P: Record<IconName, React.ReactNode> = {
  disk: (<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>),
  search: (<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.8-3.8" /></>),
  bell: (<><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></>),
  timer: (<><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9 2h6" /></>),
  terminal: (<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 9l3 3-3 3M12 15h5" /></>),
  play: (<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M10 9v6l5-3z" /></>),
  image: (<><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M21 17l-5-5-9 9" /></>),
  page: (<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  bot: (<><rect x="4" y="8" width="16" height="12" rx="4" /><path d="M12 8V4M8 14h.01M16 14h.01M9 17h6" /></>),
  pointer: (<><path d="M4 4l7 16 2.5-6.5L20 11z" /><path d="M13.5 13.5L19 19" /></>),
  screen: (<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>),
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
  pause: (<><path d="M9 6v12M15 6v12" /></>),
  soundOff: (<><path d="M4 10v4h4l5 4V6L8 10z" /><path d="M17 9l5 6M22 9l-5 6" /></>),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  chat: <path d="M5 5h14v10H9l-4 4z" />,
  crew: (<><rect x="3" y="5" width="7" height="14" rx="2" /><rect x="14" y="5" width="7" height="9" rx="2" /></>),
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  user: (<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  users: (<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></>),
  home: (<><path d="M4 11l8-7 8 7" /><path d="M6 9.5V20h12V9.5" /><path d="M10 20v-5h4v5" /></>),
  box: (<><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>),
  plug: (<><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>),
  alert: (<><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17.5h.01" /></>),
  plan: (<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h5" /></>),
  code: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />,
  cpu: (<><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>),
  back: <path d="M15 5l-7 7 7 7" />,
  mic: (<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  micOff: (<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" /></>),
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
