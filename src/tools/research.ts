import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { ToolDeps } from './deps.ts';

export function researchTool(deps: ToolDeps) {
  let calls = 0;
  return tool({
    name: 'research',
    description:
      'Busca evidencia para UNA afirmación, solo en las fuentes permitidas (config/sources.yml), y devuelve ' +
      'fragmentos textuales con su URL y tier. Las fuentes están en inglés: escribe la consulta con palabras ' +
      'clave en inglés. Úsalo solo para los huecos de los apuntes (3 a 5 afirmaciones).',
    inputSchema: z.object({
      claim: z.string().min(1).describe('La afirmación que quieres respaldar, en español'),
      query: z.string().min(3).describe('Palabras clave en inglés, p. ej. "USB-C port AI applications"'),
    }),
    callback: async ({ query }) => {
      const { library, sources } = deps.research;
      if (++calls > sources.limits.maxResearchCalls) {
        return {
          ok: false,
          error: `Límite de ${sources.limits.maxResearchCalls} búsquedas alcanzado. Trabaja con los claims que ya tienes.`,
        };
      }
      const { passages, failed } = await library.search(query);
      return {
        ok: passages.length > 0,
        query,
        passages,
        ...(passages.length === 0 ? { error: 'Sin evidencia en las fuentes permitidas: no uses esta afirmación.' } : {}),
        ...(failed.length ? { unreachable: failed } : {}),
        hint: 'Para registrar un claim usa record_claim con el id del pasaje que la respalda (p. ej. "p1").',
      };
    },
  });
}
