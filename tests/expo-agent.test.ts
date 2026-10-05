import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExpoAgent } from '../src/agent/agent.ts';
import { DeckStore } from '../src/agent/deck-store.ts';
import type { TraceEvent } from '../src/agent/events.ts';
import { STRUCTURED_OUTPUT_TOOL } from '../src/agent/hooks.ts';
import { ScriptedModel, type ScriptedTurn } from '../src/replay/scripted-model.ts';
import { SourceLibrary } from '../src/research/search.ts';
import { params, sources, words, notesDeps } from './fixtures.ts';

const slide = (n: number, script = words(n)) => ({ title: 'Título', purpose: 'Un propósito claro aquí', bullets: ['Idea'], script });
const call = (name: string, input: unknown = {}) => ({ toolUses: [{ name, input }] });
const done = call(STRUCTURED_OUTPUT_TOOL, { summary: 'Listo.', sectionsChanged: ['que-es'] });

function setup(turns: ScriptedTurn[], store = new DeckStore({ title: 'Charla', sections: [] }), maxTurns = 30, maxToolCalls = 60) {
  const dir = mkdtempSync(join(tmpdir(), 'expo-agent-'));
  const knowledgeDir = join(dir, 'knowledge');
  mkdirSync(knowledgeDir);
  writeFileSync(join(knowledgeDir, 'notes.md'), '# MCP\n\nMCP es un protocolo abierto.\n');
  const events: TraceEvent[] = [];
  const model = new ScriptedModel(turns);
  const expo = createExpoAgent({
    model,
    systemPrompt: 'test',
    store,
    params,
    outputDir: join(dir, 'output'),
    knowledgeDir,
    research: { sources, library: new SourceLibrary(sources, async () => '<p>No pages in this test.</p>') },
    stage: { current: 'deck' },
    ...notesDeps(),
    sink: (e) => events.push(e),
    maxRevisionRounds: 2,
    structuredOutputRetries: 1,
    maxTurns,
    maxToolCalls,
  });
  /** La traza como la verá el público: herramienta + ✓/✗. */
  const trace = () =>
    events.flatMap((e) =>
      e.kind === 'tool-end' ? [`${e.name}${e.ok ? '' : ' ✗'}`] : e.kind === 'validation' ? [`gate ${e.ok ? '✓' : '✗'}`] : [],
    );
  return { ...expo, model, events, store, dir, trace };
}

