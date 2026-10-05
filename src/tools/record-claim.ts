import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { missingNumbers, quoteAppearsIn } from '../research/pages.ts';
import type { ToolDeps } from './deps.ts';

export function recordClaimTool(deps: ToolDeps) {
  return tool({
    name: 'record_claim',
    description:
      'Registra en claims.json una afirmación externa respaldada por UN pasaje devuelto por research (por su id, ' +
      'p. ej. "p3"). No puedes escribir la cita: el código usa el texto exacto del pasaje, vuelve a comprobar que ' +
      'está en la página y calcula `verified`: true solo si además el pasaje contiene todas las cifras de la ' +
      'afirmación (escríbelas con dígitos). Devuelve el id del claim para citarlo en el script como [^id]. ' +
      'Las ideas de los apuntes no se registran aquí: se citan con su fragmento ([^notes#3]).',
    inputSchema: z.object({
      text: z.string().min(1).describe('La afirmación tal como la usarás en la charla, en español'),
      passageId: z.string().regex(/^p\d+$/).describe('id del pasaje de research que la respalda, p. ej. "p3"'),
    }),
    callback: async ({ text, passageId }) => {
      const { library, sources } = deps.research;
      const passage = library.passage(passageId);
      if (!passage) return { ok: false, error: `No existe el pasaje "${passageId}": usa un id devuelto por research.` };

      // El tope cuenta solo los verificados: un claim rechazado no debe consumir cupo (el de búsquedas ya acota los intentos).
      const verifiedCount = deps.store.claims.filter((c) => c.origin === 'external' && c.verified).length;
      if (verifiedCount >= sources.limits.maxExternalClaims) {
        return { ok: false, error: `Ya hay ${verifiedCount} claims externos verificados (máximo ${sources.limits.maxExternalClaims}).` };
      }

      const quote = passage.text;
      let quoteFound = false;
      const reasons: string[] = [];
      try {
        // Se re-verifica contra la página: el pasaje no se da por bueno solo porque lo produjo el código.
        quoteFound = quoteAppearsIn(quote, await library.text(passage.url));
        if (!quoteFound) reasons.push('El pasaje ya no aparece en la fuente.');
      } catch (err) {
        reasons.push(`No se pudo descargar la fuente: ${(err as Error).message}`);
      }
      const missing = missingNumbers(text, quote);
      if (missing.length) reasons.push(`El pasaje no contiene las cifras ${missing.join(', ')} de la afirmación: no la respalda.`);
      const checks: { quoteFound: boolean; numbersMatch: boolean; grounded?: boolean; groundingScore?: number } = {
        quoteFound,
        numbersMatch: missing.length === 0,
      };
      // Contextual grounding (Bedrock Guardrails): ¿el pasaje respalda semánticamente la afirmación?
      if (deps.checker && quoteFound && checks.numbersMatch) {
        const g = await deps.checker.ground({ source: quote, query: text, content: text });
        checks.grounded = g.grounded;
        if (g.groundingScore !== undefined) checks.groundingScore = g.groundingScore;
        if (!g.grounded) {
          deps.sink({ kind: 'guardrail', via: 'apply-guardrail', interventions: g.interventions });
          reasons.push(`Bedrock Guardrails: el pasaje no respalda la afirmación (grounding ${g.groundingScore?.toFixed(2) ?? '?'}).`);
        }
      }
      const verified = checks.quoteFound && checks.numbersMatch && checks.grounded !== false;

      const claim = deps.store.addExternalClaim({ text, sourceUrl: passage.url, sourceTier: passage.tier, quote, verified, checks });
      deps.store.save(deps.outputDir, deps.params);
      return {
        ok: verified,
        id: claim.id,
        verified,
        sourceTier: passage.tier,
        reason: verified
          ? `El pasaje está en la fuente y respalda la afirmación${checks.groundingScore !== undefined ? ` (grounding ${checks.groundingScore.toFixed(2)})` : ''}.`
          : reasons.join(' '),
        ...(verified
          ? { cite: `Cítalo en el script al final de la oración: [^${claim.id}]` }
          : { warning: 'Un claim sin verificar NO se puede citar: validate_deck lo rechazará. No uses esa afirmación.' }),
      };
    },
  });
}
