import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Revisión de los apuntes del autor contra las fuentes de verdad (acto 2).
 * - confirmado:    un pasaje de una fuente permitida lo respalda (verificado en código: cita, cifras y grounding).
 * - inconsistente: la fuente que trata ese punto no lo respalda o dice otra cosa. Lo decide el código
 *                  (cifras o grounding) o lo señala el modelo; `decidedBy` lo deja explícito para que el autor sepa a quién creerle.
 * - sin-verificar: ninguna fuente lo confirma ni lo contradice. No se reporta ni detiene nada: el apunte sigue siendo del autor
 *                  (el script no puede usar sus cifras: eso sigue exigiendo un claim externo verificado).
 */
export const NoteVerdict = z.enum(['confirmado', 'inconsistente', 'sin-verificar']);
export type NoteVerdict = z.infer<typeof NoteVerdict>;

export const NoteReviewSchema = z.object({
  fragmentId: z.string(),
  /** Texto del fragmento al momento de revisarlo. */
  text: z.string(),
  verdict: NoteVerdict,
  decidedBy: z.enum(['codigo', 'modelo']),
  /** Por qué: cifras que no coinciden, puntaje de grounding o la explicación del modelo. */
  reasons: z.array(z.string()).default([]),
  sourceUrl: z.url().optional(),
  sourceTier: z.string().optional(),
  /** Pasaje textual de la fuente, para que el autor compare. */
  passage: z.string().optional(),
  groundingScore: z.number().optional(),
  /** Claim externo registrado a partir de un apunte confirmado: el deck lo puede citar con cifras. */
  claimId: z.string().optional(),
});
export type NoteReview = z.infer<typeof NoteReviewSchema>;

export const NotesReviewFileSchema = z.object({
  /** Huella de los apuntes revisados: si cambian, la revisión ya no vale y hay que repetir el acto 2. */
  knowledgeHash: z.string(),
  reviewedAt: z.string(),
  reviews: z.array(NoteReviewSchema),
  /** Fragmentos que el modelo marcó como propios del autor (ideas, experiencias, opiniones): no requieren fuente. */
  own: z.array(z.string()).default([]),
  /** Fragmentos sin revisar ni marcar como propios (la ejecución se cortó): la revisión no vale. */
  pending: z.array(z.string()).default([]),
});
export type NotesReviewFile = z.infer<typeof NotesReviewFileSchema>;

export function knowledgeHash(fragments: { id: string; text: string }[]): string {
  return createHash('sha256')
    .update(fragments.map((f) => `${f.id}\u0000${f.text}`).join('\u0001'))
    .digest('hex')
    .slice(0, 16);
}
