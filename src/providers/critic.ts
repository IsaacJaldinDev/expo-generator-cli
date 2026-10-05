import { Agent, type Model } from '@strands-agents/sdk';
import { z } from 'zod';
import type { UsageTotals } from '../agent/events.ts';

/**
 * Crítica de voz: una llamada LLM SEPARADA, sin el historial del agente, con rúbrica.
 * Cada problema debe citar textualmente la oración; el código descarta los que no lo hacen.
 */

export const CritiqueSchema = z.object({
  verdict: z.enum(['ok', 'revisar']),
  issues: z
    .array(
      z.object({
        slideId: z.string().describe('id de la slide, p. ej. "hook-1"'),
        sentence: z.string().min(1).describe('La oración problemática copiada EXACTAMENTE del script'),
        problem: z.string().min(1).describe('Por qué no suena al autor, en una oración'),
        suggestion: z.string().min(1).describe('Cómo la diría el autor'),
      }),
    )
    .max(8),
});
export type Critique = z.infer<typeof CritiqueSchema>;

export interface CritiqueRequest {
  sections: { id: string; slides: { id: string; script: string }[] }[];
}

export interface CriticModelProvider {
  readonly name: string;
  critique(req: CritiqueRequest): Promise<{ critique: Critique; usage?: UsageTotals }>;
}

/** Rúbrica fija: ejemplos reales del autor + anti-patrones. Es el system prompt del crítico. */
export function buildRubric(examplesMd: string, antiPatternsMd: string): string {
  return `Eres un editor que revisa si el script de una charla suena como su autor. No reescribes la charla: señalas oraciones concretas.

# Cómo habla el autor
${examplesMd.trim()}

# Lo que el autor evita
${antiPatternsMd.trim()}

# Rúbrica
Marca una oración solo si: usa una muletilla o un patrón de la lista anterior, suena a texto escrito o corporativo y no a alguien hablando, usa adjetivos donde el autor pondría un ejemplo concreto, o no se puede decir en una respiración.

# Reglas
- Cita cada oración EXACTAMENTE como aparece en el script (copia y pega), con el id de su slide.
- Máximo 8 problemas, los más importantes primero. Si el script ya suena al autor, verdict "ok" sin problemas.
- No opines sobre el contenido técnico ni sobre la estructura: solo sobre la voz.`;
}

const requestText = (req: CritiqueRequest): string =>
  req.sections
    .map((s) => `## Sección ${s.id}\n${s.slides.map((sl) => `[${sl.id}] ${sl.script}`).join('\n')}`)
    .join('\n\n');

export class BedrockCritic implements CriticModelProvider {
  readonly name = 'bedrock';

  constructor(
    private readonly model: Model,
    private readonly rubric: string,
  ) {}

  async critique(req: CritiqueRequest) {
    // Agente nuevo en cada llamada: sin historial del agente principal y sin herramientas.
    const critic = new Agent({ model: this.model, systemPrompt: this.rubric, printer: false, structuredOutputSchema: CritiqueSchema });
    const result = await critic.invoke(`Revisa la voz de este script:\n\n${requestText(req)}`);
    const u = result.metrics?.latestAgentInvocation?.usage;
    return {
      critique: CritiqueSchema.parse(result.structuredOutput),
      ...(u
        ? {
            usage: {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
              cacheWriteInputTokens: u.cacheWriteInputTokens ?? 0,
            },
          }
        : {}),
    };
  }
}

/** Puerta abierta (docs/ollama.md). Se implementa solo cuando el autor lo pida. */
export class OllamaCritic implements CriticModelProvider {
  readonly name = 'ollama';
  critique(): Promise<never> {
    return Promise.reject(
      new Error('critic.provider=ollama aún no está implementado. Usa critic.provider=bedrock (ver docs/ollama.md).'),
    );
  }
}

/** Crea el crítico según config: critic.provider y critic.model (vacío = modelo activo). */
export function createCritic(
  provider: 'bedrock' | 'ollama',
  modelFactory: () => Model,
  rubric: string,
): CriticModelProvider {
  return provider === 'ollama' ? new OllamaCritic() : new BedrockCritic(modelFactory(), rubric);
}
