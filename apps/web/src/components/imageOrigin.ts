/** Origine des images d'un tour (contrat r44) : pièce jointe de la personne, ou image lue par Nina avec un outil. */
import type { ThreadMessage } from "@nokker-apps/sdk";

export type TurnImage = NonNullable<ThreadMessage["images"]>[number];

/** Sans origine, ou `user` : envoyée par la personne. Toute origine `tool:…` : lue par Nina, jamais attribuée à la personne. */
export const isPersonImage = (im: Pick<TurnImage, "origin">): boolean => !im.origin || im.origin === "user";

export function splitImages(images: TurnImage[] | undefined): { person: TurnImage[]; tool: TurnImage[] } {
  const list = images ?? [];
  return { person: list.filter(isPersonImage), tool: list.filter((im) => !isPersonImage(im)) };
}

/** Images lues par Nina, par index de tour (elles se montrent sous la réponse de ce tour). */
export function toolImagesByTurn(messages: ThreadMessage[]): Map<number, TurnImage[]> {
  const out = new Map<number, TurnImage[]>();
  for (const m of messages) {
    if (m.role !== "user") continue;
    const { tool } = splitImages(m.images);
    if (tool.length) out.set(m.index, [...(out.get(m.index) ?? []), ...tool]);
  }
  return out;
}
