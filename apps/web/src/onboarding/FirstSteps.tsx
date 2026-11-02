/**
 * Fil vide : de quoi obtenir une première réponse utile tout de suite (temps jusqu'à la première valeur). Trois demandes
 * qui marchent sans rien relier (le clic remplit la zone de saisie, la personne ajuste puis envoie) et, tant qu'aucune
 * boîte mail n'est reliée, un raccourci vers les connecteurs de Mon compte — relier ses outils n'est jamais un passage
 * obligé avant de parler à Nina.
 */
import React, { useEffect, useState } from "react";
import type { NokkerClient } from "@nokker-apps/sdk";
import { t, type Key, type Lang } from "./i18n.js";

const IDEAS: Key[] = ["firstIdeaDraft", "firstIdeaSearch", "firstIdeaWhat"];

export function FirstSteps({
  client,
  lang,
  fill,
  onConnect,
}: {
  client: NokkerClient;
  lang: Lang;
  fill: (text: string) => void;
  /** Ouvre Mon compte (connecteurs). Absent : pas de raccourci (Lokkal local, passerelle). */
  onConnect?: () => void;
}): React.ReactElement {
  const [mailLinked, setMailLinked] = useState<boolean | null>(null);
  useEffect(() => {
    if (!onConnect) return;
    let live = true;
    client.listConnectors().then(
      (l) => live && setMailLinked(l.connectors.some((c) => c.kind === "mail" && c.state !== "absent")),
      () => live && setMailLinked(true), // en cas de doute, on n'insiste pas
    );
    return () => {
      live = false;
    };
  }, [client, onConnect]);
  return (
    <div className="first-steps" aria-labelledby="first-steps-title">
      <h2 id="first-steps-title" className="first-steps-title">{t(lang, "firstTitle")}</h2>
      <ul className="first-ideas">
        {IDEAS.map((k) => (
          <li key={k}>
            <button type="button" className="first-idea" onClick={() => fill(t(lang, k))}>
              {t(lang, k)}
            </button>
          </li>
        ))}
      </ul>
      {onConnect && mailLinked === false ? (
        <p className="first-connect fine">
          {t(lang, "firstConnectBody")}{" "}
          <button type="button" className="first-connect-btn" onClick={onConnect}>
            {t(lang, "firstConnect")}
          </button>
        </p>
      ) : null}
    </div>
  );
}
