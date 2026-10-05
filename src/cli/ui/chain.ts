import type { TraceEvent } from '../../agent/events.ts';

/** Herramientas cuyo ✓ se muestra: son las revisiones que el público tiene que ver pasar. */
const CHECKS = new Set(['check_timing', 'validate_deck', 'critique_voice']);

export interface ChainLink {
  name: string;
  count: number;
  /** undefined = sin marca; true = ✓; false = ✗ */
  ok?: boolean;
}

/**
 * Cadena compacta de la ejecución: herramientas consecutivas iguales con el mismo resultado se agrupan (×n).
 * Las fallas siempre se marcan con ✗; los éxitos solo en las herramientas de revisión.
 */
export function buildChain(events: TraceEvent[]): ChainLink[] {
  const links: ChainLink[] = [];
  for (const e of events) {
    if (e.kind === 'guardrail') {
      links.push({ name: '🛡 guardrail', count: 1, ok: false });
      continue;
    }
    if (e.kind !== 'tool-end') continue;
    const ok = !e.ok ? false : CHECKS.has(e.name) ? true : undefined;
    const last = links.at(-1);
    if (last && last.name === e.name && last.ok === ok) last.count++;
    else links.push({ name: e.name, count: 1, ...(ok !== undefined ? { ok } : {}) });
  }
  return links;
}

export function formatLink(l: ChainLink): string {
  return `${l.name}${l.count > 1 ? ` ×${l.count}` : ''}${l.ok === true ? ' ✓' : l.ok === false ? ' ✗' : ''}`;
}

export const formatChain = (links: ChainLink[]): string => links.map(formatLink).join(' → ');
