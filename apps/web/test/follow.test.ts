import { describe, expect, it } from "vitest";
import { noteSeen, pickActive, type Seen } from "../src/browser/follow.js";

const empty = new Map<string, Seen>();

describe("/present sans id : suivre la session navigateur en cours", () => {
  it("attente tant qu'aucune session n'est vue", () => {
    expect(pickActive(empty)).toBeNull();
  });

  it("la plus récente session non finie est montrée", () => {
    let m = noteSeen(empty, "bs_a", false, 1000);
    expect(pickActive(m)).toBe("bs_a");
    m = noteSeen(m, "bs_b", false, 2000); // Nina ouvre une autre session : on bascule
    expect(pickActive(m)).toBe("bs_b");
    m = noteSeen(m, "bs_a", false, 3000); // un signe de la plus ancienne la rend plus récente
    expect(pickActive(m)).toBe("bs_a");
  });

  it("une session finie n'est plus montrée, et un événement en retard ne la rouvre jamais", () => {
    let m = noteSeen(empty, "bs_a", false, 1000);
    m = noteSeen(m, "bs_a", true, 2000);
    expect(pickActive(m)).toBeNull();
    m = noteSeen(m, "bs_a", false, 2500); // browser.frame arrivé après browser.ended
    expect(pickActive(m)).toBeNull();
  });

  it("la fin de la session montrée retombe sur l'autre session encore active", () => {
    let m = noteSeen(empty, "bs_a", false, 1000);
    m = noteSeen(m, "bs_b", false, 2000);
    m = noteSeen(m, "bs_b", true, 3000);
    expect(pickActive(m)).toBe("bs_a");
  });

  it("ne modifie jamais la table reçue", () => {
    const m = noteSeen(empty, "bs_a", false, 1);
    noteSeen(m, "bs_a", true, 2);
    expect(m.get("bs_a")?.ended).toBe(false);
  });
});
