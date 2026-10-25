/**
 * Boîte mail de la machine (LOKKAL §7.25), onglet Machine d'un Lokkal (jeton local) : UNE boîte IMAP/SMTP du
 * propriétaire local, de localité `local` (rien ne quitte la machine). Le mot de passe n'apparaît jamais ici : on choisit
 * le NOM d'un secret déjà rangé dans le coffre (section du dessus) ; le noyau teste IMAP puis SMTP avant de ranger.
 * Envoyer et mettre à la corbeille depuis cette boîte demandent toujours une carte forte.
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type LocalMailCard, type MailSettings, type NokkerClient } from "@nokker-apps/sdk";
import "./localmail.css";

type Toast = (text: string, tone?: "ok" | "error") => void;

const CODE_TEXT: Record<string, string> = {
  auth_failed: "Identifiants refusés par le serveur de mail : vérifie l'adresse, l'utilisateur et le secret choisi.",
  unreachable: "Serveur de mail injoignable depuis cette machine.",
  tls_failed: "La connexion chiffrée au serveur de mail a échoué.",
  protocol_error: "Le serveur de mail a répondu de façon inattendue.",
  port_not_allowed: "Port refusé : IMAP 993 ou 143, SMTP 465 ou 587.",
  host_blocked: "Cet hôte n'est pas joignable par Nokker (adresse privée ou réservée).",
  not_configured: "Aucune boîte reliée.",
  key_missing: "Le coffre de la machine est indisponible ou scellé.",
};

/** Message d'une erreur des connecteurs (`{error: <code>, message}`) : celui du noyau tel quel, sinon le code en clair. */
export function mailError(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const b = e.body as { error?: string | { message?: string }; message?: string } | undefined;
    if (e.status === 403) return "La boîte mail de la machine se règle sur la machine seulement, jamais par la passerelle.";
    if (typeof b?.message === "string" && b.message) return b.message;
    const code = typeof b?.error === "string" ? b.error : undefined;
    if (code && CODE_TEXT[code]) return CODE_TEXT[code];
    if (typeof b?.error === "object" && b.error?.message) return b.error.message;
    return `refus de la machine (${e.status})`;
  }
  return "la machine ne répond pas";
}

const PRESET_LABEL: Record<string, string> = { gmail: "Gmail", icloud: "iCloud", infomaniak: "Infomaniak", fastmail: "Fastmail", custom: "Autre serveur (IMAP/SMTP)" };

