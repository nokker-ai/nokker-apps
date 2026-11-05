/**
 * « Ta carte » on the Lokkal machine (PAY-AGENT §11, own_card): a `payments:to_pay` card whose mandate is own_card is
 * signed HERE with the local passkey (rpId `localhost`), never forwarded to nokker.ai. Only a card flagged
 * `local_passkey` by the core gets this; every other card keeps its behaviour.
 *
 * Flow: `POST /v1/local/approvals/{id}/challenge` → `navigator.credentials.get` on SHA-256(challenge + "." + decision)
 * → `POST /v1/local/approvals/{id}/decision` (`WebAuthnApprovalDecision`). Refusing needs no passkey (`…/decide`).
 */
import { useState } from "react";
import { NokkerApiError, type Approval, type LocalApprovalChallenge, type LocalPasskey, type NokkerClient, type WebAuthnApprovalDecision } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { writeJson } from "../viewState.js";

type Client = Pick<NokkerClient, "localApprovalChallenge" | "decideLocalWithPasskey" | "listLocalPasskeys">;

const toB64Url = (buf: ArrayBuffer): string => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64Url = (v: string): Uint8Array<ArrayBuffer> => {
  const b = atob(v.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((v.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};

/** Error code of a core answer (`{error: {code}}`), or null. */
export function errorCode(e: unknown): string | null {
  if (!(e instanceof NokkerApiError)) return null;
  const body = e.body as { error?: { code?: unknown } } | null;
  return typeof body?.error?.code === "string" ? body.error.code : null;
}

/** What the person reads for a refusal of the core (contract of p2/pay-owncard). */
export function localPasskeyErrorText(e: unknown): string {
  const code = errorCode(e);
  const status = e instanceof NokkerApiError ? e.status : 0;
  if (code === "no_passkey" || status === 412) return tr("No passkey on this machine yet: create one in My account, then approve.");
  if (code === "not_pending") return tr("This card was already decided.");
  if (code === "not_local") return tr("This card is not signed on this machine: approve it on app.nokker.ai.");
  if (code === "proof_invalid" || status === 403) return tr("The passkey signature was refused. Try again.");
  if (status === 404) return tr("Card not found or reserved for another account.");
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) return tr("Passkey signature cancelled.");
  return e instanceof Error ? e.message : String(e);
}

/** Signs the card's challenge with the local passkey and returns the decision body. `device_id` is the passkey's
 * device, found from the credential the authenticator used. */
export async function signLocalDecision(
  client: Client,
  approvalId: string,
  decision: "approve" | "reject",
  get: CredentialsContainer["get"] = (o) => navigator.credentials.get(o),
): Promise<{ challenge: LocalApprovalChallenge; body: WebAuthnApprovalDecision }> {
  const ch = await client.localApprovalChallenge(approvalId);
  if (!window.PublicKeyCredential) throw new Error(tr("WebAuthn is unavailable in this browser — passkey not possible."));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ch.challenge}.${decision}`)));
  const assertion = (await get({
    publicKey: {
      challenge: digest,
      rpId: ch.rp_id,
      allowCredentials: ch.allow_credentials.map((id) => ({ id: fromB64Url(id), type: "public-key" as const })),
      userVerification: "required",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error(tr("Passkey signature cancelled."));
  const credentialId = toB64Url(assertion.rawId);
  const { passkeys: keys }: { passkeys: LocalPasskey[] } = await client.listLocalPasskeys();
  const device = keys.find((k) => k.credential_id === credentialId);
  if (!device) throw new Error(tr("This passkey is not registered on this machine: create one in My account."));
  const r = assertion.response as AuthenticatorAssertionResponse;
  return {
    challenge: ch,
    body: {
      decision,
      device_id: device.device_id,
      challenge: ch.challenge,
      webauthn: { client_data_json: toB64Url(r.clientDataJSON), authenticator_data: toB64Url(r.authenticatorData), signature: toB64Url(r.signature) },
    },
  };
}

/** Buttons of a `local_passkey` card while it waits: approve with the local passkey, or refuse (no passkey needed). */
export function LocalPasskeyDecision({
  a,
  client,
  reject,
  onDecided,
}: {
  a: Approval;
  client: Client;
  /** The ordinary local refusal (`…/decide {decision: "reject", scope: "once"}`). */
  reject: () => Promise<void>;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const approve = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const { body } = await signLocalDecision(client, a.id, "approve");
      await client.decideLocalWithPasskey(a.id, body);
      onDecided();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const refuse = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await reject();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const noPasskey = err !== null && (errorCode(err) === "no_passkey" || (err instanceof NokkerApiError && err.status === 412));
  return (
    <div className="local-passkey" data-local-passkey="">
      <div className="bubble-actions">
        <button type="button" className="btn btn-brass" data-lp="approve" disabled={busy} onClick={() => void approve()}>
          {tr("Approve with my passkey")}
        </button>
        <button type="button" className="btn" data-lp="reject" disabled={busy} onClick={() => void refuse()}>
          {tr("Reject")}
        </button>
      </div>
      {err !== null ? (
        <p className="error" role="alert" data-lp-error={errorCode(err) ?? ""}>
          {localPasskeyErrorText(err)}
          {noPasskey ? (
            <>
              {" "}
              <a href="/" onClick={() => writeJson("tab", "account")}>
                {tr("Open My account")}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
