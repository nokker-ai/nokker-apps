/**
 * Garde du mode nœud maison (LOKKAL-PHONE §4.4 ; décision dev 06.11) : sur un appareil en mode maison (pièce
 * commune), le « toc toc toc » est coupé et ne peut pas être relancé. Lu au démarrage puis à chaque état du nœud.
 * Le natif refuse aussi le micro à la WebView dans ce mode (deuxième couche).
 */
import { setKnockBlocked } from "../knock/controller.js";
import { nodePlugin, type NodeStatus } from "./node.js";

export function applyHomeGuard(s: Pick<NodeStatus, "home" | "knock"> | null | undefined): void {
  setKnockBlocked(s?.home?.on ? "home" : null, !!s?.knock?.on, !!s?.knock?.available);
}

export function watchHomeMode(): void {
  const p = nodePlugin();
  if (!p) return;
  void p.status().then(applyHomeGuard, () => undefined);
  void Promise.resolve(p.addListener?.("nodeState", applyHomeGuard)).catch(() => undefined);
}