export function LocalMailbox({ client, toast }: { client: NokkerClient; toast: Toast }): React.ReactElement | null {
  const [card, setCard] = useState<LocalMailCard | null>(null);
  const [presets, setPresets] = useState<string[]>([]);
  const [names, setNames] = useState<string[] | null>(null);
  const [absent, setAbsent] = useState(false);
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState("gmail");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const l = await client.listLocalConnectors();
      setCard(l.connectors.find((c) => c.kind === "mail") ?? { kind: "mail", state: "absent", locality: "local" });
      setPresets(l.presets.mail);
      setAbsent(false);
    } catch (e) {
      if (e instanceof NokkerApiError && e.status === 404) setAbsent(true); // connecteurs locaux non pris en charge
      else setError(mailError(e));
    }
    try {
      setNames((await client.listLocalSecrets()).secrets.map((s) => s.name));
    } catch {
      setNames(null); // coffre illisible : le nom se tape à la main
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  if (absent) return null;
  if (!card)
    return error ? (
      <div className="machine-section local-mail">
        <h2>Boîte mail de la machine</h2>
        <p className="error" role="alert">
          {error}
        </p>
        <button type="button" className="btn" onClick={() => (setError(null), void load())}>
          Réessayer
        </button>
      </div>
    ) : null;
  const linked = card.state !== "absent";
  const s = card.settings ?? {};

  const save = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const get = (k: string): string => String(d.get(k) ?? "").trim();
    const settings: MailSettings =
      preset === "custom"
        ? { preset: "custom", address: get("address"), ...(get("username") ? { username: get("username") } : {}), imap_host: get("imap_host"), imap_port: Number(get("imap_port")), smtp_host: get("smtp_host"), smtp_port: Number(get("smtp_port")) }
        : { preset, address: get("address"), ...(get("username") ? { username: get("username") } : {}) };
    setBusy("save");
    setError(null);
    try {
      const c = await client.putLocalMail({ settings, secret: get("secret") });
      setCard(c);
      setOpen(false);
      toast(c.message ? `Boîte reliée : ${c.message}.` : "Boîte reliée.", "ok");
    } catch (er) {
      setError(mailError(er));
    } finally {
      setBusy(null);
    }
  };
  const test = async (): Promise<void> => {
    setBusy("test");
    setError(null);
    try {
      const r = await client.testLocalMail();
      if (r.ok) toast(`Boîte vérifiée : ${r.message}.`, "ok");
      else setError((r.code && CODE_TEXT[r.code]) || r.message);
      await load();
    } catch (er) {
      setError(mailError(er));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (): Promise<void> => {
    setBusy("remove");
    setConfirm(false);
    try {
      await client.deleteLocalMail();
      toast("Boîte retirée de la machine. Si une boîte est reliée sur nokker.ai, ses outils reprennent la main.", "ok");
      await load();
    } catch (er) {
      setError(mailError(er));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="machine-section local-mail">
      <h2>Boîte mail de la machine</h2>
      <p className="fine">
        Une boîte reliée ici reste sur la machine : ses messages ne passent jamais par nokker.ai, et les tours qui la lisent ne partent pas au miroir. Envoyer ou mettre à la corbeille demande toujours ton
        accord (carte forte). Si une boîte est aussi reliée sur nokker.ai, c'est celle de la machine que tes sessions utilisent.
      </p>
      {linked ? (
        <div className="local-mail-card">
          <p>
            <strong>{String(s.address ?? "")}</strong> <span className={`chip ${card.state === "ok" ? "role-member" : ""}`}>{card.state === "ok" ? "vérifiée" : "pas encore vérifiée"}</span> <span className="chip">reste sur la machine</span>
          </p>
          <p className="fine">
            {PRESET_LABEL[String(s.preset)] ?? String(s.preset ?? "")} · IMAP <code>{String(s.imap_host ?? "")}</code> · SMTP <code>{String(s.smtp_host ?? "")}</code>
            {s.username && s.username !== s.address ? (
              <>
                {" "}
                · utilisateur <code>{String(s.username)}</code>
              </>
            ) : null}
          </p>
          <p className="fine">
            Mot de passe : secret <code>{card.secret ?? "—"}</code> du coffre
            {card.last_ok_at ? ` · dernier test réussi le ${new Date(card.last_ok_at).toLocaleString("fr-CH")}` : ""}
          </p>
        </div>
      ) : (
        <p className="fine">Aucune boîte reliée à la machine.</p>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {!open ? (
        <span className="team-row-actions">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => (setOpen(true), setError(null), setPreset(String(s.preset ?? presets[0] ?? "gmail")), void load())}>
            {linked ? "Modifier" : "Relier une boîte"}
          </button>
          {linked ? (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void test()}>
                {busy === "test" ? "Test…" : "Tester"}
              </button>
              {confirm ? (
                <>
                  <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void remove()}>
                    Oui, retirer
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
                    Annuler
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setConfirm(true)}>
                  Retirer
                </button>
              )}
            </>
          ) : null}
        </span>
      ) : (
        <form className="secret-form local-mail-form" autoComplete="off" onSubmit={(e) => void save(e)}>
          <label htmlFor="lm-preset">Fournisseur</label>
          <select id="lm-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {[...presets, "custom"].map((p) => (
              <option key={p} value={p}>
                {PRESET_LABEL[p] ?? p}
              </option>
            ))}
          </select>
          <label htmlFor="lm-address">Adresse</label>
          <input id="lm-address" name="address" type="email" required autoCapitalize="none" spellCheck={false} defaultValue={linked ? String(s.address ?? "") : ""} />
          <label htmlFor="lm-user">Utilisateur</label>
          <input id="lm-user" name="username" autoCapitalize="none" spellCheck={false} placeholder="l'adresse, par défaut" defaultValue={linked && s.username !== s.address ? String(s.username ?? "") : ""} />
          {preset === "custom" ? (
            <>
              <label htmlFor="lm-imap">Serveur IMAP</label>
              <input id="lm-imap" name="imap_host" required autoCapitalize="none" spellCheck={false} defaultValue={linked ? String(s.imap_host ?? "") : ""} />
              <label htmlFor="lm-imap-port">Port IMAP</label>
              <select id="lm-imap-port" name="imap_port" defaultValue="993">
                <option value="993">993 (TLS)</option>
                <option value="143">143 (STARTTLS)</option>
              </select>
              <label htmlFor="lm-smtp">Serveur SMTP</label>
              <input id="lm-smtp" name="smtp_host" required autoCapitalize="none" spellCheck={false} defaultValue={linked ? String(s.smtp_host ?? "") : ""} />
              <label htmlFor="lm-smtp-port">Port SMTP</label>
              <select id="lm-smtp-port" name="smtp_port" defaultValue="587">
                <option value="465">465 (TLS)</option>
                <option value="587">587 (STARTTLS)</option>
              </select>
            </>
          ) : null}
          <label htmlFor="lm-secret">Mot de passe (secret du coffre)</label>
          {names === null ? (
            <input id="lm-secret" name="secret" required autoCapitalize="none" spellCheck={false} placeholder="NOM du secret" aria-describedby="lm-secret-tip" />
          ) : names.length ? (
            <select id="lm-secret" name="secret" required defaultValue={card.secret ?? ""} aria-describedby="lm-secret-tip">
              <option value="" disabled>
                choisir un nom…
              </option>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          ) : (
            <p id="lm-secret" className="fine">
              Le coffre est vide.
            </p>
          )}
          <p id="lm-secret-tip" className="fine local-mail-tip">
            Le mot de passe ne s'écrit jamais ici : range-le d'abord dans le coffre ci-dessus (ou <code>nokker secret set NOM</code>), puis choisis son nom. Pour Gmail et iCloud, un mot de passe d'application.
          </p>
          <span className="team-row-actions local-mail-actions">
            <button type="submit" className="btn btn-brass" disabled={busy !== null || names?.length === 0}>
              {busy === "save" ? "Test de la boîte…" : "Tester et relier"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => (setOpen(false), setError(null))}>
              Annuler
            </button>
          </span>
        </form>
      )}
    </div>
  );
}
