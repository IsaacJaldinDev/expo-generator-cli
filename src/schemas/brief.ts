import { z } from 'zod';

/** Brief de la exposición. Mínimo: título y duración; el resto la enriquece (y el agente usa lo que haya). */
export const BriefSchema = z.object({
  title: z.string().min(1),
  durationMinutes: z.number().positive(),
  topic: z.string().min(1).optional(),
  audience: z.string().min(1).optional(),
  objective: z.string().min(1).optional(),
  language: z.string().default('es'),
  /** Ideas que deben aparecer sí o sí. */
  mustInclude: z.array(z.string()).default([]),
  callToAction: z.string().optional(),
});
export type Brief = z.infer<typeof BriefSchema>;
