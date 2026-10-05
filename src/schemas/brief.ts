import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const BriefSchema = z.object({
  title: z.string().min(1),
  topic: z.string().min(1),
  audience: z.string().min(1),
  durationMinutes: z.number().positive(),
  objective: z.string().min(1),
  language: z.string().default('es'),
  /** Ideas que deben aparecer sí o sí. */
  mustInclude: z.array(z.string()).default([]),
  callToAction: z.string().optional(),
});
export type Brief = z.infer<typeof BriefSchema>;

export function loadBrief(path = 'brief/brief.yml'): Brief {
  return BriefSchema.parse(parse(readFileSync(path, 'utf8')));
}
