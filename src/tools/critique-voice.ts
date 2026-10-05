import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { normalizeForMatch } from '../research/pages.ts';
import { stripMarkers } from '../validators/text.ts';
import type { ToolDeps } from './deps.ts';

export function critiqueVoiceTool(deps: ToolDeps) {
  let calls = 0;
  return tool({
    name: 'critique_voice',
    description:
      'Pide a un crítico SEPARADO (otra llamada al modelo, sin tu historial) que revise si el script suena al ' +
      'autor según sus ejemplos de voz. Devuelve oraciones textuales con el problema y una sugerencia. ' +
      'Úsalo una vez cuando validate_deck pase; corrige solo las oraciones citadas.',
    inputSchema: z.object({
      sectionIds: z.array(z.string()).optional().describe('Secciones a revisar; por defecto, todas (o el alcance de la edición)'),
    }),
    callback: async ({ sectionIds }) => {
      if (!deps.critic) return { ok: true, skipped: 'Crítica de voz deshabilitada.' };
      if (++calls > deps.critic.maxCalls) {
        return { ok: true, skipped: `Ya se usó la crítica ${deps.critic.maxCalls} veces en esta ejecución.` };
      }
      const wanted = new Set(sectionIds?.length ? sectionIds : deps.store.editScope?.size ? [...deps.store.editScope] : []);
      const sections = deps.store.deck.sections
        .filter((s) => wanted.size === 0 || wanted.has(s.id))
        .map((s) => ({ id: s.id, slides: s.slides.map((sl) => ({ id: sl.id, script: stripMarkers(sl.script) })) }));
      if (sections.length === 0) return { ok: false, error: 'No hay secciones que revisar.' };

      const { critique, usage } = await deps.critic.provider.critique({ sections });
      if (usage) deps.sink({ kind: 'model-call', stopReason: 'critique_voice', usage });

      // La crítica debe citar oraciones reales: lo verifica el código, no el crítico.
      const scripts = new Map(sections.flatMap((s) => s.slides.map((sl) => [sl.id, normalizeForMatch(sl.script)] as const)));
      const all = [...scripts.values()].join(' ');
      const quoted = critique.issues.filter((i) => {
        const q = normalizeForMatch(i.sentence).replace(/[.\s]+$/, '');
        return q.length > 0 && (scripts.get(i.slideId)?.includes(q) || all.includes(q));
      });
      const dropped = critique.issues.length - quoted.length;
      return {
        ok: quoted.length === 0,
        critic: deps.critic.provider.name,
        issues: quoted,
        ...(dropped ? { droppedUnquoted: dropped, note: `${dropped} observación(es) descartada(s): no citaban una oración real del script.` } : {}),
        next: quoted.length
          ? 'Corrige SOLO esas oraciones con update_section en su sección y vuelve a validate_deck.'
          : 'La voz está bien: termina.',
      };
    },
  });
}
