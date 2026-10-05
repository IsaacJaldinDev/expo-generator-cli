import { z } from 'zod';

/**
 * claims.json: registro de procedencia. Sin puntajes de confianza inventados.
 * - origin: author (sale de mis apuntes) | external (sale de una fuente)
 * - sourceTier: viene del mapeo fijo dominio → tier de config/sources.yml (fase 2)
 * - verified: lo calcula el código (el fragmento citado aparece en el contenido descargado), nunca el LLM
 */
export const ClaimSchema = z
  .object({
    /** "c-..." para claims externos; "<archivo>#<n>" para claims de autor (fragmento de knowledge/). */
    id: z.string().regex(/^[a-z0-9-]+(#\d+)?$/),
    text: z.string().min(1),
    origin: z.enum(['author', 'external']),
    /** Para origin=author: id del fragmento de knowledge/ (p. ej. "notes#3"). */
    knowledgeRef: z.string().optional(),
    sourceUrl: z.url().optional(),
    sourceTier: z.string().optional(),
    /** Fragmento textual citado de la fuente. */
    quote: z.string().optional(),
    verified: z.boolean(),
    /** Detalle de las comprobaciones en código que producen `verified` (claims externos). */
    checks: z
      .object({
        quoteFound: z.boolean(),
        numbersMatch: z.boolean(),
        /** Contextual grounding de Bedrock Guardrails: el pasaje respalda la afirmación (si el guardrail está activo). */
        grounded: z.boolean().optional(),
        groundingScore: z.number().optional(),
      })
      .optional(),
    retrievedAt: z.string().optional(),
  })
  .refine((c) => c.origin === 'author' || !!c.sourceUrl, {
    message: 'Un claim external necesita sourceUrl',
    path: ['sourceUrl'],
  });
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimsFileSchema = z.object({ claims: z.array(ClaimSchema) });
export type ClaimsFile = z.infer<typeof ClaimsFileSchema>;