describe('agente de exposición (loop real de Strands con ScriptedModel)', () => {
  it('acto 3: check_timing ✗ → update_section → check_timing ✓ → validate_deck ✓', async () => {
    const { agent, abort, trace, store, dir, model } = setup([
      call('read_knowledge'),
      call('update_section', { sectionId: 'hook', kind: 'hook', title: 'Hook', goal: 'Enganchar', targetSeconds: 20, slides: [slide(20)] }),
      call('update_section', { sectionId: 'que-es', kind: 'body', title: 'Qué es', goal: 'Explicar', targetSeconds: 60, slides: [slide(90)] }),
      call('update_section', { sectionId: 'cierre', kind: 'close', title: 'Cierre', goal: 'Cerrar', targetSeconds: 20, slides: [slide(20)] }),
      call('check_timing'), // 130 s > 100 s
      call('update_section', { sectionId: 'que-es', slides: [slide(50)] }),
      call('check_timing'),
      call('validate_deck'),
      done,
    ]);
    const result = await agent.invoke('Prepara la exposición', { cancelSignal: abort.signal });

    expect(trace()).toEqual([
      'read_knowledge',
      'update_section',
      'update_section',
      'update_section',
      'check_timing ✗',
      'update_section',
      'check_timing',
      'validate_deck',
      'gate ✓',
    ]);
    expect(result.structuredOutput).toMatchObject({ summary: 'Listo.' });
    expect(store.deck.sections.map((s) => s.id)).toEqual(['hook', 'que-es', 'cierre']);
    for (const f of ['deck.json', 'claims.json', 'script.md', 'timing.md']) expect(existsSync(join(dir, 'output', f))).toBe(true);

    // lo que el modelo recibió de check_timing tras el exceso
    const timingResult = JSON.stringify(model.calls[5]!.messages.at(-1));
    expect(timingResult).toContain('sobran 30 s');
    expect(timingResult).toContain('de la sección \\"que-es\\"');
    // read_knowledge entregó fragmentos con id
    expect(JSON.stringify(model.calls[1]!.messages.at(-1))).toContain('notes#1');
  });

  it('la compuerta no deja terminar con un dato sin fuente y el agente lo corrige (máx. 2 rondas)', async () => {
    const seeded = `El 90% de las startups de IA ya usan MCP. ${words(42)}`;
    const store = new DeckStore({ title: 'Charla', sections: [] });
    const { agent, abort, trace, gate } = setup(
      [
        call('update_section', { sectionId: 'hook', kind: 'hook', title: 'Hook', goal: 'g', slides: [slide(20)] }),
        call('update_section', { sectionId: 'que-es', kind: 'body', title: 'Qué es', goal: 'g', slides: [slide(0, seeded)] }),
        call('update_section', { sectionId: 'cierre', kind: 'close', title: 'Cierre', goal: 'g', slides: [slide(20)] }),
        done, // intenta terminar sin validar → la compuerta lo reanuda
        call('update_section', { sectionId: 'que-es', slides: [slide(50)] }),
        call('validate_deck'),
        done,
      ],
      store,
    );
    await agent.invoke('Prepara la exposición', { cancelSignal: abort.signal });

    expect(trace()).toEqual(['update_section', 'update_section', 'update_section', 'gate ✗', 'update_section', 'validate_deck', 'gate ✓']);
    expect(gate.rounds).toBe(1);
  });

  it('tope duro de turnos: se detiene con limitTurns y la compuerta no reanuda', async () => {
    const turns: ScriptedTurn[] = Array.from({ length: 50 }, () => call('check_timing'));
    const { agent, invokeOptions, events, gate } = setup(turns, undefined, 5);
    const r = await agent.invoke('Prepara la exposición', invokeOptions);
    expect(r.stopReason).toBe('limitTurns');
    expect(events.filter((e) => e.kind === 'tool-end')).toHaveLength(5);
    expect(gate.rounds).toBe(0);
  });

  it('tope de llamadas a herramientas: varias por turno también cuentan', async () => {
    const many = { toolUses: Array.from({ length: 4 }, (_, i) => ({ name: 'check_timing', input: {}, id: `t${i}` })) };
    const { agent, invokeOptions, events, abort } = setup([many, many, many, many], undefined, 30, 6);
    const r = await agent.invoke('x', invokeOptions);
    expect(r.stopReason).toBe('cancelled');
    expect(String(abort.signal.reason)).toContain('tope de 6 llamadas');
    expect(events.filter((e) => e.kind === 'tool-end' && e.ok !== false && e.name === 'check_timing').length).toBeLessThanOrEqual(8);
  });

  it('edición: un parche a la sección 1 no toca las demás', async () => {
    const store = new DeckStore({ title: 'Charla', sections: [] });
    store.applyPatch({ sectionId: 'hook', kind: 'hook', title: 'Hook', goal: 'g', slides: [slide(20)] });
    store.applyPatch({ sectionId: 'que-es', kind: 'body', title: 'Qué es', goal: 'g', slides: [slide(50)] });
    store.applyPatch({ sectionId: 'cierre', kind: 'close', title: 'Cierre', goal: 'g', slides: [slide(20)] });
    const before = structuredClone(store.deck);
    store.changes.length = 0;

    const { agent, abort } = setup(
      [
        call('update_section', { sectionId: 'hook', slides: [slide(0, `¿Y si tu IA dejara de pedirte que copies y pegues? ${words(10)}`)] }),
        call('check_timing'),
        call('validate_deck'),
        done,
      ],
      store,
    );
    await agent.invoke('Haz el inicio más provocador', { cancelSignal: abort.signal });

    expect(store.changes.map((c) => `${c.sectionId}:${c.action}`)).toEqual(['hook:updated']);
    expect(store.deck.sections.slice(1)).toEqual(before.sections.slice(1));
    expect(store.deck.sections[0]!.slides[0]!.script).toMatch(/^¿Y si tu IA/);
  });
});
