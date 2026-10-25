/**
 * Page du panneau. CSP stricte : rien de distant, un seul script (nonce), une seule feuille servie par VS Code, aucun style
 * ni script en ligne, aucune connexion réseau depuis la page (le jeton et l'API restent du côté de l'extension).
 */

export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource}`,
    `font-src ${cspSource}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function newNonce(random: (n: number) => Uint8Array): string {
  return Buffer.from(random(18)).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}

/** Texte sûr dans un attribut ou un nœud HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** `strings` : libellés du panneau déjà traduits (`webviewStrings`), lus par le script dans `data-strings`. */
export function panelHtml(opts: { cspSource: string; nonce: string; scriptUri: string; styleUri: string; strings: Record<string, string>; lang: string }): string {
  const csp = contentSecurityPolicy(opts.cspSource, opts.nonce);
  const s = (k: string): string => escapeHtml(opts.strings[k] ?? k);
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${opts.styleUri}">
<title>Nokker</title>
</head>
<body data-strings="${escapeHtml(JSON.stringify(opts.strings))}">
<header id="status" class="status" role="status" aria-live="polite"></header>
<main id="log" class="log" aria-live="polite"></main>
<footer class="composer">
  <div id="review" class="review" hidden></div>
  <div id="context" class="context"></div>
  <textarea id="input" rows="3" placeholder="${s("placeholder")}" aria-label="${s("message")}"></textarea>
  <div class="actions">
    <button id="file" type="button" class="secondary" title="${s("addFile")}" aria-label="${s("addFile")}">@</button>
    <button id="send" type="button">${s("send")}</button>
    <button id="stop" type="button" class="secondary" hidden>${s("stop")}</button>
  </div>
</footer>
<script nonce="${opts.nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}
