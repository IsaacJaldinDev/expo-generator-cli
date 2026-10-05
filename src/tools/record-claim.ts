import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { verifyAgainstPassage } from '../research/verify.ts';
import { stripMarkers } from '../validators/text.ts';
import type { ToolDeps } from './deps.ts';

export function recordClaimTool(deps: ToolDeps) {
  return tool({
    name: 'record_claim',
    description:
      'Registra en claims.json una afirmación externa respaldada por UN pasaje devuelto por research (por su id, ' +
      'p. ej. "p3"). No puedes escribir la cita: el código usa el texto exacto del pasaje, vuelve a comprobar que ' +
      'está en la página y calcula `verified`: true solo si además el pasaje contiene todas las cifras de la ' +
      'afirmación (escríbelas con dígitos). Devuelve el id del claim para citarlo en el script como [^id]. ' +
      'Las ideas de los apuntes no se registran aquí: se citan con su fragmento ([^notes#3]). Lo que review_note ' +
      'ya confirmó tampoco: ya es un claim citable.',
    inputSchema: z.object({
      text: z.string().min(1).describe('La afirmación tal como la usarás en la charla, en español'),
      passageId: z.string().regex(/^p\d+$/).describe('id del pasaje de research que la respalda, p. ej. "p3"'),
    }),
    callback: async ({ text: raw, passageId }) => {
      // Un marcador [^c-1] en la afirmación no es una cifra: se quita antes de verificar y de guardar.
      const text = stripMarkers(raw).replace(/\s+([.,;:])/g, '$1').trim();
      const { library, sources } = deps.research;
      const passage = library.passage(passageId);
      if (!passage) return { ok: false, error: `No existe el pasaje "${passageId}": usa un id devuelto por research.` };

      // El tope cuenta solo los verificados: un claim rechazado no debe consumir cupo (el de búsquedas ya acota los intentos).
      // Los que salen de apuntes confirmados (knowledgeRef) no cuentan: no son huecos.
      const verifiedCount = deps.store.claims.filter((c) => c.origin === 'external' && c.verified && !c.knowledgeRef).length;
      if (verifiedCount >= sources.limits.maxExternalClaims) {
        return { ok: false, error: `Ya hay ${verifiedCount} claims externos verificados (máximo ${sources.limits.maxExternalClaims}).` };
      }

      const quote = passage.text;
      const { verified, checks, reasons } = await verifyAgainstPassage(text, passage, { library, checker: deps.checker, sink: deps.sink });

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
