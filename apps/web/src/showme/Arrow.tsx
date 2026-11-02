import React from "react";

/** The big arrow, drawn pointing up-left (tip at 3,3); the side class flips it so it comes from the roomier side. */
export function Arrow({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={`showme-arrow ${className ?? ""}`} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path d="M3 3 L40 15 L28 22 L60 54 L54 60 L22 28 L15 40 Z" />
    </svg>
  );
}
