import { z } from 'zod';

/**
 * deck.json es la fuente de verdad. script.md, timing.md y el input de Canva se renderizan desde aquí.
 *
 * Las afirmaciones del script se vinculan a claims.json con marcadores al estilo nota al pie:
 *   "MCP se publicó en noviembre de 2024[^c1]."
 */

export const SECTION_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Cualquier marcador [^…]: así un id que no es un claim (p. ej. "notes#3") se detecta y se rechaza. */
export const CLAIM_MARKER = /\[\^([^\]\s]+)\]/g;

export const SlideSchema = z.object({
  /** Lo asigna el DeckStore (`<seccion>-<n>`); el LLM no lo maneja. */
  id: z.string(),
  title: z.string().min(1),
  /** Qué hace esta slide por la charla, en una oración. */
  purpose: z.string(),
  /** Texto visible en la slide. */
  bullets: z.array(z.string()).default([]),
  /** Lo que dice el speaker. Puede contener marcadores [^claim-id]. */
  script: z.string(),
});
export type Slide = z.infer<typeof SlideSchema>;

export const SectionKind = z.enum(['hook', 'body', 'close']);

export const SectionSchema = z.object({
  id: z.string().regex(SECTION_ID),
  kind: SectionKind,
  title: z.string().min(1),
  goal: z.string(),
  /** Presupuesto de tiempo de la sección, en segundos. */
  targetSeconds: z.number().positive().optional(),
  slides: z.array(SlideSchema),
});
export type Section = z.infer<typeof SectionSchema>;

export const DeckSchema = z.object({
  title: z.string(),
  sections: z.array(SectionSchema),
});
export type Deck = z.infer<typeof DeckSchema>;

/**
 * Parche que el agente envía con update_section. Solo los campos presentes cambian;
 * si viene `slides`, reemplaza todas las slides de esa sección.
 */
export const SlideInputSchema = SlideSchema.omit({ id: true }).extend({
  purpose: z.string().min(1).describe('Qué hace esta slide por la charla, en una oración'),
  bullets: z.array(z.string()).describe('Texto visible en la slide (corto)'),
  script: z.string().min(1).describe('Lo que dice el speaker. Cita claims con [^id-del-claim]'),
});

export const SectionPatchSchema = z.object({
  sectionId: z.string().regex(SECTION_ID).describe('id en kebab-case, p. ej. "hook", "que-es-mcp", "cierre"'),
  kind: SectionKind.optional().describe('Obligatorio al crear una sección nueva'),
  title: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  targetSeconds: z.number().positive().optional(),
  /** Posición (0 = primera) al crear una sección nueva. Por defecto, al final. */
  position: z.number().int().min(0).optional(),
  slides: z.array(SlideInputSchema).min(1).optional(),
  remove: z.boolean().optional().describe('true para eliminar la sección'),
});
export type SectionPatch = z.infer<typeof SectionPatchSchema>;

export const emptyDeck = (title: string): Deck => ({ title, sections: [] });
