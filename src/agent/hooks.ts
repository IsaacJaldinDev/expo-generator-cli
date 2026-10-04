import {
  AfterInvocationEvent,
  AfterModelCallEvent,
  AfterToolCallEvent,
  BeforeInvocationEvent,
  BeforeToolCallEvent,
  ModelStreamUpdateEvent,
  type LocalAgent,
  type Plugin,
} from '@strands-agents/sdk';
import { converseTraceToInterventions } from '../guardrails/trace.ts';
import type { TraceSink, UsageTotals } from './events.ts';

/** Nombre interno de la herramienta de structured output del SDK (verificado en 1.19.0). */
export const STRUCTURED_OUTPUT_TOOL = 'strands_structured_output';

/** Emite a la vista de trazas cada llamada a herramienta, cada llamada al modelo y las intervenciones de guardrail. */
export function tracePlugin(sink: TraceSink): Plugin {
  return {
    name: 'expo-trace',
    initAgent(agent: LocalAgent) {
      const started = new Map<string, number>();
      let pendingUsage: UsageTotals | undefined;

      agent.addHook(BeforeToolCallEvent, (e) => {
        if (e.toolUse.name === STRUCTURED_OUTPUT_TOOL) return;
        started.set(e.toolUse.toolUseId, performance.now());
        sink({ kind: 'tool-start', id: e.toolUse.toolUseId, name: e.toolUse.name, input: e.toolUse.input });
      });

      agent.addHook(AfterToolCallEvent, (e) => {
        if (e.toolUse.name === STRUCTURED_OUTPUT_TOOL) return;
        const t0 = started.get(e.toolUse.toolUseId) ?? performance.now();
        started.delete(e.toolUse.toolUseId);
        const ok = e.result.status !== 'error';
        sink({
          kind: 'tool-end',
          id: e.toolUse.toolUseId,
          name: e.toolUse.name,
          ok,
          ms: Math.round(performance.now() - t0),
          ...(ok ? {} : { note: e.error?.message ?? 'error' }),
        });
      });

      agent.addHook(ModelStreamUpdateEvent, (e) => {
        if (e.event.type !== 'modelMetadataEvent') return;
        if (e.event.usage) {
          pendingUsage = {
            inputTokens: e.event.usage.inputTokens,
            outputTokens: e.event.usage.outputTokens,
            cacheReadInputTokens: e.event.usage.cacheReadInputTokens ?? 0,
            cacheWriteInputTokens: e.event.usage.cacheWriteInputTokens ?? 0,
          };
        }
        const interventions = converseTraceToInterventions(e.event.trace);
        if (interventions.length > 0) sink({ kind: 'guardrail', via: 'converse', interventions });
      });

      agent.addHook(AfterModelCallEvent, (e) => {
        if (!e.stopData) return;
        sink({ kind: 'model-call', stopReason: e.stopData.stopReason, ...(pendingUsage ? { usage: pendingUsage } : {}) });
        pendingUsage = undefined;
      });
    },
  };
}

/**
 * El SDK reintenta el structured output sin límite (devuelve el error de Zod al modelo).
 * Este plugin permite `maxRetries` reintentos y luego aborta la invocación.
 */
export function structuredOutputLimit(opts: { maxRetries: number; abort: AbortController; sink: TraceSink }): Plugin {
  return {
    name: 'expo-structured-output-limit',
    initAgent(agent: LocalAgent) {
      let failures = 0;
      agent.addHook(AfterToolCallEvent, (e) => {
        if (e.toolUse.name !== STRUCTURED_OUTPUT_TOOL) return;
        const ok = e.result.status !== 'error';
        const attempt = failures + 1;
        if (ok) {
          opts.sink({ kind: 'structured-output', ok, attempt });
          return;
        }
        failures++;
        const error = e.error?.message ?? 'schema inválido';
        opts.sink({ kind: 'structured-output', ok, attempt, error });
        if (failures > opts.maxRetries) {
          opts.abort.abort(new StructuredOutputRetriesExceeded(failures, error));
        }
      });
    },
  };
}

export class StructuredOutputRetriesExceeded extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: string,
  ) {
    super(`La salida estructurada no cumplió el schema tras ${attempts} intentos: ${lastError}`);
    this.name = 'StructuredOutputRetriesExceeded';
  }
}

export interface GateResult {
  ok: boolean;
  problems: string[];
}

/**
 * Impide que el agente termine sin pasar la validación determinista. Si falla, reanuda la
 * invocación con el reporte del validador como feedback, hasta `maxRounds` rondas de revisión.
 * Después reporta y se detiene: nunca queda en loop.
 */
export function validationGate(opts: {
  validate: (agent: LocalAgent) => GateResult | Promise<GateResult>;
  maxRounds: number;
  sink: TraceSink;
  abort?: AbortController;
}): Plugin & { readonly lastResult: GateResult | undefined; readonly rounds: number } {
  let rounds = 0;
  let lastResult: GateResult | undefined;
  return {
    name: 'expo-validation-gate',
    get lastResult() {
      return lastResult;
    },
    get rounds() {
      return rounds;
    },
    initAgent(agent: LocalAgent) {
      // AfterInvocationEvent también se dispara cuando la invocación falla y no trae el error:
      // lo detectamos aquí para no validar (ni reanudar) un intento que nunca terminó.
      let modelFailed = false;
      agent.addHook(BeforeInvocationEvent, () => {
        modelFailed = false;
      });
      agent.addHook(AfterModelCallEvent, (e) => {
        if (e.error && !e.retry) modelFailed = true;
      });
      agent.addHook(AfterInvocationEvent, async (e) => {
        if (opts.abort?.signal.aborted || modelFailed) return;
        lastResult = await opts.validate(agent);
        opts.sink({ kind: 'validation', round: rounds, ok: lastResult.ok, problems: lastResult.problems });
        if (lastResult.ok || rounds >= opts.maxRounds) return;
        rounds++;
        e.resume =
          `La validación falló (ronda de revisión ${rounds}/${opts.maxRounds}). Corrige SOLO esto y vuelve a validar:\n` +
          lastResult.problems.map((p) => `- ${p}`).join('\n');
      });
    },
  };
}
