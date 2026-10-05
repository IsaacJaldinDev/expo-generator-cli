import { CLAIM_MARKER } from '../schemas/deck.ts';

/** Quita los marcadores [^claim-id] (no se pronuncian). */
export const stripMarkers = (text: string): string => text.replace(CLAIM_MARKER, '');

export const countWords = (text: string): number => stripMarkers(text).trim().split(/\s+/).filter(Boolean).length;

export const claimMarkers = (text: string): string[] => [...text.matchAll(CLAIM_MARKER)].map((m) => m[1]!);

/** Divide en oraciones conservando los marcadores pegados a su oración. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…](?:\[\^[^\]\s]+\])*)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Heurística determinista para "esto parece un dato externo": porcentajes, años o cifras ≥ 100.
 * Números chicos ("5 minutos", "3 ideas") no cuentan.
 */
export function looksLikeExternalFact(sentence: string): boolean {
  const s = stripMarkers(sentence);
  if (/\d+(?:[.,]\d+)?\s?%|por ciento/i.test(s)) return true;
  if (/\b(19|20)\d{2}\b/.test(s)) return true;
  return [...s.matchAll(/\b\d[\d.,]*\b/g)].some((m) => Number(m[0].replace(/[.,]/g, '')) >= 100);
}
