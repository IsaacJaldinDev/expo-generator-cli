import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { ToolDeps } from './deps.ts';

/** Marca en una sola llamada los fragmentos que son del autor (ideas, experiencias, opiniones): no requieren fuente. */
export function markOwnNotesTool(deps: ToolDeps) {
  return tool({
    name: 'mark_own_notes',
    description:
      'Marca fragmentos de los apuntes que NO afirman hechos verificables: ideas para la charla, experiencias ' +
      'personales u opiniones. No requieren fuente. Pasa todos en una sola llamada. Los que afirman algo del mundo ' +
      '(definiciones, cómo funciona algo, fechas, cifras) se revisan con review_note. El código rechaza los que tienen cifras.',
    inputSchema: z.object({
      fragmentIds: z.array(z.string().regex(/^[a-z0-9-]+#\d+$/)).min(1).describe('ids de read_knowledge, p. ej. ["ideas#1", "experiences#2"]'),
    }),
    callback: async ({ fragmentIds }) => {
      const { accepted, refused } = deps.notes.markOwn(fragmentIds);
      deps.notes.save(deps.outputDir, deps.notesContext);
      return {
        ok: refused.length === 0,
        marked: accepted,
        ...(refused.length ? { refused } : {}),
        pending: deps.notes.pending().map((f) => f.id),
      };
    },
  });
}
