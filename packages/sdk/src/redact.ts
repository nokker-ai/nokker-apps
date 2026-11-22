/**
 * Masquage SUR L'APPAREIL avant l'envoi (LOKKAL-PHONE §4.3.2, lot P9b ; contrat validé par dev le 06.11).
 *
 * Source unique : le noyau publie ses motifs (`GET /v1/redact/rules` → {version, rules, vectors}) ; l'app les applique
 * et rejoue les `vectors` au chargement (un jeu qui échoue est refusé : on garde la copie embarquée).
 * Dialecte commun à Python `re`, JS (`u`) et NSRegularExpression : ni lookbehind, ni groupe nommé, ni `\p{…}`, ni
 * quantificateur possessif ; les bornes s'écrivent `(?:^|[^0-9A-Za-z])(…)` et le GROUPE CAPTURÉ TERMINE le motif
 * (seul un lookahead peut le suivre), ce qui donne sa position de la même façon dans les trois langages.
 * Le repli par entropie du noyau n'est PAS appliqué sur l'appareil (faux positifs sur l'OCR).
 *
 * Forme vue par le modèle (relecture des textes, 06.11) : `⟦PHONE-1⟧` (U+27E6/U+27E7), codes neutres, n par fil et par code ; la MÊME
 * valeur garde le même marqueur dans tout le fil. Le dictionnaire marqueur → valeur reste sur l'appareil émetteur
 * (Vault natif) et ne contient que ce que CET appareil a émis dans CE fil ; l'affichage démasque ces marqueurs-là
 * seulement. Ailleurs (Telegram, web, autre appareil), le marqueur reste visible avec une note d'interface.
 */

export type RedactKind = "phone" | "email" | "iban" | "avs" | "card" | "birthdate" | "address" | "secret";
export type RedactValidator = "none" | "iban_mod97" | "luhn" | "avs_ean13";

/** Code du marqueur vu par le modèle, par famille — tranché à la relecture des textes le 06.11 : codes NEUTRES. */
export const REDACT_CODE: Record<RedactKind, string> = {
  phone: "PHONE",
  email: "EMAIL",
  iban: "IBAN",
  avs: "AHV",
  card: "CARD",
  birthdate: "BIRTHDATE",
  address: "ADDRESS",
  secret: "SECRET",
};

export interface RedactRule {
  id: string;
  kind: RedactKind;
  pattern: string;
  /** `i` seulement. */
  flags?: "i";
  /** Groupe qui porte la valeur ; il termine le motif. */
  group: 0 | 1 | 2;
  validate: RedactValidator;
  /** Mot-clé exigé JUSTE avant la valeur : au plus 12 caractères non numériques entre les deux (insensible à la
   * casse ; le moteur l'applique comme `(?:context)[^0-9\n]{0,12}$` sur les 40 caractères qui précèdent). */
  context?: string;
}

export interface RedactVector {
  text: string;
  expect: { kind: RedactKind; value: string }[];
}

export interface RedactRules {
  version: string;
  rules: RedactRule[];
  vectors: RedactVector[];
}

/** Métadonnées sans valeur jointes au message ou à la pièce (pour le noyau et les statistiques). */
export interface RedactionMeta {
  rules_version: string;
  counts: Partial<Record<string, number>>;
}

export const MARKER_RE = /⟦([A-Z]{2,12})-([1-9][0-9]{0,3})⟧/gu;
export const MAX_MARKERS = 200;

// ─────────────────────────────── dialecte ───────────────────────────────

