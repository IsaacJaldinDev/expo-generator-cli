import {
  AfterInvocationEvent,
  AfterModelCallEvent,
  AfterToolCallEvent,
  BeforeInvocationEvent,
  BeforeToolCallEvent,
  ModelStreamUpdateEvent,
  type LocalAgent,
  type Plugin,
  type ToolResultBlock,
} from '@strands-agents/sdk';
import { converseTraceToInterventions } from '../guardrails/trace.ts';
import type { TraceSink, UsageTotals } from './events.ts';

/** Nombre interno de la herramienta de structured output del SDK (verificado en 1.19.0). */
export const STRUCTURED_OUTPUT_TOOL = 'strands_structured_output';

/**
 * Veredicto de una herramienta para la vista de trazas. Además del error técnico, las herramientas
 * deterministas devuelven `{ ok: false, ... }` cuando su revisión falla (p. ej. check_timing con exceso):
 * eso también se muestra como ✗, que es lo que el público tiene que ver.
 */
export function toolVerdict(result: ToolResultBlock, error?: Error): { ok: boolean; note?: string } {
  if (result.status === 'error') return { ok: false, note: error?.message ?? 'error' };
  const json = result.content.find((c) => c.type === 'jsonBlock')?.json as
    | { ok?: unknown; error?: unknown; problems?: unknown; errors?: unknown }
    | undefined;
  if (json?.ok !== false) return { ok: true };
  const first =
    (typeof json.error === 'string' && json.error) ||
    (Array.isArray(json.problems) && typeof json.problems[0] === 'string' && json.problems[0]) ||
    (Array.isArray(json.errors) && (json.errors[0] as { message?: string } | undefined)?.message) ||
    '';
  return { ok: false, ...(first ? { note: first } : {}) };
}

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
        const verdict = toolVerdict(e.result, e.error);
        sink({
          kind: 'tool-end',
          id: e.toolUse.toolUseId,
          name: e.toolUse.name,
          ok: verdict.ok,
          ms: Math.round(performance.now() - t0),
          ...(verdict.note ? { note: verdict.note } : {}),
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

/**
 * Tope de llamadas a herramientas por ejecución. Algunos modelos piden muchas herramientas en un solo
 * turno, así que limits.turns no basta. Al superarlo se cancela la llamada y se aborta la invocación.
 */
export function toolCallLimit(opts: { maxCalls: number; abort: AbortController; sink: TraceSink }): Plugin {
  return {
    name: 'expo-tool-call-limit',
    initAgent(agent: LocalAgent) {
      let calls = 0;
      agent.addHook(BeforeToolCallEvent, (e) => {
        if (e.toolUse.name === STRUCTURED_OUTPUT_TOOL) return;
        if (++calls <= opts.maxCalls) return;
        e.cancel = `Tope de ${opts.maxCalls} llamadas a herramientas alcanzado.`;
        if (!opts.abort.signal.aborted) {
          opts.sink({ kind: 'info', message: `Tope de ${opts.maxCalls} llamadas a herramientas alcanzado: el agente se detiene.` });
          opts.abort.abort(new ToolCallLimitExceeded(opts.maxCalls));
        }
      });
    },
  };
}

export class ToolCallLimitExceeded extends Error {
  constructor(readonly maxCalls: number) {
    super(`El agente superó el tope de ${maxCalls} llamadas a herramientas y se detuvo.`);
    this.name = 'ToolCallLimitExceeded';
  }
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
  /** Si la ronda agotó este tope de turnos (limits.turns), no se reanuda: se reporta y se detiene. */
  maxTurns?: number;
}): Plugin & { readonly lastResult: GateResult | undefined; readonly rounds: number; reset(): void } {
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
    /** Nueva etapa (acto): las rondas de revisión vuelven a cero. */
    reset() {
      rounds = 0;
      lastResult = undefined;
    },
    initAgent(agent: LocalAgent) {
      // AfterInvocationEvent también se dispara cuando la invocación falla y no trae el error:
      // lo detectamos aquí para no validar (ni reanudar) un intento que nunca terminó.
      let modelFailed = false;
      let turns = 0;
      // BeforeInvocationEvent se dispara también en cada ronda reanudada (verificado en el SDK 1.19.0)
      agent.addHook(BeforeInvocationEvent, () => {
        modelFailed = false;
        turns = 0;
      });
      agent.addHook(AfterModelCallEvent, (e) => {
        if (e.error && !e.retry) modelFailed = true;
        else if (!e.error) turns++;
      });
      agent.addHook(AfterInvocationEvent, async (e) => {
        if (opts.abort?.signal.aborted || modelFailed) return;
        lastResult = await opts.validate(agent);
        opts.sink({ kind: 'validation', round: rounds, ok: lastResult.ok, problems: lastResult.problems });
        if (lastResult.ok || rounds >= opts.maxRounds) return;
        if (opts.maxTurns !== undefined && turns >= opts.maxTurns) {
          opts.sink({ kind: 'info', message: `Tope de ${opts.maxTurns} turnos alcanzado: el agente se detiene sin reanudar.` });
          return;
        }
        rounds++;
        e.resume =
          `La validación falló (ronda de revisión ${rounds}/${opts.maxRounds}). Corrige SOLO esto y vuelve a validar:\n` +
          lastResult.problems.map((p) => `- ${p}`).join('\n');
      });
    },
  };
}
