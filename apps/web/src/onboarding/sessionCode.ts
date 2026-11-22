/**
 * Ouverture d'un Lokkal par un CODE à usage unique (`#code=<code>`) : le lien affiché par l'installeur, `nokker open`
 * ou un script ne porte jamais le jeton local. Le code (60 s, une seule fois) est échangé contre un jeton de SESSION
 * distinct (opaque, révocable, 30 jours glissants) que la page garde comme elle gardait le jeton local.
 *
 * Ordre voulu : le fragment est EFFACÉ de la barre d'adresse (`history.replaceState`) AVANT tout appel réseau, y compris
 * en cas d'échec ; le code ne vit donc dans l'URL que le temps du chargement. Le jeton local venu d'un `#token=` reste
 * lu pendant la transition (`takeLocalToken`), retiré à rc.9.40.
 */
import { keepLocalToken } from "./localToken.js";
import { keepKioskToken } from "../kiosk/mode.js";
import { keepScope, scopeOfExchange, type AccessScope } from "../kiosk/scope.js";

/** Pourquoi l'échange n'a pas ouvert la page : le lien a servi, est périmé (60 s), ou la machine ne répond pas. */
export type CodeFailure = "used" | "expired" | "limited" | "unreachable" | "scope";

/** Où va le jeton : `/kiosk` n'accepte qu'un jeton `kiosk` (jamais la clé de l'app) ; ailleurs un jeton `kiosk` est jeté. */
export type CodeTarget = "app" | "kiosk" | "present";

const NOTE_KEY = "nokker.code-note";

/** Lit `code=` du fragment ; `null` si absent. Efface le fragment (le code seulement : un `#token=` voisin reste pour `takeLocalToken`). */
export function takeCodeFromHash(): string | null {
  let code: string | null = null;
  try {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return null;
    const parts = raw.split("&");
    const keep: string[] = [];
    for (const p of parts) {
      const m = /^code=([^&]+)$/.exec(p);
      if (m) code = decodeURIComponent(m[1]!);
      else keep.push(p);
    }
    if (code === null) return null;
    window.history.replaceState(null, "", window.location.pathname + window.location.search + (keep.length ? `#${keep.join("&")}` : ""));
  } catch {
    /* fragment illisible : traité comme absent */
  }
  return code;
}

/** Échange le code (déjà sorti du fragment par `takeCodeFromHash`, AVANT tout réseau) contre un jeton de session, gardé
 * comme l'était le jeton local. `true` : la page est ouverte ; `false` : l'échange a échoué (la raison est notée pour la
 * page de clé, `takeCodeNote`). */
export async function redeemSessionCode(base: string, code: string, { persistent = true, fetchImpl = fetch, target = "app" }: { persistent?: boolean; fetchImpl?: typeof fetch; target?: CodeTarget } = {}): Promise<boolean> {
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, "")}/v1/local/session-code/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `expect` : la portée que cette page attend. Un autre code → 409 sans être consommé ni créer de session (noyau qui le sait) ;
      // un noyau qui l'ignore laisse le contrôle ci-dessous (jeton jeté).
      body: JSON.stringify(target === "app" ? { code } : { code, expect: target }),
      credentials: "omit",
    });
    if (res.ok) {
      const body = (await res.json()) as { token?: unknown; scope?: unknown };
      if (typeof body.token === "string" && body.token) {
        const scope: AccessScope = scopeOfExchange(body);
        // Le kiosque n'ouvre que sur un jeton `kiosk` ; un jeton `kiosk` ne devient jamais la clé de l'app. Jeté, jamais gardé.
        if (target === "kiosk" ? scope !== "kiosk" : scope === "kiosk") return noteFailure("scope");
        if (target === "kiosk") keepKioskToken(body.token);
        else {
          // `/present` : la clé de l'app, le temps de l'onglet seulement (la démo ne laisse rien sur la machine du Chrome).
          keepLocalToken(body.token, { persistent: target === "present" ? false : persistent });
          keepScope(scope);
        }
        return true;
      }
      return noteFailure("unreachable");
    }
    if (res.status === 429) return noteFailure("limited");
    let c = "";
    try {
      const b = (await res.json()) as { error?: { code?: string } | string };
      c = typeof b.error === "string" ? b.error : (b.error?.code ?? "");
    } catch {
      /* corps illisible */
    }
    return noteFailure(c === "wrong_scope" || res.status === 409 ? "scope" : c === "code_expired" ? "expired" : c === "code_used" || res.status === 410 ? "used" : "unreachable");
  } catch {
    return noteFailure("unreachable");
  }
}

function noteFailure(f: CodeFailure): false {
  try {
    window.sessionStorage.setItem(NOTE_KEY, f);
  } catch {
    /* stockage indisponible : la page de clé n'aura que sa consigne habituelle */
  }
  return false;
}

/** La raison de l'échec d'un lien `#code=`, lue UNE fois par la page de clé (puis oubliée). */
export function takeCodeNote(): CodeFailure | null {
  try {
    const v = window.sessionStorage.getItem(NOTE_KEY);
    window.sessionStorage.removeItem(NOTE_KEY);
    return v === "used" || v === "expired" || v === "limited" || v === "unreachable" || v === "scope" ? v : null;
  } catch {
    return null;
  }
}
