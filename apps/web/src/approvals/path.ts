export function approvalIdFromPath(pathname: string): string | null {
  const m = /^\/approvals\/([^/]+)\/?$/.exec(pathname);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
