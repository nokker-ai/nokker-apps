/**
 * Parseur SSE indépendant du DOM — pas d'`EventSource` (API navigateur absente de Node et de React
 * Native). CLIENT-API.md : « SSE, `event:` + `data:` JSON ». On parse un flux de texte générique
 * (`AsyncIterable<string>`), ce qui permet de tester le parseur avec un simple générateur, sans
 * serveur ni `fetch`, et de le réutiliser pour `/v1/chat/completions` (frames `data:` seules, sans
 * `event:`) comme pour `/v1/events` (frames `event:` + `data:`).
 */

export interface RawSSEFrame {
  /** `undefined` si le flux n'envoie pas de ligne `event:` (cas de `/v1/chat/completions`). */
  event: string | undefined;
  /** Concaténation des lignes `data:` du frame (plusieurs lignes `data:` → jointes par "\n", comme le veut la spec SSE). */
  data: string;
  id: string | undefined;
}

/** Découpe un flux de texte brut en frames SSE (un frame = lignes jusqu'à la ligne vide qui le termine). */
export async function* parseSSEFrames(chunks: AsyncIterable<string>): AsyncGenerator<RawSSEFrame> {
  let buffer = "";
  let event: string | undefined;
  let dataLines: string[] = [];
  let id: string | undefined;

  function resetFrame(): void {
    event = undefined;
    dataLines = [];
    id = undefined;
  }

  /** Traite une ligne déjà extraite du buffer ; renvoie un frame si la ligne termine un frame. */
  function processLine(rawLine: string): RawSSEFrame | null {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line === "") {
      // Ligne vide = fin de frame. On n'émet que s'il y a au moins une ligne `data:` (frames
      // purement commentaires/vides ignorés, comme le veut la spec SSE).
      if (dataLines.length > 0) {
        const frame: RawSSEFrame = { event, data: dataLines.join("\n"), id };
        resetFrame();
        return frame;
      }
      resetFrame();
      return null;
    }
    if (line.startsWith(":")) return null; // commentaire SSE (keep-alive), ignoré
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
    // "retry" ignoré ici — la reconnexion est gérée par events.ts avec son propre backoff.
    return null;
  }

  async function* consumeLines(text: string): AsyncGenerator<RawSSEFrame> {
    buffer += text;
    let newlineIndex: number;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const frame = processLine(line);
      if (frame) yield frame;
    }
  }

  resetFrame();
  for await (const chunk of chunks) {
    yield* consumeLines(chunk);
  }
  // Flux terminé sans ligne vide finale : on traite le reliquat du buffer comme une dernière ligne,
  // puis on rend quand même le dernier frame s'il a des données (tolérance utile pour les flux qui
  // ne se terminent pas proprement par une ligne vide).
  if (buffer.length > 0) {
    const frame = processLine(buffer);
    buffer = "";
    if (frame) {
      yield frame;
      return;
    }
  }
  if (dataLines.length > 0) {
    yield { event, data: dataLines.join("\n"), id };
  }
}

/** Convertit un flux d'octets (ReadableStream<Uint8Array> via `fetch`, Node ou navigateur) en flux
 * de texte UTF-8, pour alimenter `parseSSEFrames`. Ne dépend d'aucune API DOM : `TextDecoder` est
 * disponible nativement sous Node ≥ 11, dans tout navigateur moderne et sous React Native ≥ 0.70 /
 * Hermes récent (sinon via un polyfill côté app, hors scope du SDK). */
export async function* decodeUtf8Stream(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of bytes) {
    yield decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Parse un frame `data:` dont la charge est du JSON (le cas de tous les événements du contrat). */
export function parseJsonData<T>(frame: RawSSEFrame): T | null {
  if (frame.data === "[DONE]") return null;
  try {
    return JSON.parse(frame.data) as T;
  } catch {
    // CLIENT-API.md ne documente pas de frame malformé pour /v1/events, mais server.py (route
    // /v1/chat/completions) tolère déjà ce cas côté proxy Hermes — même doctrine ici : on ignore
    // plutôt que de faire tomber la connexion sur un frame isolé.
    return null;
  }
}
