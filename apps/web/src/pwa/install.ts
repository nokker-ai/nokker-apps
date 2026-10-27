/** `desktop-prompt` : ordinateur dont le navigateur propose l'installation (beforeinstallprompt) — une ligne discrète,
 * jamais l'étape « écran d'accueil » d'un téléphone. */
export type InstallMode = "installed" | "prompt" | "ios" | "ios-inapp" | "android-menu" | "desktop-prompt" | "none";

export interface InstallEnv {
  ua: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasPrompt: boolean;
  /** `(pointer: coarse)` : écran tactile comme pointeur principal. */
  coarse: boolean;
  /** Écran étroit (téléphone, tablette en portrait). */
  narrow: boolean;
}

/** Quel geste d'installation proposer. Pur : l'environnement est passé en argument pour être testable. */
export function installMode(env: InstallEnv): InstallMode {
  // iPadOS 13+ se présente en « Macintosh » : le tactile le trahit (maxTouchPoints > 1).
  const ios = /iPhone|iPad|iPod/.test(env.ua) || (env.platform === "MacIntel" && env.maxTouchPoints > 1);
  const android = /Android/.test(env.ua);
  // Mobile : iOS/Android, ou pointeur grossier sur écran étroit. Sur ordinateur, pas d'étape « écran d'accueil ».
  const mobile = ios || android || (env.coarse && env.narrow);
  if (!mobile) return env.hasPrompt && !env.standalone ? "desktop-prompt" : "none";
  if (env.standalone) return "installed";
  if (env.hasPrompt) return "prompt";
  if (ios) {
    // Navigateur intégré (Telegram, Gmail…) : pas de « Sur l'écran d'accueil », il faut passer par Safari.
    return /Safari\//.test(env.ua) || /CriOS|FxiOS|EdgiOS/.test(env.ua) ? "ios" : "ios-inapp";
  }
  return android ? "android-menu" : "none";
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function subscribeInstall(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const hasInstallPrompt = (): boolean => deferred !== null;

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function currentInstallMode(): InstallMode {
  return installMode({
    ua: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: isStandalone(),
    hasPrompt: hasInstallPrompt(),
    coarse: window.matchMedia("(pointer: coarse)").matches,
    narrow: window.matchMedia("(max-width: 900px)").matches,
  });
}

export async function promptInstall(): Promise<void> {
  const ev = deferred;
  if (!ev) return;
  deferred = null;
  emit();
  await ev.prompt();
  await ev.userChoice;
}

/** À appeler avant le montage de React : l'événement part dès le chargement, il ne se rejoue pas. */
export function listenInstall(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}
