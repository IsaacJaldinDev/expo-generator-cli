import type { ModelOption } from '../schemas/config.ts';
import type { UsageTotals } from './events.ts';

export const emptyUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
  };
}

/** Costo estimado en USD. Bedrock reporta inputTokens SIN los tokens cacheados, así que se suman aparte. */
export function estimateCostUsd(usage: UsageTotals, pricing: ModelOption['pricing']): number {
  const perToken = (pricePerMillion: number) => pricePerMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(pricing.input) +
    usage.outputTokens * perToken(pricing.output) +
    usage.cacheReadInputTokens * perToken(pricing.cacheRead) +
    usage.cacheWriteInputTokens * perToken(pricing.cacheWrite)
  );
}
