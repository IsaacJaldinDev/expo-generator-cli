import type { TraceEvent } from '../../agent/events.ts';
import type { GuardrailIntervention } from '../../guardrails/trace.ts';
import { describeInput } from '../console-trace.ts';

/** Filas de la vista de trazas. Se derivan de los eventos con un reductor puro (fácil de testear y de reproducir). */
export type Row =
  | { kind: 'tool'; key: string; name: string; detail: string; status: 'running' | 'ok' | 'fail'; ms?: number; note?: string }
  | { kind: 'guardrail'; key: string; via: string; intervention: GuardrailIntervention }
  | { kind: 'stage'; key: string; title: string }
  | { kind: 'gate'; key: string; ok: boolean; round: number; problems: string[] }
  | { kind: 'note'; key: string; tone: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'stage-end'; key: string; stage: string; ok: boolean; seconds: number; summary?: string };

export function reduceRows(rows: Row[], e: TraceEvent): Row[] {
  const key = String(rows.length);
  switch (e.kind) {
    case 'tool-start':
      return [...rows, { kind: 'tool', key: e.id, name: e.name, detail: describeInput(e.input), status: 'running' }];
    case 'tool-end':
      return rows.map((r) =>
        r.kind === 'tool' && r.key === e.id
          ? { ...r, status: e.ok ? 'ok' : 'fail', ms: e.ms, ...(e.note ? { note: e.note } : {}) }
          : r,
      );
    case 'guardrail':
      return [...rows, ...e.interventions.map((intervention, i) => ({ kind: 'guardrail' as const, key: `${key}-${i}`, via: e.via, intervention }))];
    case 'stage-start':
      return [...rows, { kind: 'stage', key, title: e.title }];
    case 'validation':
      return [...rows, { kind: 'gate', key, ok: e.ok, round: e.round, problems: e.problems }];
    case 'structured-output':
      return e.ok ? rows : [...rows, { kind: 'note', key, tone: 'warn', text: `Salida estructurada inválida (intento ${e.attempt})` }];
    case 'info':
      return [...rows, { kind: 'note', key, tone: 'warn', text: e.message }];
    case 'stage-end':
      return [
        ...rows,
        ...(e.warning ? [{ kind: 'note' as const, key: `${key}-w`, tone: 'warn' as const, text: e.warning }] : []),
        { kind: 'stage-end', key, stage: e.stage, ok: e.ok, seconds: e.seconds, ...(e.summary ? { summary: e.summary } : {}) },
      ];
    default:
      return rows;
  }
}
