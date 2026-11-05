/**
 * Plusieurs boîtes mail et agendas par profil, partage contrôlé (core docs/CONNECTORS-MULTI.md, p2/connectors-multi
 * ee126e4 ; décisions du 05.11 : partage en attente visible, monter de niveau = carte forte / descendre = immédiat,
 * `DELETE …/grants/me`, `bad_label`). Routes servies quand `features.connectors_multi` est vrai ; sinon le web garde
 * l'écran d'avant (un connecteur par nature, `PUT /v1/connectors/{mail|calendar}`).
 */
import type { CalendarSettings, ConnectorKind, ConnectorState, MailSettings } from "./onboarding.js";

/** Natures : `mail` et `calendar` (068), plus celles de CONNECTORS-OAUTH (069) quand le noyau les annonce
 * (`presets.kinds`). */
export type MultiKind = ConnectorKind | "contacts" | "files" | "tasks" | "pages";
export const MULTI_KINDS: readonly MultiKind[] = ["mail", "calendar", "contacts", "files", "tasks", "pages"];

/** Accès au connecteur : `owner` (à moi), sinon le niveau qu'on m'a donné. */
export type ConnectorAccess = "owner" | ConnectorLevel;
/** mail : `read` | `send` ; agenda : `read` | `write`. */
export type ConnectorLevel = "read" | "send" | "write";

export interface ConnectorGrant {
  account_id: string;
  /** Partie locale de l'adresse (les comptes n'ont pas de prénom). */
  name: string;
  minor?: boolean;
  level: ConnectorLevel;
  /** `pending` : premier accès, carte d'approbation forte pas encore décidée (`approval_id`). */
  status: "active" | "pending";
  granted_at?: string | null;
  /** Montée de niveau en attente de sa carte forte : `level` reste actif jusqu'à l'approbation. */
  pending_level?: ConnectorLevel;
  approval_id?: string | null;
}

export interface MultiConnector {
  /** `mb_…` (mail) ou `ca_…` (agenda). */
  id: string;
  kind: MultiKind;
  label: string;
  /** Un seul par compte et par nature ; toujours faux sur un connecteur partagé avec moi. */
  default: boolean;
  /** `reconnect` : compte OAuth révoqué ou expiré, son propriétaire doit le reconnecter. */
  state: Exclude<ConnectorState, "absent"> | "reconnect";
  /** CONNECTORS-OAUTH : `password` (068) ou `oauth` ; `provider` et `oauth_account` sur un connecteur OAuth à moi. */
  auth?: "password" | "oauth";
  provider?: string;
  /** `connectors` : services encore reliés à ce compte (le jeton est révoqué avec le dernier). */
  oauth_account?: { id: string; email: string; state: "ok" | "reconnect"; connectors: number };
  /** Réglages publics ; partagé avec moi : `address` seulement (mail). */
  settings?: Record<string, string | number>;
  connected_at?: string | null;
  last_ok_at?: string | null;
  locality?: "cloud" | "local";
  access: ConnectorAccess;
  /** Partagé avec moi : le propriétaire, et quand on me l'a partagé. */
  owner?: { account_id: string; name: string };
  granted_at?: string | null;
  /** À moi : les partages (actifs et en attente). */
  grants?: ConnectorGrant[];
}

/** Bénéficiaire possible : même foyer, moi exclu. */
export interface ConnectorMember {
  account_id: string;
  name: string;
  minor: boolean;
}

export interface ConnectorsMultiPresets {
  mail: string[];
  calendar: string[];
  /** Aide d'une ligne sous le mot de passe, par préréglage. */
  mail_help?: Record<string, { fr: string; en: string }>;
  /** Réglage `settings.region` d'un préréglage (`{zoho: ["eu", "com"]}`). */
  mail_regions?: Record<string, string[]>;
  /** Affichés « bientôt » (OAuth2 à venir), pas choisissables. */
  mail_soon?: string[];
  /** CONNECTORS-OAUTH : fournisseurs OAuth (`enabled` = client configuré) et natures servies. */
  /** `picker` : Google Drive, grant séparé (`drive.file` seul) avec le sélecteur Google ; start {services:["files"]} seul. */
  oauth?: Array<{ provider: string; services: MultiKind[]; enabled: boolean; separate?: boolean; picker?: { developer_key: string; app_id: string } }>;
  kinds?: MultiKind[];
  /** Ajout sans OAuth : CardDAV / iCloud (contacts), iCloud Rappels (tâches). */
  contacts?: string[];
  tasks?: string[];
  /** Aide d'une ligne par nature et préréglage (`help.contacts.icloud`). */
  help?: Partial<Record<MultiKind, Record<string, { fr: string; en: string }>>>;
}

export interface ConnectorsMultiListing {
  connectors: MultiConnector[];
  members: ConnectorMember[];
  presets: ConnectorsMultiPresets;
}

export type MultiMailSettings = MailSettings & { region?: string };

/** Contacts (CardDAV, iCloud) et tâches (iCloud Rappels) sans OAuth (CONNECTORS-OAUTH §5). */
export interface PasswordKindSettings {
  mode: string;
  username: string;
  url?: string;
}

export interface CreateConnectorRequest {
  kind: MultiKind;
  label?: string;
  settings: MultiMailSettings | CalendarSettings | PasswordKindSettings;
  /** Entre une fois, ne ressort jamais. */
  secret: string;
}

export interface PatchConnectorRequest {
  label?: string;
  default?: true;
}

/** `updated` : niveau descendu, immédiat (pas de carte). */
export type GrantResult = { status: "pending"; approval_id: string } | { status: "unchanged" } | { status: "updated" };

/** Au plus 10 connecteurs par compte et par nature ; libellé de 1 à 40 caractères, sans « / », « | » ni « · »
 * (séparateurs des ids qualifiés et des textes du modèle) et jamais de la forme d'un id. */
export const CONNECTOR_LABEL_FORBIDDEN = /[/|·]/;
export const CONNECTORS_MAX_PER_KIND = 10;
export const CONNECTOR_LABEL_MAX = 40;

/** Niveaux qu'on peut donner pour une nature, du plus faible au plus fort. */
export function connectorLevels(kind: MultiKind): ConnectorLevel[] {
  return kind === "mail" ? ["read", "send"] : ["read", "write"];
}
