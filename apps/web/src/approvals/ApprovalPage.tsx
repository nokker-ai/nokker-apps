/** Page `/approvals/:id` : cible du bouton de la carte d'approbation envoyée sur le Telegram du testeur. */
import React from "react";
import { BRAND } from "@nokker-apps/brand";
import { ApprovalCard } from "../bubbles/kinds.js";
import { StoreContext } from "../context.js";
import { useNokker } from "../store.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { Welcome } from "../welcome/Welcome.js";
import { DeletingScreen } from "../components/AccountTab.js";


export function ApprovalPage({ id }: { id: string }): React.ReactElement {
  const store = useNokker();
  // Suppression du compte accordée ici : plus aucune requête n'aboutit (compte suspendu), écran fixe et déconnexion.
  if (store.accountGone) return <DeletingScreen lang={uiLang()} />;
  if (store.access !== "ready" && store.access !== "booting") return <Welcome {...store} lang={uiLang()} />;
  return (
    <StoreContext.Provider value={store}>
      <main className="approval-page" style={{ maxWidth: 520, margin: "0 auto", padding: "24px 16px" }}>
        <h1>{BRAND.productName} · Approbation</h1>
        {store.ready ? <ApprovalCard approvalId={id} uid={`page-${id}`} /> : <div className="boot fine">{store.status}</div>}
        <p className="fine">
          <a href="/">Retour au bureau</a>
        </p>
      </main>
    </StoreContext.Provider>
  );
}
