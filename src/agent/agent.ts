import { Agent, type Model, type SystemPrompt } from '@strands-agents/sdk';
import { z } from 'zod';
import { checkTimingTool } from '../tools/check-timing.ts';
import { critiqueVoiceTool } from '../tools/critique-voice.ts';
import type { ToolDeps } from '../tools/deps.ts';
import { readKnowledgeTool } from '../tools/read-knowledge.ts';
import { recordClaimTool } from '../tools/record-claim.ts';
import { researchTool } from '../tools/research.ts';
import { updateSectionTool } from '../tools/update-section.ts';
import { validateDeckTool } from '../tools/validate-deck.ts';
import { validateDeck } from '../validators/deck-rules.ts';
import { structuredOutputLimit, toolCallLimit, tracePlugin, validationGate } from './hooks.ts';

export const RunSummarySchema = z.object({
  summary: z.string().min(1).describe('Qué hiciste, en 1 o 2 oraciones'),
  sectionsChanged: z.array(z.string()).describe('ids de las secciones creadas, modificadas o eliminadas'),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export interface ExpoAgentDeps extends ToolDeps {
  model: Model;
  systemPrompt: SystemPrompt;
  maxRevisionRounds: number;
  structuredOutputRetries: number;
  maxTurns: number;
  maxToolCalls: number;
}

/** Un solo agente + herramientas deterministas + compuerta de validación. */
export function createExpoAgent(deps: ExpoAgentDeps) {
  const abort = new AbortController();

  const gate = validationGate({
    validate: () => {
      if (deps.stage.current === 'research') return validateResearch(deps);
      const v = validateDeck(deps.store.deck, deps.store.claims, deps.params);
      return { ok: v.ok, problems: v.errors.map((e) => `[${e.rule}] ${e.where}: ${e.message}`) };
    },
    maxRounds: deps.maxRevisionRounds,
    sink: deps.sink,
    abort,
    maxTurns: deps.maxTurns,
  });

  const agent = new Agent({
    model: deps.model,
    systemPrompt: deps.systemPrompt,
    tools: [
      readKnowledgeTool(deps),
      researchTool(deps),
      recordClaimTool(deps),
      updateSectionTool(deps),
      checkTimingTool(deps),
      validateDeckTool(deps),
      critiqueVoiceTool(deps),
    ],
    structuredOutputSchema: RunSummarySchema,
    // update_section escribe deck.json: secuencial para que el orden de la traza sea el real
    toolExecutor: 'sequential',
    printer: false,
    plugins: [
      tracePlugin(deps.sink),
      structuredOutputLimit({ maxRetries: deps.structuredOutputRetries, abort, sink: deps.sink }),
      toolCallLimit({ maxCalls: deps.maxToolCalls, abort, sink: deps.sink }),
      gate,
    ],
  });

  /** Opciones de invoke: cancelación + tope duro de turnos por ronda. */
  const invokeOptions = { cancelSignal: abort.signal, limits: { turns: deps.maxTurns } };
  return { agent, abort, gate, invokeOptions };
}

/** Compuerta del acto 2: hay suficientes claims externos verificados para escribir el deck. */
export function validateResearch(deps: Pick<ToolDeps, 'store' | 'params'>): { ok: boolean; problems: string[] } {
  const verified = deps.store.claims.filter((c) => c.origin === 'external' && c.verified).length;
  return verified >= deps.params.minExternalClaims
    ? { ok: true, problems: [] }
    : {
        ok: false,
        problems: [
          `Hay ${verified} claims externos verificados; se necesitan al menos ${deps.params.minExternalClaims}. Investiga otros huecos (research → record_claim con passageId).`,
        ],
      };
}

/** Instrucción de cada etapa. */
export const STAGE_INSTRUCTIONS = {
  research:
    'ACTO 2 — Huecos y research. Lee los apuntes (read_knowledge), identifica las afirmaciones verificables sin fuente y respáldalas: research → record_claim con el passageId. No escribas el deck todavía. Termina cuando tengas los claims.',
  deck: 'ACTO 3 — Plan y validación. Con los apuntes y los claims verificados de claims.json, escribe la exposición sección por sección (update_section), luego check_timing y validate_deck hasta que pasen.',
} as const;

/** Mensaje de usuario: la instrucción + el estado actual del deck (si existe). */
export function buildUserMessage(instruction: string, deckJson: unknown, claimsJson: unknown, hasDeck: boolean): string {
  if (!hasDeck) return instruction;
  return `${instruction}

Estado actual de la tarea:
<deck.json>
${JSON.stringify(deckJson, null, 2)}
</deck.json>
<claims.json>
${JSON.stringify(claimsJson, null, 2)}
</claims.json>`;
}
