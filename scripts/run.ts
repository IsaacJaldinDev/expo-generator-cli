/**
 * Corre el agente (consola simple; la vista Ink llega en la fase 4).
 *   npm run agent -- --fresh                        # desde cero: acto 2 (research) + acto 3 (deck)
 *   npm run agent -- --act=research                 # solo acto 2: huecos → research → claims
 *   npm run agent -- --act=deck                     # solo acto 3: deck con los claims existentes
 *   npm run agent -- "Haz el inicio más provocador" # edición conversacional
 *   npm run agent -- --no-guardrail                 # sin Bedrock Guardrails
 *   npm run agent -- --scope=hook,cierre "…"        # edición que puede tocar varias secciones
 */
import { rmSync } from 'node:fs';
import { styleText } from 'node:util';
import { StructuredOutputError, type AgentResult } from '@strands-agents/sdk';
import { createExpoAgent, buildUserMessage, STAGE_INSTRUCTIONS, type RunSummary } from '../src/agent/agent.ts';
import type { Stage } from '../src/tools/deps.ts';
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
import { httpFetcher } from '../src/research/pages.ts';
import { SourceLibrary } from '../src/research/search.ts';
import { loadSources } from '../src/schemas/sources.ts';
import { validateDeck } from '../src/validators/deck-rules.ts';

const OUTPUT = 'output';
const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const noGuardrail = args.includes('--no-guardrail');
const scopeArg = args.find((a) => a.startsWith('--scope='))?.slice('--scope='.length);
const actArg = args.find((a) => a.startsWith('--act='))?.slice('--act='.length);
if (actArg && actArg !== 'research' && actArg !== 'deck') throw new Error(`--act debe ser research o deck (recibido: ${actArg})`);
const instructionArg = args.filter((a) => !a.startsWith('--')).join(' ').trim();

const cfg = loadConfig();
if (noGuardrail) cfg.guardrail.enabled = false;
const brief = loadBrief();
const m = activeModel(cfg);
const sources = loadSources();
const params = deckParams(cfg, brief, loadBrandGuide(), sources);
const library = new SourceLibrary(sources, httpFetcher(sources.limits.fetchTimeoutMs));

if (fresh) for (const f of ['deck.json', 'claims.json', 'script.md', 'timing.md']) rmSync(`${OUTPUT}/${f}`, { force: true });
const store = DeckStore.load(OUTPUT, brief.title);
// En ediciones el agente puede no llamar read_knowledge: precarga los fragmentos para verificar citas a los apuntes.
store.setKnowledge(loadKnowledgeFragments('knowledge'));
const hasDeck = store.deck.sections.length > 0;
// Edición puntual: hay deck y el usuario dio una instrucción. El alcance lo fija --scope o la primera sección tocada.
if (hasDeck && instructionArg) store.startEdit(scopeArg ? scopeArg.split(',') : []);
// Etapas: una edición es solo "deck"; sin deck, research + deck; --act fuerza una.
const stages: Stage[] = actArg ? [actArg as Stage] : hasDeck ? ['deck'] : ['research', 'deck'];
const stage: { current: Stage } = { current: stages[0]! };
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
  research: { sources, library },
  stage,
  sink,
  ...(cfg.guardrail.enabled ? { checker: createGuardrailChecker(cfg) } : {}),
  maxRevisionRounds: cfg.agent.maxRevisionRounds,
  structuredOutputRetries: cfg.agent.structuredOutputRetries,
  maxTurns: cfg.agent.maxTurns,
  maxToolCalls: cfg.agent.maxToolCalls,
});

const t0 = performance.now();
try {
  for (const s of stages) {
    stage.current = s;
    gate.reset();
    const tStage = performance.now();
    const message =
      instructionArg && hasDeck
        ? buildUserMessage(instruction, store.deck, { claims: store.claims }, true)
        : buildUserMessage(STAGE_INSTRUCTIONS[s], store.deck, { claims: store.claims }, s === 'deck');
    console.log(styleText(['bold', 'magenta'], `\n━━ ${s === 'research' ? 'ACTO 2 · huecos y research' : 'ACTO 3 · plan y validación'} ━━`));
    let result: AgentResult;
    try {
      result = await agent.invoke(message, invokeOptions);
    } catch (err) {
      // El resumen estructurado es cosmético: lo que importa es el estado (deck/claims), que valida la compuerta.
      if (!(err instanceof StructuredOutputError)) throw err;
      const passed = gate.lastResult?.ok === true;
      console.log(
        styleText('yellow', `⚠ El modelo no entregó el resumen estructurado.`),
        passed ? 'La validación de la etapa pasó: se continúa.' : 'Y la validación de la etapa no pasó: se detiene.',
      );
      if (!passed) {
        process.exitCode = 1;
        break;
      }
      continue;
    }
    console.log(styleText('dim', `━━ ${s}: ${((performance.now() - tStage) / 1000).toFixed(1)}s · ${result.stopReason}`));
    if (await reportStop(result)) break;
  }
} catch (err) {
  console.error(styleText('red', `\n✗ ${(err as Error).name}: ${(err as Error).message}`));
  process.exitCode = 1;
} finally {
  finish();
}

/** Reporta cómo terminó una etapa; devuelve true si hay que detener las siguientes. */
async function reportStop(result: AgentResult): Promise<boolean> {
  if (result.stopReason === 'cancelled' && abort.signal.reason instanceof Error) throw abort.signal.reason;
  if (result.stopReason === 'limitTurns') {
    console.log(styleText(['yellow', 'bold'], `\n⏹ Tope de ${cfg.agent.maxTurns} turnos alcanzado: el agente se detuvo.`));
  }
  if (result.stopReason === 'guardrailIntervened') {
    console.log(styleText(['red', 'bold'], `\n🛡 Bedrock Guardrails detuvo la ejecución: ${String(result)}`));
  }
  const summary = result.structuredOutput as RunSummary | undefined;
  if (summary) console.log(styleText('bold', 'Resumen del agente:'), summary.summary);
  if (gate.lastResult && !gate.lastResult.ok) {
    console.log(styleText(['red', 'bold'], `✗ La etapa "${stage.current}" no pasó su validación:`), gate.lastResult.problems.join(' · '));
    return true;
  }
  return result.stopReason === 'limitTurns' || result.stopReason === 'guardrailIntervened';
}

function finish(): void {
  store.save(OUTPUT, params);
  const ext = store.claims.filter((c) => c.origin === 'external');
  if (ext.length) {
    console.log(styleText('bold', '\nClaims externos:'));
    for (const c of ext) {
      console.log(
        `  ${c.verified ? styleText('green', '✓') : styleText('red', '✗')} ${c.id} [${c.sourceTier}] ${c.text}`,
        styleText('dim', c.verified ? '' : `(${!c.checks?.quoteFound ? 'cita no encontrada' : 'cifras no respaldadas'})`),
      );
    }
  }
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
