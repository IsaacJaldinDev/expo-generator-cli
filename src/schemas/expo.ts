import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BrandGuideSchema, loadBrandGuide, type BrandGuide } from './brand.ts';
import { BriefSchema, type Brief } from './brief.ts';
import { loadSourceCatalog, resolveSources, type Sources } from './sources.ts';

/** Nombre de una exposición: es nombre de archivo, de carpeta y título del diseño en Canva. */
export const ExpoName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'solo letras, números, "-" y "_" (p. ej. expo-de-s3)');

const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const Source = z.union([z.url(), z.object({ url: z.url(), note: z.string().default('') })]);

/**
 * input/<nombre>.json. Lo mínimo para generar una charla es title + durationMinutes; el resto la enriquece.
 * - `brand` sobreescribe campo a campo config/brand-guide.yml.
 * - `topics` elige los temas de config/sources.yml (sin `topics`: todos).
 * - `sources` agrega fuentes de verdad del autor (tier "aportada" si su dominio no está en el catálogo).
 */
export const ExpoInputSchema = BriefSchema.extend({
  brand: z
    .object({
      colors: z.object({ background: Hex, primary: Hex, secondary: Hex }).partial().optional(),
      fonts: z.object({ heading: z.string().min(1), body: z.string().min(1) }).partial().optional(),
      mood: z.string().optional(),
      layout: z.object({ maxWordsPerSlide: z.number().int().positive() }).partial().optional(),
    })
    .strict()
    .optional(),
  topics: z.array(z.string().min(1)).min(1).optional(),
  sources: z.array(Source).min(1).optional(),
}).strict();
export type ExpoInput = z.infer<typeof ExpoInputSchema>;

export interface Expo {
  name: string;
  inputPath: string;
  brief: Brief;
  brand: BrandGuide;
  brandOverridden: boolean;
  /** Fuentes resueltas: temas elegidos + fuentes aportadas. */
  sources: Sources;
  /** Cuántas semillas aportó el autor en su input. */
  userSources: number;
  /** knowledge/<nombre>/ si existe; si no, el agente trabaja sin apuntes locales. */
  knowledgeDir?: string;
  outputDir: string;
}

export interface ExpoPaths {
  inputDir: string;
  knowledgeDir: string;
  outputDir: string;
  brandGuide: string;
  sources: string;
}

export const DEFAULT_PATHS: ExpoPaths = {
  inputDir: 'input',
  knowledgeDir: 'knowledge',
  outputDir: 'output',
  brandGuide: 'config/brand-guide.yml',
  sources: 'config/sources.yml',
};

/** input/<nombre>.json → brief, guía visual (default + override), fuentes y carpetas de la exposición. */
export function resolveExpo(name: string, paths: ExpoPaths = DEFAULT_PATHS): Expo {
  const parsedName = ExpoName.safeParse(name);
  if (!parsedName.success) throw new Error(`Nombre de exposición inválido "${name}": ${parsedName.error.issues[0]!.message}`);
  const inputPath = join(paths.inputDir, `${name}.json`);
  if (!existsSync(inputPath)) throw new Error(`No existe ${inputPath}. Crea el archivo (mira input/ejemplo.json) o elige otra exposición con --expo=<nombre>.`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (err) {
    throw new Error(`${inputPath} no es JSON válido: ${(err as Error).message}`);
  }
  const parsed = ExpoInputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  · ${i.path.join('.') || '(raíz)'}: ${i.message}`).join('\n');
    throw new Error(`${inputPath} no es válido:\n${issues}`);
  }
  const { brand: brandOverride, topics, sources: userSources, ...brief } = parsed.data;

  const base = loadBrandGuide(paths.brandGuide);
  const brand = brandOverride
    ? BrandGuideSchema.parse({
        ...base,
        colors: { ...base.colors, ...brandOverride.colors },
        fonts: { ...base.fonts, ...brandOverride.fonts },
        layout: { ...base.layout, ...brandOverride.layout },
        ...(brandOverride.mood !== undefined ? { mood: brandOverride.mood } : {}),
      })
    : base;

  const own = (userSources ?? []).map((s) => (typeof s === 'string' ? { url: s, note: '' } : s));
  const catalog = loadSourceCatalog(paths.sources);
  let sources: Sources;
  try {
    sources = resolveSources(catalog, topics, own);
  } catch (err) {
    throw new Error(`${inputPath}: ${(err as Error).message}`);
  }

  const knowledgeDir = join(paths.knowledgeDir, name);
  return {
    name,
    inputPath,
    brief,
    brand,
    brandOverridden: Boolean(brandOverride),
    sources,
    userSources: own.length,
    ...(existsSync(knowledgeDir) ? { knowledgeDir } : {}),
    outputDir: join(paths.outputDir, name),
  };
}
