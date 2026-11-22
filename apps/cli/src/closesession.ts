/** Fermeture de la session de code à la sortie (`DELETE /v1/local/sessions/{fil}`) : le noyau supprime le bac docker
 * de la session (dossier de travail et historique restent). Au mieux : délai court, erreurs ignorées, la sortie
 * n'est jamais bloquée — noyau muet ou absent, on sort quand même. */

let closer: (() => Promise<void>) | null = null;

/** L'écran enregistre ici comment fermer la session ouverte (`null` au démontage). */
export function setSessionCloser(fn: (() => Promise<void>) | null): void {
  closer = fn;
}

/** Appelle la fermeture, au plus `maxMs` ; ne rejette jamais ; une seule fermeture par session. */
export async function closeOpenSession(maxMs = 1500): Promise<void> {
  const fn = closer;
  if (!fn) return;
  closer = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxMs);
    timer.unref?.();
  });
  try {
    await Promise.race([fn().catch(() => undefined), limit]);
  } catch {
    /* ignoré */
  } finally {
    if (timer) clearTimeout(timer);
  }
}
