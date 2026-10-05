import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const BrandGuideSchema = z
  .object({
    colors: z.object({ background: Hex, primary: Hex, secondary: Hex }).catchall(Hex),
    usage: z.record(z.string(), z.string()).default({}),
    fonts: z.object({ heading: z.string(), body: z.string() }),
    sizes: z.record(z.string(), z.number()).default({}),
    layout: z.object({
      maxWordsPerSlide: z.number().int().positive().default(30),
      oneIdeaPerSlide: z.boolean().default(true),
    }),
    mood: z.string().default(''),
  })
  .loose();
export type BrandGuide = z.infer<typeof BrandGuideSchema>;

export function loadBrandGuide(path = 'config/brand-guide.yml'): BrandGuide {
  return BrandGuideSchema.parse(parse(readFileSync(path, 'utf8')));
}
