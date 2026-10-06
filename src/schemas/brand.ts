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

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** Razón de contraste WCAG entre dos colores hex (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Avisos de legibilidad de la paleta (WCAG): los títulos (texto grande) piden 3:1 contra el fondo y el texto
 * corrido 4.5:1. Canva recibe los hex tal cual; una paleta ilegible se ve mal por más que se respete.
 */
export function contrastWarnings(brand: Pick<BrandGuide, 'colors'>): string[] {
  const { background, primary, secondary } = brand.colors;
  const out: string[] = [];
  const title = contrastRatio(primary, background);
  const body = contrastRatio(secondary, background);
  if (title < 3) out.push(`Títulos (${primary}) sobre el fondo (${background}): contraste ${title.toFixed(2)}:1, se recomienda al menos 3:1.`);
  if (body < 4.5) out.push(`Texto (${secondary}) sobre el fondo (${background}): contraste ${body.toFixed(2)}:1, se recomienda al menos 4.5:1.`);
  return out;
}