/** Refus de ce que les trois moteurs ne lisent pas pareil. Rend la raison, ou null. */
export function dialectProblem(pattern: string): string | null {
  if (/\(\?<[=!]/.test(pattern)) return "lookbehind";
  if (/\(\?P?<[A-Za-z]/.test(pattern)) return "named_group";
  if (/\\[pP]\{/.test(pattern)) return "unicode_property";
  if (/[*+?}]\+/.test(pattern.replace(/\\./g, ""))) return "possessive";
  if (/\\b/.test(pattern)) return "word_boundary";
  return null;
}

// ─────────────────────────────── validateurs ───────────────────────────────

const digits = (s: string): string => s.replace(/[^0-9A-Za-z]/g, "");

export function ibanValid(raw: string): boolean {
  const s = digits(raw).toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function luhnValid(raw: string): boolean {
  const s = raw.replace(/[^0-9]/g, "");
  if (s.length < 13 || s.length > 19 || /^(\d)\1+$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** AVS : 13 chiffres commençant par 756, clé EAN-13. */
export function avsValid(raw: string): boolean {
  const s = raw.replace(/[^0-9]/g, "");
  if (!/^756[0-9]{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

const VALIDATE: Record<RedactValidator, (v: string) => boolean> = { none: () => true, iban_mod97: ibanValid, luhn: luhnValid, avs_ean13: avsValid };

// ─────────────────────────────── recherche ───────────────────────────────

export interface RedactSpan {
  start: number;
  end: number;
  kind: RedactKind;
  value: string;
  rule: string;
}

interface Compiled {
  rule: RedactRule;
  re: RegExp;
  ctx: RegExp | null;
}
const cache = new WeakMap<RedactRule[], Compiled[]>();

function compile(rules: RedactRule[]): Compiled[] {
  let c = cache.get(rules);
  if (c) return c;
  c = [];
  for (const rule of rules) {
    if (dialectProblem(rule.pattern) || (rule.context && dialectProblem(rule.context))) continue;
    try {
      c.push({ rule, re: new RegExp(rule.pattern, `gu${rule.flags === "i" ? "i" : ""}`), ctx: rule.context ? new RegExp(`(?:${rule.context})[^0-9\\n]{0,12}$`, "iu") : null });
    } catch {
      /* motif illisible ici : ignoré, et les vecteurs le diront */
    }
  }
  cache.set(rules, c);
  return c;
}

/** Valeurs sensibles du texte, sans chevauchement (ordre des règles = priorité), hors des marqueurs déjà posés. */
export function findSensitive(text: string, rules: RedactRule[], kinds?: ReadonlySet<RedactKind>): RedactSpan[] {
  const taken: Array<[number, number]> = [];
  for (const m of text.matchAll(MARKER_RE)) taken.push([m.index!, m.index! + m[0].length]);
  const overlaps = (a: number, b: number): boolean => taken.some(([x, y]) => a < y && x < b);
  const out: RedactSpan[] = [];
  for (const { rule, re, ctx } of compile(rules)) {
    if (kinds && !kinds.has(rule.kind)) continue;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = m[rule.group];
      if (!value) continue;
      const end = m.index! + m[0].length;
      const start = end - value.length;
      if (overlaps(start, end) || !VALIDATE[rule.validate](value)) continue;
      if (ctx && !ctx.test(text.slice(Math.max(0, start - 40), start))) continue;
      taken.push([start, end]);
      out.push({ start, end, kind: rule.kind, value, rule: rule.id });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Rejoue les vecteurs publiés avec les règles : la liste des écarts (vide = jeu accepté). */
export function checkVectors(r: RedactRules): string[] {
  const bad: string[] = [];
  for (const v of r.vectors) {
    const got = findSensitive(v.text, r.rules).map((s) => `${s.kind}:${s.value}`);
    const want = v.expect.map((e) => `${e.kind}:${e.value}`);
    if (got.join("|") !== want.join("|")) bad.push(`${JSON.stringify(v.text)} → ${got.join(", ") || "∅"} (attendu ${want.join(", ") || "∅"})`);
  }
  return bad;
}

// ─────────────────────────────── dictionnaire d'un fil ───────────────────────────────

/** Paires marqueur → valeur d'UN fil, ÉMISES PAR CET APPAREIL. Vit sur l'appareil seulement (Vault natif), jamais dans
 * un stockage web. Seuls ces marqueurs se démasquent : un ⟦IBAN-1⟧ écrit par un tiers (page, mail) dans un autre fil, ou
 * qu'aucun envoi de cet appareil n'a produit, reste tel quel (sinon, fuite). */
export interface RedactDict {
  [marker: string]: string;
}

const norm = (kind: RedactKind, v: string): string =>
  kind === "email" ? v.toLowerCase() : kind === "phone" || kind === "iban" || kind === "card" || kind === "avs" ? v.replace(/[^0-9A-Za-z+]/g, "").toUpperCase() : v;

/** Marqueur d'une valeur dans ce fil : le même qu'avant si la valeur y est déjà, sinon le suivant de son code. */
export function markerFor(dict: RedactDict, kind: RedactKind, value: string): { marker: string; added: boolean } {
  const code = REDACT_CODE[kind];
  const key = norm(kind, value);
  let max = 0;
  for (const [mk, v] of Object.entries(dict)) {
    const m = /^⟦([A-Z]+)-([0-9]+)⟧$/u.exec(mk);
    if (!m || m[1] !== code) continue;
    if (norm(kind, v) === key) return { marker: mk, added: false };
    max = Math.max(max, Number(m[2]));
  }
  return { marker: `⟦${code}-${max + 1}⟧`, added: true };
}

export interface Masked {
  text: string;
  /** Nouvelles paires à ranger dans le Vault (celles déjà connues n'y sont pas). */
  added: RedactDict;
  spans: Array<RedactSpan & { marker: string }>;
  meta: RedactionMeta;
}

/**
 * Masque `text` avec le dictionnaire du fil. `keep` : valeurs que la personne a choisi de laisser en clair (index des
 * spans de `findSensitive`, ou valeurs exactes). Idempotent : un marqueur n'est jamais re-masqué.
 */
export function maskText(text: string, rules: RedactRules, dict: RedactDict, opts: { kinds?: ReadonlySet<RedactKind>; keep?: ReadonlySet<string> } = {}): Masked {
  const spans = findSensitive(text, rules.rules, opts.kinds).filter((s) => !opts.keep?.has(s.value)).slice(0, MAX_MARKERS);
  const work: RedactDict = { ...dict };
  const added: RedactDict = {};
  const done: Masked["spans"] = [];
  for (const s of spans) {
    const { marker, added: isNew } = markerFor(work, s.kind, s.value);
    if (isNew) work[marker] = added[marker] = s.value;
    done.push({ ...s, marker });
  }
  let out = "";
  let at = 0;
  for (const s of done) {
    out += text.slice(at, s.start) + s.marker;
    at = s.end;
  }
  out += text.slice(at);
  const counts: Record<string, number> = {};
  for (const s of done) counts[REDACT_CODE[s.kind]] = (counts[REDACT_CODE[s.kind]] ?? 0) + 1;
  return { text: out, added, spans: done, meta: { rules_version: rules.version, counts } };
}

export type DisplayPart = { text: string } | { marker: string; value: string | null };

/** Découpe un texte reçu (réponse de Nina) pour l'affichage : marqueurs connus démasqués, inconnus en puce. */
export function unmaskForDisplay(text: string, dict: RedactDict): DisplayPart[] {
  const parts: DisplayPart[] = [];
  let at = 0;
  for (const m of text.matchAll(MARKER_RE)) {
    if (m.index! > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ marker: m[0], value: dict[m[0]] ?? null });
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Texte affiché, en clair là où le dictionnaire connaît la valeur (copier sur l'appareil). */
export const unmaskText = (text: string, dict: RedactDict): string => text.replace(MARKER_RE, (mk) => dict[mk] ?? mk);

/**
 * Écarts entre la copie EMBARQUÉE (secours) et l'export du NOYAU (qui fait foi) : ids des règles, motifs, validateurs,
 * contextes, et vecteurs (par texte). Vide = la copie suit le noyau. Sert au test de dérive (redact-drift.test.ts).
 */
export function compareRedactRules(embedded: RedactRules, core: RedactRules): string[] {
  const out: string[] = [];
  const byId = (r: RedactRules) => new Map(r.rules.map((x) => [x.id, x]));
  const e = byId(embedded);
  const c = byId(core);
  for (const id of c.keys()) if (!e.has(id)) out.push(`règle absente de la copie : ${id}`);
  for (const id of e.keys()) if (!c.has(id)) out.push(`règle absente du noyau : ${id}`);
  for (const [id, cr] of c) {
    const er = e.get(id);
    if (!er) continue;
    for (const k of ["kind", "pattern", "flags", "group", "validate", "context"] as const) if ((er[k] ?? null) !== (cr[k] ?? null)) out.push(`${id}.${k} diffère`);
  }
  const vec = (r: RedactRules) => new Map(r.vectors.map((v) => [v.text, JSON.stringify(v.expect)]));
  const ev = vec(embedded);
  const cv = vec(core);
  for (const [t, x] of cv) if (ev.get(t) !== x) out.push(`vecteur du noyau ${ev.has(t) ? "différent" : "absent"} : ${JSON.stringify(t)}`);
  for (const t of ev.keys()) if (!cv.has(t)) out.push(`vecteur absent du noyau : ${JSON.stringify(t)}`);
  return out;
}
