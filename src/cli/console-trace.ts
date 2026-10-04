import { styleText } from 'node:util';
import type { TraceEvent } from '../agent/events.ts';

/** Vista de trazas mínima para consola (fase 0). La vista Ink de la fase 4 consume los mismos eventos. */
export function consoleTrace(e: TraceEvent): void {
  switch (e.kind) {
    case 'tool-start':
      console.log(styleText('cyan', `→ ${e.name}`), styleText('dim', short(e.input)));
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
  }
}

const short = (v: unknown, max = 90): string => {
  const s = JSON.stringify(v) ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const firstLine = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 160);
