import { Agent, tool, type Model, type SystemPrompt } from '@strands-agents/sdk';
import { z } from 'zod';
import type { GuardrailChecker } from '../guardrails/apply.ts';
import type { TraceSink } from './events.ts';
import { structuredOutputLimit, tracePlugin, validationGate, type GateResult } from './hooks.ts';

/**
 * Agente mínimo de la fase 0: escribe el hook de una charla, cuenta palabras con una herramienta,
 * lo guarda en el estado de la tarea y no puede terminar hasta que el validador determinista pase.
 * Mismo patrón que tendrá el agente real: update_section + check_timing + validate_deck.
 */

export const MAX_HOOK_WORDS = 40;

export const HookOutputSchema = z.object({
  hook: z.string().min(1).describe('El texto final del hook, idéntico al guardado con save_hook'),
  wordCount: z.number().int().positive(),
  rationale: z.string().describe('Una oración: por qué este inicio engancha a estudiantes'),
});
export type HookOutput = z.infer<typeof HookOutputSchema>;

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export const SPIKE_SYSTEM_PROMPT = `Eres un agente que prepara el inicio (hook) de una charla técnica en español para estudiantes universitarios.
Proceso obligatorio:
1. Escribe un borrador del hook.
2. Usa count_words para medirlo; el límite es ${MAX_HOOK_WORDS} palabras.
3. Guarda la versión final con save_hook.
4. Responde con la salida estructurada.
Si recibes feedback de validación, corrige solo lo que se indica.`;

export interface SpikeAgentDeps {
  model: Model;
  /** Por defecto SPIKE_SYSTEM_PROMPT; el script real lo envuelve con cachedSystemPrompt(). */
  systemPrompt?: SystemPrompt;
  sink: TraceSink;
  checker?: GuardrailChecker;
  maxRevisionRounds: number;
  structuredOutputRetries: number;
}

export function validateHook(hook: unknown): GateResult {
  if (typeof hook !== 'string' || hook.trim() === '') {
    return { ok: false, problems: ['No hay hook guardado: llama a save_hook antes de terminar.'] };
  }
  const n = countWords(hook);
  return n <= MAX_HOOK_WORDS
    ? { ok: true, problems: [] }
    : { ok: false, problems: [`El hook tiene ${n} palabras; el máximo es ${MAX_HOOK_WORDS} (sobran ${n - MAX_HOOK_WORDS}).`] };
}

export function createSpikeAgent(deps: SpikeAgentDeps) {
  const abort = new AbortController();

  const countWordsTool = tool({
    name: 'count_words',
    description: 'Cuenta las palabras de un texto (determinista, sin LLM).',
    inputSchema: z.object({ text: z.string() }),
    callback: ({ text }) => ({ words: countWords(text), limit: MAX_HOOK_WORDS }),
  });

  const saveHookTool = tool({
    name: 'save_hook',
    description: 'Guarda el hook final en el estado de la tarea. Pasa por Bedrock Guardrails antes de guardarse.',
    inputSchema: z.object({ text: z.string().min(1) }),
    callback: async ({ text }, context) => {
      let finalText = text;
      if (deps.checker) {
        // Los argumentos de herramientas no los evalúa Converse: se revisan con ApplyGuardrail.
        const r = await deps.checker.check(text, 'output');
        if (r.interventions.length > 0) deps.sink({ kind: 'guardrail', via: 'apply-guardrail', interventions: r.interventions });
        if (r.blocked) return { saved: false, reason: 'Bloqueado por Bedrock Guardrails', message: r.text };
        finalText = r.text;
      }
      context?.agent.appState.set('hook', finalText);
      return { saved: true, words: countWords(finalText), masked: finalText !== text };
    },
  });

  const gate = validationGate({
    validate: (agent) => validateHook(agent.appState.get('hook')),
    maxRounds: deps.maxRevisionRounds,
    sink: deps.sink,
    abort,
  });

  const agent = new Agent({
    model: deps.model,
    systemPrompt: deps.systemPrompt ?? SPIKE_SYSTEM_PROMPT,
    tools: [countWordsTool, saveHookTool],
    structuredOutputSchema: HookOutputSchema,
    printer: false,
    plugins: [
      tracePlugin(deps.sink),
      structuredOutputLimit({ maxRetries: deps.structuredOutputRetries, abort, sink: deps.sink }),
      gate,
    ],
  });

  return { agent, abort, gate };
}
