import { tool } from '@strands-agents/sdk';
import { SectionPatchSchema, type SectionPatch } from '../schemas/deck.ts';
import { countWords } from '../validators/text.ts';
import { checkTiming, sectionTiming } from '../validators/timing.ts';
import type { ToolDeps } from './deps.ts';

const SEP = '\n\n§§§\n\n';

/** Pasa los scripts del parche por ApplyGuardrail (OUTPUT): Converse no evalúa argumentos de herramientas. */
async function guardPatch(patch: SectionPatch, deps: ToolDeps): Promise<{ patch: SectionPatch; blocked?: string }> {
  if (!deps.checker || !patch.slides) return { patch };
  const joined = patch.slides.map((s) => s.script).join(SEP);
  const r = await deps.checker.check(joined, 'output');
  if (r.interventions.length) deps.sink({ kind: 'guardrail', via: 'apply-guardrail', interventions: r.interventions });
  if (r.blocked) return { patch, blocked: r.interventions.map((i) => `${i.policy}: ${i.detail}`).join(', ') };
  const scripts = r.text.split(SEP);
  if (scripts.length !== patch.slides.length) return { patch };
  return { patch: { ...patch, slides: patch.slides.map((s, i) => ({ ...s, script: scripts[i]! })) } };
}

export function updateSectionTool(deps: ToolDeps) {
  return tool({
    name: 'update_section',
    description:
      'Crea, modifica o elimina UNA sección del deck. Solo cambian los campos que envíes; si envías slides, ' +
      'reemplazan todas las slides de esa sección. Nunca reescribas secciones que no necesitas cambiar.',
    inputSchema: SectionPatchSchema,
    callback: async (input) => {
      const guarded = await guardPatch(input, deps);
      if (guarded.blocked) {
        return { ok: false, error: `Bedrock Guardrails bloqueó el contenido (${guarded.blocked}). Reescríbelo sin ese contenido.` };
      }
      const before = deps.store.section(input.sectionId);
      let change;
      try {
        change = deps.store.applyPatch(guarded.patch);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      const targetsScaled = deps.store.normalizeTargets(deps.params.budgetSeconds);
      deps.store.save(deps.outputDir, deps.params);

      const total = checkTiming(deps.store.deck, deps.params);
      const words = (s?: typeof before) => s?.slides.reduce((n, sl) => n + countWords(sl.script), 0) ?? 0;
      return {
        ok: true,
        action: change.action,
        sectionId: input.sectionId,
        scriptWords: { before: words(before), after: words(change.after) },
        ...(change.after ? { sectionTiming: sectionTiming(change.after, deps.params.wordsPerMinute) } : {}),
        deckSeconds: { total: total.totalSeconds, budget: total.budgetSeconds },
        sectionOrder: deps.store.deck.sections.map((s) => s.id),
        ...(targetsScaled
          ? { note: 'Los targetSeconds sumaban más que la charla: el código los escaló proporcionalmente.' }
          : {}),
      };
    },
  });
}
