/**
 * Fase 1 — corre el agente completo (consola simple; la vista Ink llega en la fase 4).
 *   npm run agent                                   # continúa el deck de output/ o lo crea
 *   npm run agent -- --fresh                        # empieza desde cero
 *   npm run agent -- "Haz el inicio más provocador" # edición conversacional
 *   npm run agent -- --no-guardrail                 # sin Bedrock Guardrails
 *   npm run agent -- --scope=hook,cierre "…"        # edición que puede tocar varias secciones
 */
import { rmSync } from 'node:fs';
import { styleText } from 'node:util';
import { createExpoAgent, buildUserMessage, type RunSummary } from '../src/agent/agent.ts';
import { addUsage, emptyUsage, estimateCostUsd } from '../src/agent/cost.ts';
import { DeckStore } from '../src/agent/deck-store.ts';
import type { TraceEvent } from '../src/agent/events.ts';
import { deckParams } from '../src/agent/params.ts';
import { buildSystemPrompt } from '../src/agent/system-prompt.ts';
import { consoleTrace } from '../src/cli/console-trace.ts';
import { createGuardrailChecker } from '../src/guardrails/apply.ts';
import { cachedSystemPrompt, createAgentModel } from '../src/providers/bedrock.ts';
import { renderTiming } from '../src/render/timing.ts';
import { loadBrandGuide } from '../src/schemas/brand.ts';
import { loadBrief } from '../src/schemas/brief.ts';
import { activeModel, loadConfig } from '../src/schemas/config.ts';
import { loadKnowledgeFragments } from '../src/tools/read-knowledge.ts';
import { validateDeck } from '../src/validators/deck-rules.ts';

const OUTPUT = 'output';
const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const noGuardrail = args.includes('--no-guardrail');
const scopeArg = args.find((a) => a.startsWith('--scope='))?.slice('--scope='.length);
const instructionArg = args.filter((a) => !a.startsWith('--')).join(' ').trim();

const cfg = loadConfig();
if (noGuardrail) cfg.guardrail.enabled = false;
const brief = loadBrief();
const params = deckParams(cfg, brief, loadBrandGuide());
const m = activeModel(cfg);

if (fresh) for (const f of ['deck.json', 'claims.json', 'script.md', 'timing.md']) rmSync(`${OUTPUT}/${f}`, { force: true });
const store = DeckStore.load(OUTPUT, brief.title);
// En ediciones el agente puede no llamar read_knowledge: precarga los fragmentos para verificar citas a los apuntes.
store.setKnowledge(loadKnowledgeFragments('knowledge'));
const hasDeck = store.deck.sections.length > 0;
// Edición puntual: hay deck y el usuario dio una instrucción. El alcance lo fija --scope o la primera sección tocada.
if (hasDeck && instructionArg) store.startEdit(scopeArg ? scopeArg.split(',') : []);
const instruction = instructionArg || (hasDeck ? 'Revisa la exposición y deja todo validado.' : 'Prepara la exposición completa a partir del brief y de mis apuntes.');

let usage = emptyUsage();
const sink = (e: TraceEvent) => {
  if (e.kind === 'model-call' && e.usage) usage = addUsage(usage, e.usage);
  consoleTrace(e);
};

console.log(
  styleText('bold', `\n${brief.title}`),
  styleText('dim', `\n${m.key} → ${m.modelId} · guardrail ${cfg.guardrail.enabled ? 'ON' : 'OFF'} · ${hasDeck ? 'deck existente' : 'deck nuevo'}`),
  styleText('cyan', `\n» ${instruction}\n`),
);

const { agent, abort, gate, invokeOptions } = createExpoAgent({
  model: createAgentModel(cfg),
  systemPrompt: cachedSystemPrompt(cfg, buildSystemPrompt(brief, params)),
  store,
  params,
  outputDir: OUTPUT,
  knowledgeDir: 'knowledge',
  sink,
  ...(cfg.guardrail.enabled ? { checker: createGuardrailChecker(cfg) } : {}),
  maxRevisionRounds: cfg.agent.maxRevisionRounds,
  structuredOutputRetries: cfg.agent.structuredOutputRetries,
  maxTurns: cfg.agent.maxTurns,
  maxToolCalls: cfg.agent.maxToolCalls,
});

const t0 = performance.now();
try {
  const result = await agent.invoke(buildUserMessage(instruction, store.deck, { claims: store.claims }, hasDeck), invokeOptions);
  if (result.stopReason === 'cancelled' && abort.signal.reason instanceof Error) throw abort.signal.reason;
  if (result.stopReason === 'limitTurns') {
    console.log(styleText(['yellow', 'bold'], `\n⏹ Tope de ${cfg.agent.maxTurns} turnos alcanzado: el agente se detuvo.`));
  }
  if (result.stopReason === 'guardrailIntervened') {
    console.log(styleText(['red', 'bold'], `\n🛡 Bedrock Guardrails detuvo la ejecución: ${String(result)}`));
  }
  const summary = result.structuredOutput as RunSummary | undefined;
  if (summary) console.log(styleText('bold', '\nResumen del agente:'), summary.summary);
} catch (err) {
  console.error(styleText('red', `\n✗ ${(err as Error).name}: ${(err as Error).message}`));
  process.exitCode = 1;
} finally {
  store.save(OUTPUT, params);
  const v = validateDeck(store.deck, store.claims, params);
  const changed = [...new Set(store.changes.map((c) => `${c.sectionId} (${c.action})`))];
  console.log(styleText('bold', '\nSecciones tocadas:'), changed.length ? changed.join(', ') : 'ninguna');
  console.log('\n' + renderTiming(store.deck, params));
  console.log(
    v.ok
      ? styleText(['green', 'bold'], `✓ validate_deck pasa (${gate.rounds} rondas de revisión)`)
      : styleText(['red', 'bold'], `✗ validate_deck falla tras ${gate.rounds} rondas:\n  ${v.errors.map((e) => `[${e.rule}] ${e.where}: ${e.message}`).join('\n  ')}`),
  );
  if (v.warnings.length) console.log(styleText('yellow', `  avisos: ${v.warnings.map((w) => w.message).join(' · ')}`));
  if (!v.ok) process.exitCode = 1;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(
    styleText('bold', `\n${secs}s · tokens in ${usage.inputTokens} / out ${usage.outputTokens}`),
    `· cache read ${usage.cacheReadInputTokens} / write ${usage.cacheWriteInputTokens}`,
    styleText('bold', `· ~$${estimateCostUsd(usage, m.pricing).toFixed(4)} USD`),
    styleText('dim', `\nArchivos: ${OUTPUT}/deck.json · claims.json · script.md · timing.md`),
  );
}
