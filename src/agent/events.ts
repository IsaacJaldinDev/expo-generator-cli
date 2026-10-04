import type { GuardrailIntervention } from '../guardrails/trace.ts';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

/** Eventos que la vista de trazas renderiza. Es el contrato entre el agente y el CLI. */
export type TraceEvent =
  | { kind: 'tool-start'; id: string; name: string; input: unknown }
  | { kind: 'tool-end'; id: string; name: string; ok: boolean; ms: number; note?: string }
  | { kind: 'model-call'; stopReason: string; usage?: UsageTotals }
  | { kind: 'guardrail'; via: 'converse' | 'apply-guardrail'; interventions: GuardrailIntervention[] }
  | { kind: 'validation'; round: number; ok: boolean; problems: string[] }
  | { kind: 'structured-output'; ok: boolean; attempt: number; error?: string }
  | { kind: 'info'; message: string };

export type TraceSink = (e: TraceEvent) => void;
