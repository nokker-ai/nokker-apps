/**
 * Clavier du téléphone (LOKKAL-PHONE §1.1 W7). Android Chrome réduit la page quand le clavier s'ouvre
 * (`interactive-widget=resizes-content`) et la coque native aussi (`@capacitor/keyboard` en `resize: "native"`) ; iOS
 * Safari, non : le clavier recouvre le bas de la page, donc le composeur. On publie alors la hauteur VISIBLE en
 * `--vvh` (lue par `.app`), et on l'enlève quand le clavier se ferme (retour à `100dvh`).
 */
export interface ViewportLike {
  height: number;
  offsetTop: number;
  addEventListener(t: "resize" | "scroll", f: () => void): void;
  removeEventListener(t: "resize" | "scroll", f: () => void): void;
}

/** Hauteur visible si le clavier mange la page (au moins 80 px de moins que la fenêtre), sinon null. */
export function keyboardHeight(innerHeight: number, vv: Pick<ViewportLike, "height" | "offsetTop">): number | null {
  const visible = Math.round(vv.height);
  return innerHeight - visible - vv.offsetTop > 80 ? visible : null;
}

export function watchKeyboard(w: Window = window): () => void {
  const vv = w.visualViewport as ViewportLike | null | undefined;
  if (!vv) return () => undefined;
  const root = w.document.documentElement;
  const apply = (): void => {
    const h = keyboardHeight(w.innerHeight, vv);
    if (h === null) root.style.removeProperty("--vvh");
    else {
      root.style.setProperty("--vvh", `${h}px`);
      // iOS fait défiler la page pour montrer le champ : la coque reste en place, c'est elle qui rétrécit.
      if (w.scrollY) w.scrollTo(0, 0);
    }
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    root.style.removeProperty("--vvh");
  };
}
