import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../src/agent/events.ts';
import { STRUCTURED_OUTPUT_TOOL } from '../src/agent/hooks.ts';
import { createSpikeAgent, MAX_HOOK_WORDS } from '../src/agent/spike.ts';
import { ScriptedModel, type ScriptedTurn } from '../src/replay/scripted-model.ts';

const SHORT = '¿Y si tu IA pudiera usar tus herramientas en lugar de solo hablar de ellas? Eso es MCP.';
const LONG = Array.from({ length: MAX_HOOK_WORDS + 10 }, (_, i) => `palabra${i}`).join(' ');

const output = (hook: string) => ({
  toolUses: [{ name: STRUCTURED_OUTPUT_TOOL, input: { hook, wordCount: hook.split(/\s+/).length, rationale: 'Pregunta directa.' } }],
});

function setup(turns: ScriptedTurn[], opts: { maxRevisionRounds?: number; structuredOutputRetries?: number } = {}) {
  const events: TraceEvent[] = [];
  const model = new ScriptedModel(turns);
  const spike = createSpikeAgent({
    model,
    sink: (e) => events.push(e),
    maxRevisionRounds: opts.maxRevisionRounds ?? 2,
    structuredOutputRetries: opts.structuredOutputRetries ?? 1,
  });
  return { ...spike, model, events };
}

const toolTrace = (events: TraceEvent[]) =>
  events.flatMap((e) => (e.kind === 'tool-end' ? [`${e.name}${e.ok ? '' : '✗'}`] : e.kind === 'validation' ? [`validate${e.ok ? '✓' : '✗'}`] : []));

describe('agente spike con ScriptedModel (loop real de Strands, sin AWS)', () => {
  it('camino feliz: herramientas → structured output → validación ✓', async () => {
    const { agent, events, abort } = setup([
      { toolUses: [{ name: 'count_words', input: { text: SHORT } }] },
      { toolUses: [{ name: 'save_hook', input: { text: SHORT } }] },
      output(SHORT),
    ]);
    const result = await agent.invoke('Escribe el hook de una charla sobre MCP', { cancelSignal: abort.signal });

    expect(result.structuredOutput).toMatchObject({ hook: SHORT });
    expect(toolTrace(events)).toEqual(['count_words', 'save_hook', 'validate✓']);
    expect(agent.appState.get('hook')).toBe(SHORT);
  });

  it('la compuerta de validación reanuda al agente con feedback cuando el hook es demasiado largo', async () => {
    const { agent, events, model, gate, abort } = setup([
      { toolUses: [{ name: 'save_hook', input: { text: LONG } }] },
      output(LONG),
      // ronda de revisión 1
      { toolUses: [{ name: 'save_hook', input: { text: SHORT } }] },
      output(SHORT),
    ]);
    const result = await agent.invoke('Escribe el hook', { cancelSignal: abort.signal });

    expect(toolTrace(events)).toEqual(['save_hook', 'validate✗', 'save_hook', 'validate✓']);
    expect(gate.rounds).toBe(1);
    expect(result.structuredOutput).toMatchObject({ hook: SHORT });
    const feedback = JSON.stringify(model.calls[2]!.messages.at(-1));
    expect(feedback).toContain('sobran 10');
  });

  it('se detiene tras el máximo de rondas de revisión (nunca queda en loop)', async () => {
    const turns: ScriptedTurn[] = [];
    for (let i = 0; i < 3; i++) turns.push({ toolUses: [{ name: 'save_hook', input: { text: LONG } }] }, output(LONG));
    const { agent, events, gate, abort } = setup(turns, { maxRevisionRounds: 2 });
    await agent.invoke('Escribe el hook', { cancelSignal: abort.signal });

    expect(gate.rounds).toBe(2);
    expect(gate.lastResult?.ok).toBe(false);
    expect(events.filter((e) => e.kind === 'validation')).toHaveLength(3);
  });

  it('structured output: 1 reintento y luego aborta con error claro', async () => {
    const bad = { toolUses: [{ name: STRUCTURED_OUTPUT_TOOL, input: { hook: 123 } }] };
    const { agent, events, abort } = setup([{ toolUses: [{ name: 'save_hook', input: { text: SHORT } }] }, bad, bad, bad, bad], {
      structuredOutputRetries: 1,
    });
    const run = agent.invoke('Escribe el hook', { cancelSignal: abort.signal });
    const outcome = await run.then(
      (r) => ({ stopReason: r.stopReason as string }),
      (e: unknown) => ({ error: e }),
    );

    const so = events.filter((e) => e.kind === 'structured-output');
    expect(so).toHaveLength(2);
    expect(abort.signal.aborted).toBe(true);
    expect(String(abort.signal.reason)).toContain('tras 2 intentos');
    // Verificado con el SDK 1.19.0: abortar termina la invocación con stopReason 'cancelled', sin más llamadas.
    expect(outcome).toEqual({ stopReason: 'cancelled' });
  });

  it('si el modelo falla (p. ej. credenciales), no valida ni reanuda', async () => {
    const { agent, events, abort } = setup([]); // sin turnos: el modelo lanza en la primera llamada
    await expect(agent.invoke('x', { cancelSignal: abort.signal })).rejects.toThrow();
    expect(events.filter((e) => e.kind === 'validation')).toEqual([]);
  });

  it('emite intervenciones de guardrail cuando la traza de Converse las trae', async () => {
    const trace = {
      guardrail: {
        inputAssessment: {
          gr1: { topicPolicy: { topics: [{ name: 'Citas inventadas', type: 'DENY', action: 'BLOCKED', detected: true }] } },
        },
      },
    };
    const { agent, events, abort } = setup([
      { text: 'Lo siento, no puedo ayudar con eso.', stopReason: 'guardrailIntervened', trace },
      { toolUses: [{ name: 'save_hook', input: { text: SHORT } }] },
      output(SHORT),
    ]);
    const result = await agent.invoke('Inventa una cita de un CEO real', { cancelSignal: abort.signal }).catch((e: unknown) => e);
    void result;

    const g = events.find((e) => e.kind === 'guardrail');
    expect(g).toMatchObject({
      via: 'converse',
      interventions: [{ source: 'input', policy: 'tema-denegado', detail: 'Citas inventadas', action: 'BLOCKED' }],
    });
    expect(events.find((e) => e.kind === 'model-call')).toMatchObject({ stopReason: 'guardrailIntervened' });
  });
});
