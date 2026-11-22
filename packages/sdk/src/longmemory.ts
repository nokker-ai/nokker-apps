/** Mémoire longue côté nuage (`/v1/memory/long`, session du compte) : 404 si la fonction est éteinte → cacher l'écran. */
/** `preference` : catégorie ajoutée par le noyau (lue et affichée ; pas proposée à la création). */
export type LongKind = "rule" | "feedback" | "fact" | "preference";
export type LongScope = "user" | "household";

export interface LongNote {
  name: string;
  scope: LongScope;
  kind: LongKind;
  title: string;
  text: string;
  audience?: string;
  created_at: string;
  updated_at: string;
  /** Écrite par la personne qui regarde. */
  mine: boolean;
  household_id?: string;
}

export interface LongMemory {
  household: { id: string; payer: boolean; profile: unknown } | null;
  notes: LongNote[];
}

export interface LongNoteInput {
  scope: "user";
  kind?: LongKind;
  title: string;
  text: string;
  audience?: string;
}

/** 201 écrite ; 200 `duplicate` (déjà notée) ; 202 `pending` (membre : la note part en relecture du foyer). */
export type LongNoteResult = { note: LongNote; duplicate?: boolean } | { pending: { id: string; status: string; scope: string } };
