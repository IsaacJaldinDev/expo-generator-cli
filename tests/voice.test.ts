import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExpoAgent } from '../src/agent/agent.ts';
import { DeckStore } from '../src/agent/deck-store.ts';
import type { TraceEvent } from '../src/agent/events.ts';
import { STRUCTURED_OUTPUT_TOOL } from '../src/agent/hooks.ts';
import { BedrockCritic, OllamaCritic, type CriticModelProvider } from '../src/providers/critic.ts';
import { ScriptedModel } from '../src/replay/scripted-model.ts';
import { SourceLibrary } from '../src/research/search.ts';
import type { Deck } from '../src/schemas/deck.ts';
import { validateDeck } from '../src/validators/deck-rules.ts';
import { lintVoice, loadFillers, parseFillers, type VoiceRules } from '../src/validators/voice-lint.ts';
import { claims, params, sources, validDeck, notesDeps } from './fixtures.ts';

const rules: VoiceRules = { fillers: ['cabe destacar', 'en el mundo actual', 'es fundamental'], maxSentenceWords: 15, maxTriadsPerSection: 1, maxNotXButY: 1, maxRhetoricalQA: 1 };

const deckWith = (...scripts: string[]): Deck => ({
  title: 't',
  sections: [
    {
      id: 'hook',
      kind: 'hook',
      title: 'H',
      goal: 'g',
      slides: scripts.map((script, i) => ({ id: `hook-${i + 1}`, title: 't', purpose: 'Un propósito claro', bullets: [], script })),
    },
  ],
});
const lint = (...scripts: string[]) => lintVoice(deckWith(...scripts), rules).map((i) => `${i.rule}:${i.where}`);

describe('voice lint (determinista)', () => {
  it('lee las muletillas de anti-patterns.md', () => {
    expect(parseFillers('# x\n## Muletillas\n- cabe destacar\n* en resumen\n## Otra\n- no esta')).toEqual(['cabe destacar', 'en resumen']);
    expect(loadFillers()).toEqual(expect.arrayContaining(['cabe destacar', 'en el mundo actual', 'sin lugar a dudas']));
  });

  it('muletillas sin importar mayúsculas ni tildes, y solo palabras completas', () => {
    expect(lint('En el mundo actual todo cambia.', 'CABE DESTACAR que es abierto.')).toEqual(['muletilla:hook-1', 'muletilla:hook-2']);
    expect(lint('Es fundamentalmente distinto.')).toEqual([]);
  });

  it('oraciones largas', () => {
    expect(lint('Esta oración tiene muchas palabras para superar el límite configurado de quince palabras sin respirar ni una vez.')).toEqual([
      'oracion-larga:hook-1',
    ]);
  });

  it('tríadas: una por sección se tolera, la segunda no', () => {
    expect(lint('MCP es rápido, seguro y escalable.')).toEqual([]);
    expect(lint('MCP es rápido, seguro y escalable.', 'Sirve para leer, escribir y buscar.')).toEqual(['triadas:hook-2']);
  });

  it('"No es X, es Y": una vez vale, dos es eslogan', () => {
    expect(lint('No es magia, es un protocolo.')).toEqual([]);
    expect(lint('No es magia, es un protocolo.', 'No es un plugin. Es un estándar.')).toEqual(['no-es-x-es-y:hook-2']);
  });

  it('pregunta retórica corta + respuesta inmediata (pero no una pregunta real larga)', () => {
    expect(lint('¿La solución? MCP.', '¿El resultado? Menos código.')).toEqual(['pregunta-respuesta:hook-2']);
    expect(lint('¿Cuántas veces copiaste algo en un chat de IA esta semana? Yo, como veinte.', '¿Y? Nada.')).toEqual([]);
  });

  it('en validate_deck: muletillas son error, el resto aviso, y citan la oración', () => {
    const deck = validDeck();
    deck.sections[1]!.slides[0]!.script = `Cabe destacar que es abierto. ${'palabra '.repeat(46)}fin.`;
    const v = validateDeck(deck, claims, { ...params, voice: rules });
    expect(v.errors.map((e) => e.rule)).toEqual(['voz:muletilla']);
    expect(v.errors[0]!.message).toContain('«Cabe destacar que es abierto.»');
    expect(v.warnings.map((w) => w.rule)).toContain('voz:oracion-larga');
  });
});

