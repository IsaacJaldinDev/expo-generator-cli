import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { verifyAgainstPassage } from '../research/verify.ts';
import type { NoteReview } from '../schemas/notes-review.ts';
import type { ToolDeps } from './deps.ts';

/**
 * Contrasta UN fragmento de los apuntes con la fuente de verdad. El modelo elige el pasaje y dice qué relación ve;
 * el veredicto lo arma el código:
 * - "supports": se verifica igual que un claim (cita, cifras, grounding). Pasa → confirmado; no pasa → sin-verificar
 *   (que la fuente no alcance a respaldarlo no prueba que el apunte esté mal: en las pruebas reales, apuntes
 *   correctos quedaban con grounding 0.68–0.71, apenas bajo el umbral). No se reporta.
 * - "contradicts": inconsistente, con la explicación del modelo y el pasaje para que el autor compare.
 *   Detectar una contradicción es juicio, no aritmética: por eso decidedBy = modelo y el autor tiene la última palabra.
 * - sin pasaje: sin-verificar (tampoco se reporta).
 */
export function reviewNoteTool(deps: ToolDeps) {
  return tool({
    name: 'review_note',
    description:
      'Registra la revisión de UN fragmento de los apuntes (p. ej. "notes#3") contra las fuentes. Antes usa research ' +
      'para buscar el punto. Indica el pasaje que trata ese mismo punto y si lo respalda o lo contradice; si ninguna ' +
      'fuente lo trata, omite passageId. El código calcula el veredicto (confirmado, inconsistente o sin-verificar, que no se reporta). ' +
      'Un apunte confirmado queda registrado como claim citable.',
    inputSchema: z.object({
      fragmentId: z.string().regex(/^[a-z0-9-]+#\d+$/).describe('id del fragmento de read_knowledge, p. ej. "notes#3"'),
      passageId: z.string().regex(/^p\d+$/).optional().describe('id del pasaje de research que trata ese punto; omítelo si no hay ninguno'),
      relation: z
        .enum(['supports', 'contradicts'])
        .optional()
        .describe(
          'Obligatorio si das passageId. supports: el pasaje dice lo mismo. contradicts: SOLO si el pasaje afirma algo incompatible ' +
            '(otro valor, otra fecha, otra definición). Si la fuente no menciona el punto, omite passageId.',
        ),
      explanation: z.string().min(1).describe('En una oración, en español: qué dice la fuente sobre ese punto (o que no lo trata)'),
    }),
    callback: async ({ fragmentId, passageId, relation, explanation }) => {
      const fragment = deps.notes.fragment(fragmentId);
      if (!fragment) return { ok: false, error: `No existe el fragmento "${fragmentId}": usa un id devuelto por read_knowledge.` };
      const base = { fragmentId, text: fragment.text };
      let review: NoteReview;

      if (!passageId) {
        review = { ...base, verdict: 'sin-verificar', decidedBy: 'modelo', reasons: [explanation] };
      } else {
        const { library } = deps.research;
        const passage = library.passage(passageId);
        if (!passage) return { ok: false, error: `No existe el pasaje "${passageId}": usa un id devuelto por research.` };
        if (!relation) return { ok: false, error: 'Con passageId indica relation: "supports" o "contradicts".' };
        const source = { sourceUrl: passage.url, sourceTier: passage.tier, passage: passage.text };

        if (relation === 'contradicts') {
          const check = await verifyAgainstPassage(fragment.text, passage, { library, checker: undefined, sink: deps.sink });
          const numbers = check.checks.numbersMatch ? [] : check.reasons.filter((r) => r.startsWith('El pasaje no contiene'));
          review = { ...base, ...source, verdict: 'inconsistente', decidedBy: 'modelo', reasons: [explanation, ...numbers] };
        } else {
          const check = await verifyAgainstPassage(fragment.text, passage, { library, checker: deps.checker, sink: deps.sink });
          if (check.verified) {
            const claim = deps.store.addExternalClaim({
              text: fragment.text,
              sourceUrl: passage.url,
              sourceTier: passage.tier,
              quote: passage.text,
              verified: true,
              checks: check.checks,
              knowledgeRef: fragmentId,
            });
            review = {
              ...base,
              ...source,
              verdict: 'confirmado',
              decidedBy: 'codigo',
              reasons: [],
              claimId: claim.id,
              ...(check.checks.groundingScore !== undefined ? { groundingScore: check.checks.groundingScore } : {}),
            };
          } else {
            review = {
              ...base,
              ...source,
              verdict: 'sin-verificar',
              decidedBy: 'codigo',
              reasons: [`La fuente trata el punto pero no alcanza a respaldarlo. ${check.reasons.join(' ')}`.trim()],
              ...(check.checks.groundingScore !== undefined ? { groundingScore: check.checks.groundingScore } : {}),
            };
          }
        }
      }

      deps.notes.record(review);
      deps.notes.save(deps.outputDir, deps.notesContext);
      deps.store.save(deps.outputDir, deps.params);
      const stops = deps.notes.stopOn.includes(review.verdict);
      return {
        ok: review.verdict !== 'inconsistente',
        fragmentId,
        verdict: review.verdict,
        ...(review.reasons.length ? { reasons: review.reasons } : {}),
        ...(review.claimId ? { cite: `Ya es el claim ${review.claimId}: cítalo como [^${review.claimId}] (no lo registres con record_claim).` } : {}),
        ...(stops ? { warning: 'Este apunte detiene el proceso: el autor debe corregirlo. Termina de revisar los demás y no investigues huecos.' } : {}),
        pending: deps.notes.pending().map((f) => f.id),
      };
    },
  });
}
