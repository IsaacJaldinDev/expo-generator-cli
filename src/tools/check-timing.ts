import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { checkTiming } from '../validators/timing.ts';
import type { ToolDeps } from './deps.ts';

export function checkTimingTool(deps: ToolDeps) {
  return tool({
    name: 'check_timing',
    description:
      'Calcula en código la duración de cada sección y del total (palabras del script ÷ palabras por minuto) ' +
      'y reporta excesos o faltantes en segundos.',
    inputSchema: z.object({}),
    callback: () => checkTiming(deps.store.deck, deps.params, deps.store.editScope),
  });
}
