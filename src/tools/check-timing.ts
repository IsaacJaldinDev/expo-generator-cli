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
    callback: () => {
      const r = checkTiming(deps.store.deck, deps.params, deps.store.editScope);
      // El siguiente paso lo decide el código: con el tiempo en rango no hay nada más que ajustar.
      return { ...r, next: r.ok ? 'El tiempo está en rango: NO edites más secciones; llama a validate_deck.' : 'Aplica la sugerencia y vuelve a check_timing.' };
    },
  });
}