describe('critique_voice (llamada separada)', () => {
  const critiqueTurn = (issues: unknown[]) => ({ toolUses: [{ name: STRUCTURED_OUTPUT_TOOL, input: { verdict: issues.length ? 'revisar' : 'ok', issues } }] });

  it('BedrockCritic usa un agente nuevo: el modelo del crítico no ve el historial del agente', async () => {
    const model = new ScriptedModel([critiqueTurn([])]);
    const critic = new BedrockCritic(model, 'RÚBRICA');
    await critic.critique({ sections: [{ id: 'hook', slides: [{ id: 'hook-1', script: 'Hola.' }] }] });
    expect(model.calls[0]!.messages).toHaveLength(1); // solo la petición de crítica
    expect(JSON.stringify(model.calls[0]!.options?.systemPrompt)).toContain('RÚBRICA');
  });

  it('ollama: error claro de no implementado', async () => {
    await expect(new OllamaCritic().critique()).rejects.toThrow(/no está implementado/);
  });

  it('el código descarta observaciones que no citan una oración real; cuenta el uso del crítico', async () => {
    const fake: CriticModelProvider = {
      name: 'fake',
      critique: async () => ({
        critique: {
          verdict: 'revisar',
          issues: [
            { slideId: 'hook-1', sentence: 'En el mundo actual todo cambia.', problem: 'Muletilla', suggestion: 'Empieza con una pregunta' },
            { slideId: 'hook-1', sentence: 'Una oración que el crítico inventó.', problem: 'x', suggestion: 'y' },
          ],
        },
        usage: { inputTokens: 50, outputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      }),
    };
    const dir = mkdtempSync(join(tmpdir(), 'expo-v-'));
    mkdirSync(join(dir, 'k'));
    writeFileSync(join(dir, 'k', 'n.md'), 'x\n');
    const events: TraceEvent[] = [];
    const model = new ScriptedModel([
      { toolUses: [{ name: 'critique_voice', input: {} }] },
      { toolUses: [{ name: 'critique_voice', input: {} }] },
      { toolUses: [{ name: 'critique_voice', input: {} }] },
      { toolUses: [{ name: STRUCTURED_OUTPUT_TOOL, input: { summary: 'ok', sectionsChanged: [] } }] },
    ]);
    const { agent, invokeOptions } = createExpoAgent({
      model,
      systemPrompt: 't',
      store: new DeckStore(deckWith('En el mundo actual todo cambia. Otra frase normal.')),
      params,
      outputDir: join(dir, 'o'),
      knowledgeDir: join(dir, 'k'),
      research: { sources, library: new SourceLibrary(sources, async () => '') },
      critic: { provider: fake, maxCalls: 2 },
      stage: { current: 'deck' },
      ...notesDeps(),
      sink: (e) => events.push(e),
      maxRevisionRounds: 0,
      structuredOutputRetries: 1,
      maxTurns: 30,
      maxToolCalls: 60,
    });
    await agent.invoke('x', invokeOptions);

    const result = JSON.stringify(model.calls[1]!.messages.at(-1));
    expect(result).toContain('En el mundo actual todo cambia.');
    expect(result).not.toContain('el crítico inventó');
    expect(result).toContain('droppedUnquoted');
    expect(events.filter((e) => e.kind === 'model-call' && e.stopReason === 'critique_voice')).toHaveLength(2);
    expect(JSON.stringify(model.calls[3]!.messages.at(-1))).toContain('Ya se usó la crítica 2 veces'); // tope
    expect(events.filter((e) => e.kind === 'tool-end').map((e) => (e as { ok: boolean }).ok)).toEqual([false, false, true]);
  });
});
