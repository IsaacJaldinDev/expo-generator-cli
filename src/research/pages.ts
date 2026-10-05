/**
 * Descarga y texto de las fuentes. Todo determinista: ni el ranking ni la verificación usan LLM.
 */

/** Devuelve el HTML/texto crudo de una URL. Inyectable: los tests y el replay (fase 7) no usan red. */
export type PageFetcher = (url: string) => Promise<string>;

export function httpFetcher(timeoutMs: number): PageFetcher {
  return async (url) => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (expo-generator; research)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
    return res.text();
  };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML → texto plano legible (sin scripts, estilos ni etiquetas). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>|<br\s*\/?>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s*\.\s*(\.\s*)+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalización para comparar citas: minúsculas, comillas/guiones uniformes, espacios colapsados. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚′`´]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿El fragmento citado aparece literalmente (normalizado) en el contenido descargado? */
export function quoteAppearsIn(quote: string, pageText: string): boolean {
  const q = normalizeForMatch(quote).replace(/[.\s]+$/, '');
  return q.length > 0 && normalizeForMatch(pageText).includes(q);
}

/** Cifras de un texto, normalizadas: "10.000" y "10,000" → "10000"; "90%" → "90". */
export function numbersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?/g)].map((m) => m[0].replace(/[.,\s](?=\d{3}\b)/g, '').replace(',', '.')))];
}

/** Toda cifra de la afirmación debe aparecer en la cita: una cita real que no habla de ese número no la respalda. */
export function missingNumbers(claim: string, quote: string): string[] {
  const inQuote = new Set(numbersIn(quote));
  return numbersIn(claim).filter((n) => !inQuote.has(n));
}

const STOPWORDS = new Set(
  'the and for are with that this from have has was were will can its into your you our not but all any how what when where which who why mcp de la el los las que por para con una uno del como más sus'.split(' '),
);

const terms = (text: string): string[] =>
  normalizeForMatch(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

export interface Passage {
  url: string;
  text: string;
  score: number;
}

/**
 * Ventanas de 2 oraciones CONTIGUAS puntuadas por cuántos términos distintos de la consulta contienen.
 * Las ventanas se arman antes de filtrar por longitud: así cada pasaje existe literalmente en la página
 * (y fechas cortas como "Nov 25, 2024." no se pierden).
 */
export function rankPassages(url: string, pageText: string, query: string, maxChars = 400): Passage[] {
  const wanted = new Set(terms(query));
  if (wanted.size === 0) return [];
  const sentences = pageText.split(/(?<=[.!?])\s+/);
  const out: Passage[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const text = [sentences[i], sentences[i + 1]].filter(Boolean).join(' ').slice(0, maxChars);
    if (text.length <= 20) continue;
    const found = new Set(terms(text).filter((t) => wanted.has(t)));
    if (found.size > 0) out.push({ url, text, score: found.size / wanted.size });
  }
  return out;
}
