import { readFileSync } from 'node:fs';
import type { Deck } from '../schemas/deck.ts';
import { countWords, splitSentences, stripMarkers } from './text.ts';

export interface VoiceRules {
  /** Muletillas cargadas desde voice/anti-patterns.md (sección "## Muletillas"). */
  fillers: string[];
  maxSentenceWords: number;
  maxTriadsPerSection: number;
  maxNotXButY: number;
  maxRhetoricalQA: number;
}

export interface VoiceIssue {
  rule: 'muletilla' | 'oracion-larga' | 'triadas' | 'no-es-x-es-y' | 'pregunta-respuesta';
  severity: 'error' | 'warning';
  /** slide afectada */
  where: string;
  /** la oración problemática, textual */
  quote: string;
  message: string;
}

/** Lee los ítems de la sección "## Muletillas" de anti-patterns.md. */
export function parseFillers(markdown: string): string[] {
  const section = markdown.split(/^##\s+/m).find((s) => /^muletillas/i.test(s));
  if (!section) return [];
  return section
    .split('\n')
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}

export function loadFillers(path = 'voice/anti-patterns.md'): string[] {
  return parseFillers(readFileSync(path, 'utf8'));
}

/** minúsculas y sin tildes, para comparar muletillas sin importar acentos */
const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "A, B y C" con ítems de 1 a 3 palabras. */
const TRIAD = /(?:^|[\s(¿¡"])[\p{L}\d-]+(?:\s[\p{L}\d-]+){0,2},\s[\p{L}\d-]+(?:\s[\p{L}\d-]+){0,2},?\s(?:y|e|o|u)\s[\p{L}\d-]+/iu;
/** "No es X, es Y" / "No es X, sino Y" / "No es X. Es Y." */
const NOT_X_BUT_Y = /\bno es\b[^.!?]{1,80}?(?:[,;:]\s*(?:es|sino)\b|[.!?]\s+es\b)/i;

/** Voice lint determinista sobre el script hablado. */
export function lintVoice(deck: Deck, rules: VoiceRules): VoiceIssue[] {
  const issues: VoiceIssue[] = [];
  const fillers = rules.fillers.map((f) => ({ f, re: new RegExp(`\\b${escape(fold(f))}\\b`) }));
  const notXButY: VoiceIssue[] = [];
  const rhetorical: VoiceIssue[] = [];

  for (const section of deck.sections) {
    const triads: VoiceIssue[] = [];
    for (const slide of section.slides) {
      const sentences = splitSentences(slide.script);
      sentences.forEach((raw, i) => {
        const sentence = stripMarkers(raw);
        const where = slide.id;

        for (const { f, re } of fillers) {
          if (re.test(fold(sentence))) {
            issues.push({ rule: 'muletilla', severity: 'error', where, quote: sentence, message: `Muletilla "${f}".` });
          }
        }
        const words = countWords(sentence);
        if (words > rules.maxSentenceWords) {
          issues.push({
            rule: 'oracion-larga',
            severity: 'warning',
            where,
            quote: sentence,
            message: `Oración de ${words} palabras (máx. ${rules.maxSentenceWords}): pártela.`,
          });
        }
        if (TRIAD.test(sentence)) {
          triads.push({ rule: 'triadas', severity: 'warning', where, quote: sentence, message: 'Tríada en serie.' });
        }
        if (NOT_X_BUT_Y.test(`${sentence} ${stripMarkers(sentences[i + 1] ?? '')}`)) {
          notXButY.push({ rule: 'no-es-x-es-y', severity: 'error', where, quote: sentence, message: 'Estructura "No es X, es Y".' });
        }
        const next = sentences[i + 1] ? stripMarkers(sentences[i + 1]!) : '';
        if (sentence.endsWith('?') && words <= 4 && next && !next.endsWith('?') && countWords(next) <= 6) {
          rhetorical.push({
            rule: 'pregunta-respuesta',
            severity: 'warning',
            where,
            quote: `${sentence} ${next}`,
            message: 'Pregunta retórica respondida de inmediato.',
          });
        }
      });
    }
    if (triads.length > rules.maxTriadsPerSection) {
      for (const t of triads.slice(rules.maxTriadsPerSection)) {
        issues.push({ ...t, message: `Tríada en serie: la sección "${section.id}" ya tiene ${triads.length} (máx. ${rules.maxTriadsPerSection}).` });
      }
    }
  }
  for (const n of notXButY.slice(rules.maxNotXButY)) {
    issues.push({ ...n, message: `"No es X, es Y" usado ${notXButY.length} veces (máx. ${rules.maxNotXButY}): suena a eslogan.` });
  }
  for (const r of rhetorical.slice(rules.maxRhetoricalQA)) {
    issues.push({ ...r, message: `Pregunta retórica + respuesta inmediata ${rhetorical.length} veces (máx. ${rules.maxRhetoricalQA}).` });
  }
  return issues;
}
