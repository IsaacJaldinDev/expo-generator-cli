import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@strands-agents/sdk';
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../src/agent/events.ts';
import { guardrailCostUsd, interpretGrounding, type GuardrailChecker } from '../src/guardrails/apply.ts';
import { listScenarios, loadScenario, runScenario } from '../src/guardrails/scenarios.ts';
import {
  emptyCassette,
  loadCassette,
  recordingChecker,
  RecordingModel,
  replayChecker,
  ReplayModel,
  saveCassette,
} from '../src/replay/cassette.ts';
import { ScriptedModel } from '../src/replay/scripted-model.ts';

const PRICING = { contentFilters: 0.15, deniedTopics: 0.15, sensitiveInfo: 0.1, contextualGrounding: 0.1 };

/** Checker falso: bloquea "ignora", enmascara correos, y el grounding pasa solo si el contenido aparece en la fuente. */
const fakeChecker: GuardrailChecker = {
  async check(text, source) {
    if (/olvida las reglas/i.test(text)) {
      return { intervened: true, blocked: true, text: 'bloqueado', costUsd: 0.0004, interventions: [{ source, policy: 'prompt-attack', detail: 'PROMPT_ATTACK', action: 'BLOCKED' }] };
    }
    if (/@/.test(text)) {
      return {
        intervened: true,
        blocked: false,
        text: text.replace(/\S+@\S+?(?=[\s.,]|$)/g, '{EMAIL}'),
        costUsd: 0.0004,
        interventions: [{ source, policy: 'datos-sensibles', detail: 'EMAIL', action: 'ANONYMIZED' }],
      };
    }
    return { intervened: false, blocked: false, text, interventions: [], costUsd: 0.0001 };
  },
  async ground({ source, content }) {
    const grounded = content.includes('estándar abierto') && source.length > 0;
    return {
      grounded,
      groundingScore: grounded ? 0.99 : 0,
      interventions: grounded ? [] : [{ source: 'output', policy: 'grounding', detail: 'GROUNDING (score 0 < umbral 0.75)', action: 'BLOCKED' }],
      costUsd: 0.0005,
    };
  },
};

describe('interpretación de ApplyGuardrail', () => {
  it('grounding: puntajes y bloqueo solo por GROUNDING (la relevancia no decide)', () => {
    const r = interpretGrounding(
      {
        assessments: [
          {
            contextualGroundingPolicy: {
              filters: [
                { type: 'GROUNDING', score: 0.12, threshold: 0.75, action: 'BLOCKED', detected: true },
                { type: 'RELEVANCE', score: 0.2, threshold: 0.5, action: 'BLOCKED', detected: true },
              ],
            },
          },
        ],
        usage: undefined,
      },
      PRICING,
    );
    expect(r).toMatchObject({ grounded: false, groundingScore: 0.12, relevanceScore: 0.2 });
    expect(r.interventions.map((i) => i.detail)).toEqual(['GROUNDING (score 0.12 < umbral 0.75)']);
  });

  it('costo por unidades de texto y precios de config', () => {
    const usd = guardrailCostUsd(
      {
        contentPolicyUnits: 2,
        topicPolicyUnits: 2,
        sensitiveInformationPolicyUnits: 2,
        sensitiveInformationPolicyFreeUnits: 0,
        contextualGroundingPolicyUnits: 1,
        wordPolicyUnits: 2,
      },
      PRICING,
    );
    expect(usd).toBeCloseTo((2 * 0.15 + 2 * 0.15 + 2 * 0.1 + 1 * 0.1) / 1000);
  });
});

