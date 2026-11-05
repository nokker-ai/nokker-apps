/**
 * Sélecteur Google (Google Picker) pour Google Drive en `drive.file` (CONNECTORS-OAUTH §0.2, décision de dev du 05.11) :
 * le jeton (`drive.file` seul, grant séparé) n'existe que dans cette fonction, le temps du sélecteur. Jamais rangé
 * (ni localStorage, ni URL, ni journal), oublié à la fermeture. Rend les ids choisis (vide : annulé).
 * Mock : `developer_key === "mock-picker"` → sélecteur simulé dans la page (cases à cocher), sans Google.
 */
import type { PickerGrant } from "@nokker-apps/sdk";

const GAPI = "https://apis.google.com/js/api.js";

interface GooglePickerNs {
  PickerBuilder: new () => {
    addView(v: unknown): unknown;
    enableFeature(f: unknown): unknown;
    setOAuthToken(t: string): unknown;
    setDeveloperKey(k: string): unknown;
    setAppId(a: string): unknown;
    setLocale(l: string): unknown;
    setCallback(cb: (d: Record<string, unknown>) => void): unknown;
    build(): { setVisible(v: boolean): void; dispose?: () => void };
  };
  ViewId: { DOCS: unknown };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string };
}

declare global {
  interface Window {
    gapi?: { load(name: string, cb: () => void): void };
    google?: { picker?: GooglePickerNs };
  }
}

let loading: Promise<GooglePickerNs> | null = null;

function loadPicker(): Promise<GooglePickerNs> {
  if (window.google?.picker) return Promise.resolve(window.google.picker);
  loading ??= new Promise<GooglePickerNs>((ok, ko) => {
    const s = document.createElement("script");
    s.src = GAPI;
    s.async = true;
    s.onerror = () => {
      loading = null;
      ko(new Error("picker_unavailable"));
    };
    s.onload = () => window.gapi?.load("picker", () => (window.google?.picker ? ok(window.google.picker) : ko(new Error("picker_unavailable"))));
    document.head.appendChild(s);
  });
  return loading;
}

/** Sélecteur simulé (mock) : une boîte de dialogue native, une case par fichier proposé. */
export interface PickerTexts {
  title: string;
  select: string;
  cancel: string;
}

function mockPicker(grant: PickerGrant, texts: PickerTexts): Promise<string[]> {
  return new Promise((ok) => {
    const d = document.createElement("dialog");
    d.setAttribute("data-mock-picker", "");
    d.className = "cm-mock-picker";
    const title = document.createElement("h3");
    title.textContent = texts.title;
    d.appendChild(title);
    for (const f of grant.mock_files ?? []) {
      const l = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = f.id;
      l.append(cb, ` ${f.name}`);
      d.append(l, document.createElement("br"));
    }
    const done = (ids: string[]) => {
      d.close();
      d.remove();
      ok(ids);
    };
    const pick = document.createElement("button");
    pick.type = "button";
    pick.textContent = texts.select;
    pick.onclick = () => done([...d.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = texts.cancel;
    cancel.onclick = () => done([]);
    d.append(pick, " ", cancel);
    d.addEventListener("cancel", () => done([]));
    document.body.appendChild(d);
    d.showModal();
  });
}

export async function openPicker(grant: PickerGrant, lang: "fr" | "en", texts: PickerTexts): Promise<string[]> {
  if (grant.developer_key === "mock-picker") return mockPicker(grant, texts);
  const ns = await loadPicker();
  // Le jeton ne vit que le temps de cette promesse : passé au sélecteur, jamais copié ailleurs.
  return new Promise((ok) => {
    let picker: { setVisible(v: boolean): void; dispose?: () => void } | null = null;
    const b = new ns.PickerBuilder();
    b.addView(ns.ViewId.DOCS);
    b.enableFeature(ns.Feature.MULTISELECT_ENABLED);
    b.setOAuthToken(grant.access_token);
    b.setDeveloperKey(grant.developer_key);
    b.setAppId(grant.app_id);
    b.setLocale(lang);
    b.setCallback((data) => {
      const action = data[ns.Response.ACTION];
      if (action !== ns.Action.PICKED && action !== ns.Action.CANCEL) return;
      const docs = (data[ns.Response.DOCUMENTS] as Array<Record<string, unknown>> | undefined) ?? [];
      picker?.dispose?.();
      ok(action === ns.Action.PICKED ? docs.map((x) => String(x[ns.Document.ID])) : []);
    });
    picker = b.build();
    picker.setVisible(true);
  });
}
