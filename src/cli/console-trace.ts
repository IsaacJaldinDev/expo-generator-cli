import { styleText } from 'node:util';
import type { TraceEvent } from '../agent/events.ts';

/** Vista de trazas mínima para consola (fase 0). La vista Ink de la fase 4 consume los mismos eventos. */
export function consoleTrace(e: TraceEvent): void {
  switch (e.kind) {
    case 'tool-start':
      console.log(styleText('cyan', `→ ${e.name}`), styleText('dim', describeInput(e.input)));
      break;
    case 'tool-end':
      console.log(
        e.ok ? styleText('green', `  ✓ ${e.name}`) : styleText('red', `  ✗ ${e.name}  ${e.note ?? ''}`),
        styleText('dim', `${e.ms} ms`),
      );
      break;
    case 'model-call':
      console.log(
        styleText('dim', `· modelo → ${e.stopReason}`),
        e.usage
          ? styleText('dim', `(in ${e.usage.inputTokens}, out ${e.usage.outputTokens}, cache r/w ${e.usage.cacheReadInputTokens}/${e.usage.cacheWriteInputTokens})`)
          : '',
      );
      break;
    case 'guardrail':
      for (const i of e.interventions) {
        console.log(
          styleText(['bgRed', 'white', 'bold'], ` 🛡  GUARDRAIL ${i.action} `),
          styleText(['red', 'bold'], `${i.policy} · ${i.detail}`),
          styleText('yellow', `en ${i.source === 'input' ? 'INPUT' : 'OUTPUT'}`),
          i.match ? styleText('dim', `«${i.match}»`) : '',
          styleText('dim', `[${e.via}]`),
        );
      }
      break;
    case 'validation':
      console.log(
        e.ok ? styleText(['green', 'bold'], `✓ validación (ronda ${e.round})`) : styleText(['red', 'bold'], `✗ validación (ronda ${e.round})`),
        e.problems.length ? `\n    ${e.problems.join('\n    ')}` : '',
      );
      break;
    case 'structured-output':
      console.log(
        e.ok ? styleText('green', `✓ salida estructurada (intento ${e.attempt})`) : styleText('red', `✗ salida estructurada (intento ${e.attempt})`),
        e.error ? styleText('dim', firstLine(e.error)) : '',
      );
      break;
    case 'info':
      console.log(styleText('dim', e.message));
      break;
    case 'stage-start':
      console.log(styleText(['bold', 'magenta'], `\n━━ ${e.title} ━━`));
      break;
    case 'stage-end':
      if (e.warning) console.log(styleText('yellow', `⚠ ${e.warning}`));
      if (e.summary) console.log(styleText('bold', 'Resumen del agente:'), e.summary);
      if (!e.ok) console.log(styleText(['red', 'bold'], `✗ La etapa "${e.stage}" no pasó:`), e.problems.join(' · '));
      console.log(styleText('dim', `━━ ${e.stage}: ${e.seconds.toFixed(1)}s · ${e.stopReason}`));
      break;
  }
}

/** Detalle legible de la entrada de cada herramienta (lo que se proyecta en la traza). */
export function describeInput(input: unknown): string {
  const o = input as Record<string, unknown> | undefined;
  if (o && typeof o.passageId === 'string' && typeof o.text === 'string') return `${o.passageId} → «${o.text}»`;
  if (o && typeof o.claim === 'string') return `«${o.claim}»`;
  if (o && Array.isArray(o.sectionIds)) return `[${o.sectionIds.join(', ')}]`;
  if (o && Object.keys(o).length === 0) return '';
  if (o && typeof o.sectionId === 'string') {
    const fields = Object.keys(o).filter((k) => k !== 'sectionId');
    const slides = Array.isArray(o.slides) ? ` (${o.slides.length} slides)` : '';
    return `[${o.sectionId}] ${fields.join(', ')}${slides}`;
  }
  return short(input);
}

const short = (v: unknown, max = 90): string => {
  const s = JSON.stringify(v) ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const firstLine = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 160);
