export type InstallMode = "installed" | "prompt" | "ios" | "ios-inapp" | "android-menu" | "none";

export interface InstallEnv {
  ua: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasPrompt: boolean;
}

/** Quel geste d'installation proposer. Pur : l'environnement est passé en argument pour être testable. */
export function installMode(env: InstallEnv): InstallMode {
  if (env.standalone) return "installed";
  if (env.hasPrompt) return "prompt";
  const ios = /iPhone|iPad|iPod/.test(env.ua) || (env.platform === "MacIntel" && env.maxTouchPoints > 1);
  if (ios) {
    // Navigateur intégré (Telegram, Gmail…) : pas de « Sur l'écran d'accueil », il faut passer par Safari.
    return /Safari\//.test(env.ua) || /CriOS|FxiOS|EdgiOS/.test(env.ua) ? "ios" : "ios-inapp";
  }
  return /Android/.test(env.ua) ? "android-menu" : "none";
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
