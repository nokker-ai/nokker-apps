/** Partage reçu pendant que personne n'est connecté : une ligne neutre, dans le flux de l'écran de connexion, au-dessus
 * de la carte. Connecté, l'interface transforme aussitôt le partage en fil. Lue au lancement, au retour au premier plan,
 * sur `nokker://share` et quand un partage vient d'être repris — jamais par minuterie. Rien hors de l'app native. */
import React, { useEffect, useState } from "react";
import { tr } from "../i18n/index.js";
import { isNativeShell } from "./native.js";
import { SHARES_CHANGED, onShareSignal, pendingShares } from "./share.js";

export function ShareNote(): React.ReactElement | null {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!isNativeShell()) return;
    let alive = true;
    const look = (): void => void pendingShares().then((s) => alive && setCount(s.length));
    look();
    const off = onShareSignal(look);
    window.addEventListener(SHARES_CHANGED, look);
    return () => {
      alive = false;
      off();
      window.removeEventListener(SHARES_CHANGED, look);
    };
  }, []);
  if (!count) return null;
  return (
    <p className="share-note" role="status" data-share-pending={count}>
      {count === 1 ? tr("Something was shared to Nokker: it opens in a new session once you are signed in.") : tr("{0} items were shared to Nokker: they open in new sessions once you are signed in.", String(count))}
    </p>
  );
}
