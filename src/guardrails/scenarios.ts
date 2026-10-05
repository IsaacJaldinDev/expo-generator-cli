import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, type Model } from '@strands-agents/sdk';
import { parse } from 'yaml';
import { z } from 'zod';
import type { TraceEvent, TraceSink } from '../agent/events.ts';
import { tracePlugin } from '../agent/hooks.ts';
import { readKnowledgeGuarded, type KnowledgeFragment } from '../tools/read-knowledge.ts';
import type { GuardrailChecker } from './apply.ts';
import type { GuardrailIntervention } from './trace.ts';

export const SCENARIOS_DIR = 'demo/scenarios/guardrails';

const Expect = z.object({ policy: z.string(), action: z.string() });
const Base = { title: z.string(), explain: z.string(), expect: Expect };

export const ScenarioSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('knowledge'), ...Base }),
  z.object({ kind: z.literal('converse'), instruction: z.string().min(1), ...Base }),
  z.object({
    kind: z.literal('grounding'),
    claim: z.object({ id: z.string(), sourceUrl: z.url(), quote: z.string().min(1) }),
    query: z.string(),
    sentences: z.array(z.object({ text: z.string().min(1), grounded: z.boolean() })).min(1),
    ...Base,
  }),
]);
export type Scenario = z.infer<typeof ScenarioSchema> & { name: string; dir: string };

export function listScenarios(dir = SCENARIOS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'scenario.yml')))
    .map((d) => d.name)
    .sort();
}

export function loadScenario(name: string, dir = SCENARIOS_DIR): Scenario {
  const path = join(dir, name, 'scenario.yml');
  if (!existsSync(path)) throw new Error(`No existe el escenario "${name}". Disponibles: ${listScenarios(dir).join(', ')}`);
  return { ...ScenarioSchema.parse(parse(readFileSync(path, 'utf8'))), name, dir: join(dir, name) };
}

export interface ScenarioOutcome {
  /** El guardrail intervino como dice `expect` (y, en grounding, cada oración dio lo esperado). */
  triggered: boolean;
  interventions: GuardrailIntervention[];
  /** Detalle para el panel final. */
  details: string[];
}

export interface ScenarioDeps {
  checker: GuardrailChecker;
  /** Solo para escenarios "converse": el modelo del agente, con guardrailConfig. */
  model: () => Model;
  systemPrompt: string;
  sink: TraceSink;
}

/** Ejecuta un escenario y verifica en código que el guardrail intervino. */
export async function runScenario(s: Scenario, deps: ScenarioDeps): Promise<ScenarioOutcome> {
  const interventions: GuardrailIntervention[] = [];
  const sink = (e: TraceEvent) => {
    if (e.kind === 'guardrail') interventions.push(...e.interventions);
    deps.sink(e);
  };
  const details: string[] = [];
  let extraOk = true;
  const tool = async <T>(name: string, input: unknown, fn: () => Promise<{ ok: boolean; note?: string; value: T }>): Promise<T> => {
    const id = `${name}-${Math.random().toString(36).slice(2, 8)}`;
    const t = performance.now();
    sink({ kind: 'tool-start', id, name, input });
    const r = await fn();
    sink({ kind: 'tool-end', id, name, ok: r.ok, ms: Math.round(performance.now() - t), ...(r.note ? { note: r.note } : {}) });
    return r.value;
  };

  switch (s.kind) {
    case 'knowledge': {
      const r = await tool('read_knowledge', {}, async () => {
        const v = await readKnowledgeGuarded(join(s.dir, 'knowledge'), deps.checker, sink);
        return { ok: v.blocked.length === 0, ...(v.blocked.length ? { note: `bloqueado: ${v.blocked.join(', ')}` } : {}), value: v };
      });
      if (r.blocked.length) details.push(`Archivos bloqueados (el modelo no los ve): ${r.blocked.join(', ')}`);
      details.push(...r.fragments.map((f: KnowledgeFragment) => `${f.id}  ${f.text}`));
      break;
    }
    case 'converse': {
      const agent = new Agent({ model: deps.model(), systemPrompt: deps.systemPrompt, printer: false, plugins: [tracePlugin(sink)] });
      const result = await agent.invoke(s.instruction);
      details.push(`stopReason: ${result.stopReason}`, `respuesta: ${String(result).trim()}`);
      extraOk = result.stopReason === 'guardrailIntervened';
      break;
    }
    case 'grounding': {
      details.push(`fuente [^${s.claim.id}] ${s.claim.sourceUrl}`);
      for (const sentence of s.sentences) {
        const g = await tool('contextual_grounding', { claim: sentence.text }, async () => {
          const v = await deps.checker.ground({ source: s.claim.quote, query: s.query, content: sentence.text });
          if (v.interventions.length) sink({ kind: 'guardrail', via: 'apply-guardrail', interventions: v.interventions });
          return { ok: v.grounded, note: `grounding ${v.groundingScore?.toFixed(2) ?? '?'}`, value: v };
        });
        const asExpected = g.grounded === sentence.grounded;
        extraOk &&= asExpected;
        details.push(`${g.grounded ? '✓' : '✗'} ${g.groundingScore?.toFixed(2) ?? '?'}  ${sentence.text}${asExpected ? '' : '   ← NO es lo esperado'}`);
      }
      break;
    }
  }

  const triggered = extraOk && interventions.some((i) => i.policy === s.expect.policy && i.action === s.expect.action);
  return { triggered, interventions, details };
}
