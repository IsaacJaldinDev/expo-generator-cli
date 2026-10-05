import type { Deck } from '../schemas/deck.ts';
import { checkTiming, fmt, type TimingParams } from '../validators/timing.ts';

/** deck.json → timing.md (tabla de tiempos calculada en código). */
export function renderTiming(deck: Deck, p: TimingParams): string {
  const r = checkTiming(deck, p);
  const rows = r.sections.map((s) => {
    const sec = deck.sections.find((x) => x.id === s.id)!;
    const target = s.targetSeconds !== undefined ? fmt(s.targetSeconds) : '—';
    const delta = s.overBySeconds ? `+${s.overBySeconds} s` : '';
    return `| ${s.id} | ${sec.slides.length} | ${s.words} | ${fmt(s.seconds)} | ${target} | ${delta} |`;
  });
  const status = r.ok
    ? '✓ dentro del presupuesto'
    : r.deltaSeconds > 0
      ? `✗ sobran ${r.deltaSeconds} s`
      : `✗ faltan ${-r.deltaSeconds} s`;
  return [
    '# Tiempos',
    '',
    `> Generado desde \`deck.json\`. ${r.wordsPerMinute} palabras/min.`,
    '',
    '| Sección | Slides | Palabras | Duración | Objetivo | Exceso |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows,
    `| **Total** | ${deck.sections.reduce((n, s) => n + s.slides.length, 0)} | ${r.totalWords} | **${fmt(r.totalSeconds)}** | ${fmt(r.budgetSeconds)} | ${status} |`,
    '',
  ].join('\n');
}
