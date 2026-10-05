import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { validateDeck } from '../validators/deck-rules.ts';
import type { ToolDeps } from './deps.ts';

export function validateDeckTool(deps: ToolDeps) {
  return tool({
    name: 'validate_deck',
    description:
      'Valida el deck con reglas deterministas: hook primero, propósito por slide, palabras máximas por slide, ' +
      'claims citados existentes y verificados, datos externos con fuente y duración dentro del presupuesto. ' +
      'Llámalo antes de terminar; no puedes terminar si falla.',
    inputSchema: z.object({}),
    callback: () => validateDeck(deps.store.deck, deps.store.claims, deps.params),
  });
}
