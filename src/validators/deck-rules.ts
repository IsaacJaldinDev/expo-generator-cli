import type { Claim } from '../schemas/claims.ts';
import type { Deck } from '../schemas/deck.ts';
import { claimMarkers, countWords, looksLikeExternalFact, splitSentences } from './text.ts';
import { checkTiming, type TimingParams } from './timing.ts';

export interface DeckRuleParams extends TimingParams {
  maxWordsPerSlide: number;
  minPurposeWords: number;
}

export interface Issue {
  rule: string;
  /** sección o slide afectada */
  where: string;
  message: string;
}

export interface DeckValidation {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/** Reglas deterministas del deck. Sin LLM. */
export function validateDeck(deck: Deck, claims: Claim[], p: DeckRuleParams): DeckValidation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const claimsById = new Map(claims.map((c) => [c.id, c]));

  if (deck.sections.length === 0) {
    errors.push({ rule: 'deck-vacio', where: 'deck', message: 'El deck no tiene secciones.' });
    return { ok: false, errors, warnings };
  }

  const first = deck.sections[0]!;
  if (!deck.sections.some((s) => s.kind === 'hook')) {
    errors.push({ rule: 'hook', where: 'deck', message: 'Falta una sección de tipo "hook".' });
  } else if (first.kind !== 'hook') {
    errors.push({ rule: 'hook', where: first.id, message: `La primera sección debe ser el hook; hoy es "${first.id}".` });
  }
  if (!deck.sections.some((s) => s.kind === 'close')) {
    warnings.push({ rule: 'cierre', where: 'deck', message: 'No hay sección de cierre (kind "close").' });
  }

  const seen = new Set<string>();
  for (const section of deck.sections) {
    if (seen.has(section.id)) errors.push({ rule: 'ids-unicos', where: section.id, message: 'Id de sección repetido.' });
    seen.add(section.id);
    if (section.slides.length === 0) {
      errors.push({ rule: 'slides', where: section.id, message: 'La sección no tiene slides.' });
    }

    for (const slide of section.slides) {
      const where = slide.id;
      const onSlide = countWords([slide.title, ...slide.bullets].join(' '));
      if (onSlide > p.maxWordsPerSlide) {
        errors.push({
          rule: 'palabras-por-slide',
          where,
          message: `La slide tiene ${onSlide} palabras visibles; el máximo es ${p.maxWordsPerSlide}.`,
        });
      }
      if (countWords(slide.purpose) < p.minPurposeWords) {
        errors.push({ rule: 'proposito', where, message: 'La slide no declara su propósito (una oración).' });
      }
      if (countWords(slide.script) === 0) {
        errors.push({ rule: 'script', where, message: 'La slide no tiene script.' });
      }

      for (const sentence of splitSentences(slide.script)) {
        const ids = claimMarkers(sentence);
        for (const id of ids) {
          const claim = claimsById.get(id);
          if (!claim) {
            errors.push({ rule: 'claim-inexistente', where, message: `El script cita [^${id}], que no existe en claims.json.` });
          } else if (claim.origin === 'external' && !claim.verified) {
            errors.push({
              rule: 'claim-sin-verificar',
              where,
              message: `"${claim.text}" [^${id}] es externo y su fuente no está verificada.`,
            });
          }
        }
        // Un dato con cifras necesita una fuente EXTERNA: que esté en mis apuntes no lo verifica.
        const citesExternal = ids.some((id) => claimsById.get(id)?.origin === 'external');
        if (!citesExternal && looksLikeExternalFact(sentence)) {
          errors.push({
            rule: 'dato-sin-fuente',
            where,
            message: `Parece un dato externo sin fuente: "${sentence}". ${
              ids.length ? 'Citar los apuntes no basta: necesita un claim externo verificado.' : 'Respáldalo con un claim externo verificado'
            } o quítalo.`,
          });
        }
      }
    }
  }

  const timing = checkTiming(deck, p);
  if (!timing.ok) {
    for (const problem of timing.problems.filter((x) => x.startsWith('La charla'))) {
      errors.push({ rule: 'duracion', where: 'deck', message: problem });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
