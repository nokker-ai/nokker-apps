/**
 * Masquage sur l'appareil (LOKKAL-PHONE §4.3.2, lot P9b) côté interface. Le moteur est celui du SDK (redact.ts) ; le
 * dictionnaire ⟦CODE-n⟧ → valeur vit dans le plugin natif `NokkerVault` (fichier protégé, hors sauvegarde), PAR FIL, et
 * ne contient que ce que CET appareil a émis. Jamais de valeur dans localStorage : seuls les réglages (familles) y sont.
 * Sans le plugin (web, autre appareil), rien n'est masqué ni démasqué ici : les marqueurs s'affichent avec une note.
 */
import { checkVectors, REDACT_RULES_SNAPSHOT, type NokkerClient, type RedactDict, type RedactKind, type RedactRules } from "@nokker-apps/sdk";
import { isNativeShell } from "./native.js";

export interface VaultPlugin {
  status(): Promise<{ available: boolean; rules_version: string | null }>;
  setRules(o: { rules: RedactRules }): Promise<{ version: string }>;
  get(o: { thread: string }): Promise<{ pairs: RedactDict }>;
  put(o: { thread: string; pairs: RedactDict }): Promise<{ count: number }>;
  forget(o: { thread: string }): Promise<void>;
  forgetAll(): Promise<void>;
}

export function vaultPlugin(w: unknown = globalThis): VaultPlugin | undefined {
  return isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { NokkerVault?: VaultPlugin } } }).Capacitor?.Plugins?.NokkerVault : undefined;
}

let current: RedactRules = REDACT_RULES_SNAPSHOT;
let loading: Promise<boolean> | null = null;

/**
 * Règles du noyau si elles passent leurs vecteurs, sinon la copie embarquée ; remises au natif, qui les revérifie.
 * Rend `true` seulement si le NATIF les a acceptées : sinon le masquage est indisponible et l'appelant doit refuser
 * d'envoyer un texte produit sur l'appareil (fail-closed).
 */
export function loadRedactRules(client: Pick<NokkerClient, "getRedactRules">, plugin: VaultPlugin | undefined = vaultPlugin()): Promise<boolean> {
  loading ??= (async () => {
    try {
      const r = await client.getRedactRules();
      if (r?.rules?.length && r.vectors?.length && checkVectors(r).length === 0) current = r;
    } catch {
      /* hors ligne, ou noyau d'avant P9b : copie embarquée */
    }
    if (!plugin) return false;
    try {
      await plugin.setRules({ rules: current });
      return true;
    } catch {
      // Le natif refuse ce jeu (vecteurs en échec sous ICU) : on retente avec la copie embarquée, sinon indisponible.
      if (current === REDACT_RULES_SNAPSHOT) return false;
      current = REDACT_RULES_SNAPSHOT;
      return plugin.setRules({ rules: current }).then(
        () => true,
        () => false,
      );
    }
  })();
  return loading;
}

/** Pour les tests : oublie le chargement mémorisé. */
export function resetRedactRulesForTests(): void {
  loading = null;
  current = REDACT_RULES_SNAPSHOT;
}

export const redactRules = (): RedactRules => current;

const KINDS_KEY = "nokker.redact.kinds";
export const ALL_KINDS: RedactKind[] = ["phone", "email", "iban", "avs", "card", "birthdate", "address", "secret"];

/** Familles masquées (toutes par défaut). Un réglage, pas une valeur : localStorage suffit. */
export function redactKinds(): Set<RedactKind> {
  try {
    const raw = localStorage.getItem(KINDS_KEY);
    const list = raw ? (JSON.parse(raw) as RedactKind[]) : ALL_KINDS;
    return new Set(list.filter((k) => ALL_KINDS.includes(k)));
  } catch {
    return new Set(ALL_KINDS);
  }
}
export function setRedactKinds(k: Set<RedactKind>): void {
  try {
    localStorage.setItem(KINDS_KEY, JSON.stringify([...k]));
  } catch {
    /* navigation privée */
  }
}