describe('cassettes: grabar y reproducir sin red', () => {
  it('modelo: RecordingModel graba los eventos; ReplayModel los reproduce en el loop real de Strands', async () => {
    const cassette = emptyCassette('t');
    const live = new ScriptedModel([{ text: 'Hola desde el modelo.' }]);
    const a1 = new Agent({ model: new RecordingModel(live, cassette), printer: false });
    expect(String(await a1.invoke('hola')).trim()).toBe('Hola desde el modelo.');

    const dir = mkdtempSync(join(tmpdir(), 'cas-'));
    saveCassette(join(dir, 'c.json'), cassette);
    const loaded = loadCassette(join(dir, 'c.json'));
    expect(loaded.model.calls).toHaveLength(1);
    expect(loaded.model.ms).toHaveLength(1);

    const a2 = new Agent({ model: new ReplayModel(loaded, 0, 0), printer: false });
    expect(String(await a2.invoke('hola')).trim()).toBe('Hola desde el modelo.');
    await expect(new Agent({ model: new ReplayModel(loaded, 0, 0), printer: false }).invoke('x').then(() => a2.invoke('otra'))).rejects.toThrow(/no hay más llamadas/);
  });

  it('guardrail: la misma entrada devuelve la misma respuesta grabada; una entrada nueva falla con mensaje claro', async () => {
    const cassette = emptyCassette('g');
    const rec = recordingChecker(fakeChecker, cassette);
    const live = await rec.check('ana@uni.edu', 'input');
    await rec.ground({ source: 's', query: 'q', content: 'MCP es un estándar abierto' });
    expect(cassette.guardrail.map((g) => g.op)).toEqual(['check', 'ground']);

    const rep = replayChecker(cassette, 0);
    expect(await rep.check('ana@uni.edu', 'input')).toEqual(live);
    expect((await rep.ground({ source: 's', query: 'q', content: 'MCP es un estándar abierto' })).grounded).toBe(true);
    await expect(rep.check('otro texto', 'input')).rejects.toThrow(/no hay respuesta de guardrail grabada/);
  });
});

describe('escenarios de guardrails', () => {
  const run = async (name: string, model = () => new ScriptedModel([])) => {
    const events: TraceEvent[] = [];
    const out = await runScenario(loadScenario(name), { checker: fakeChecker, model, systemPrompt: 's', sink: (e) => events.push(e) });
    return { out, events };
  };

  it('los 4 escenarios versionados son válidos', () => {
    expect(listScenarios()).toEqual(['denied-topic', 'grounding', 'injection', 'pii']);
    for (const n of listScenarios()) expect(loadScenario(n).expect.policy).toBeTruthy();
  });

  it('injection: read_knowledge ✗ y el archivo no llega al modelo', async () => {
    const { out, events } = await run('injection');
    expect(out.triggered).toBe(true);
    expect(out.details[0]).toContain('Archivos bloqueados (el modelo no los ve): notes.md');
    expect(events.find((e) => e.kind === 'tool-end')).toMatchObject({ name: 'read_knowledge', ok: false });
  });

  it('pii: el correo llega enmascarado', async () => {
    const { out } = await run('pii');
    expect(out.triggered).toBe(true);
    expect(out.details.join('\n')).toContain('{EMAIL}');
    expect(out.details.join('\n')).not.toContain('ana.perez@ejemplo.edu');
  });

  it('grounding: cada oración da lo esperado', async () => {
    const { out, events } = await run('grounding');
    expect(out.triggered).toBe(true);
    expect(events.filter((e) => e.kind === 'tool-end').map((e) => (e as { ok: boolean }).ok)).toEqual([true, false, false]);
  });

  it('denied-topic: dispara si Converse devuelve guardrailIntervened con la traza del tema', async () => {
    const trace = { guardrail: { inputAssessment: { g: { topicPolicy: { topics: [{ name: 'Citas inventadas', type: 'DENY', action: 'BLOCKED', detected: true }] } } } } };
    const { out } = await run('denied-topic', () => new ScriptedModel([{ text: '🛡 bloqueado', stopReason: 'guardrailIntervened', trace }]));
    expect(out.triggered).toBe(true);
    const { out: notTriggered } = await run('denied-topic', () => new ScriptedModel([{ text: 'Claro, aquí va la cita…' }]));
    expect(notTriggered.triggered).toBe(false);
  });
});
