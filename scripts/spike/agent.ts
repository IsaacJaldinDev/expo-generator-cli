/**
 * Spike fase 0 — agente Strands + Bedrock + herramienta + structured output + hooks.
 *   npm run spike:agent                 # usa model.active de config.yml
 *   npm run spike:agent -- --guardrail  # además pasa save_hook por ApplyGuardrail
 */
import { styleText } from 'node:util';
import { emptyUsage, addUsage, estimateCostUsd } from '../../src/agent/cost.ts';
import type { TraceEvent } from '../../src/agent/events.ts';
import { createSpikeAgent, SPIKE_SYSTEM_PROMPT } from '../../src/agent/spike.ts';
import { consoleTrace } from '../../src/cli/console-trace.ts';
import { createGuardrailChecker } from '../../src/guardrails/apply.ts';
import { cachedSystemPrompt, createAgentModel } from '../../src/providers/bedrock.ts';
import { activeModel, loadConfig } from '../../src/schemas/config.ts';

const cfg = loadConfig();
const m = activeModel(cfg);
const useGuardrail = process.argv.includes('--guardrail');
let usage = emptyUsage();

const sink = (e: TraceEvent) => {
  if (e.kind === 'model-call' && e.usage) usage = addUsage(usage, e.usage);
  consoleTrace(e);
};

console.log(styleText('bold', `\nModelo: ${m.key} → ${m.modelId} (caché: ${m.promptCache})  ·  región ${cfg.aws.region}  ·  perfil ${cfg.aws.profile}\n`));

const { agent, abort, gate } = createSpikeAgent({
  model: createAgentModel(cfg),
  systemPrompt: cachedSystemPrompt(cfg, SPIKE_SYSTEM_PROMPT),
  sink,
  ...(useGuardrail ? { checker: createGuardrailChecker(cfg) } : {}),
  maxRevisionRounds: cfg.agent.maxRevisionRounds,
  structuredOutputRetries: cfg.agent.structuredOutputRetries,
});

const t0 = performance.now();
try {
  const result = await agent.invoke(
    'Escribe el hook (inicio) de una lightning talk de 5 minutos que explica qué es MCP a estudiantes universitarios.',
    { cancelSignal: abort.signal },
  );
  if (result.stopReason === 'cancelled' && abort.signal.reason instanceof Error) throw abort.signal.reason;

  console.log(styleText('bold', '\nSalida estructurada (validada con Zod):'));
  console.log(result.structuredOutput);
  if (gate.lastResult && !gate.lastResult.ok) {
    console.log(styleText('red', `\nNo pasó la validación tras ${gate.rounds} rondas:`), gate.lastResult.problems);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(styleText('red', `\n✗ ${(err as Error).name}: ${(err as Error).message}`));
  process.exitCode = 1;
} finally {
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const usd = estimateCostUsd(usage, m.pricing);
  console.log(
    styleText('bold', `\n${secs}s · tokens in ${usage.inputTokens} / out ${usage.outputTokens}`),
    `· cache read ${usage.cacheReadInputTokens} / write ${usage.cacheWriteInputTokens}`,
    styleText('bold', `· ~$${usd.toFixed(5)} USD`),
  );
}
