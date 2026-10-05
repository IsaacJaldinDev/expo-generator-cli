import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const SeedSchema = z.object({ url: z.url(), note: z.string().default('') });
export type Seed = z.infer<typeof SeedSchema>;

const LimitsSchema = z
  .object({
    maxResearchCalls: z.number().int().positive().default(12),
    minExternalClaims: z.number().int().min(0).default(3),
    maxExternalClaims: z.number().int().positive().default(5),
    fetchTimeoutMs: z.number().int().positive().default(15000),
    minQuoteChars: z.number().int().positive().default(20),
  })
  .default({ maxResearchCalls: 12, minExternalClaims: 3, maxExternalClaims: 5, fetchTimeoutMs: 15000, minQuoteChars: 20 });

const SearchSchema = z.object({ provider: z.enum(['seeds']).default('seeds') }).default({ provider: 'seeds' });

/** Tier de las fuentes que el autor agrega en su input: procedencia honesta, no se hace pasar por oficial. */
export const USER_TIER = 'aportada';

/** Fuentes resueltas para una exposición: lo que usan SourceLibrary, research y record_claim. */
export const SourcesSchema = z
  .object({
    /** Temas de config/sources.yml que aportaron dominios y semillas. */
    topics: z.array(z.string()).default([]),
    tiers: z.record(z.string(), z.array(z.string().min(1))),
    seeds: z.array(SeedSchema),
    search: SearchSchema,
    limits: LimitsSchema,
  })
  .superRefine((s, ctx) => {
    for (const [i, seed] of s.seeds.entries()) {
      if (!tierFor(s, seed.url)) {
        ctx.addIssue({ code: 'custom', path: ['seeds', i, 'url'], message: `${seed.url} está fuera de la allowlist de tiers` });
      }
    }
  });
export type Sources = z.infer<typeof SourcesSchema>;

const TopicSchema = z.object({
  label: z.string().min(1),
  domains: z.record(z.string(), z.array(z.string().min(1))),
  seeds: z.array(SeedSchema).min(1),
});

/** config/sources.yml: catálogo de fuentes de verdad por tema. */
export const SourceCatalogSchema = z
  .object({
    topics: z.record(z.string().regex(/^[a-z0-9-]+$/), TopicSchema),
    search: SearchSchema,
    limits: LimitsSchema,
  })
  .superRefine((c, ctx) => {
    const tierOf = new Map<string, { tier: string; topic: string }>();
    for (const [topic, t] of Object.entries(c.topics)) {
      if (USER_TIER in t.domains) ctx.addIssue({ code: 'custom', path: ['topics', topic, 'domains', USER_TIER], message: `"${USER_TIER}" es automático` });
      for (const [tier, domains] of Object.entries(t.domains)) {
        for (const d of domains) {
          const prev = tierOf.get(d);
          if (prev && prev.tier !== tier) {
            ctx.addIssue({ code: 'custom', path: ['topics', topic, 'domains', tier], message: `${d} es ${prev.tier} en ${prev.topic}: un dominio tiene un solo tier` });
          }
          tierOf.set(d, { tier, topic });
        }
      }
      for (const [i, seed] of t.seeds.entries()) {
        if (!tierFor({ tiers: t.domains }, seed.url)) {
          ctx.addIssue({ code: 'custom', path: ['topics', topic, 'seeds', i, 'url'], message: `${seed.url} está fuera de los dominios del tema ${topic}` });
        }
      }
    }
  });
export type SourceCatalog = z.infer<typeof SourceCatalogSchema>;

/** Tier del dominio de la URL según el mapeo fijo; undefined = fuera de la allowlist. */
export function tierFor(sources: Pick<Sources, 'tiers'>, url: string): string | undefined {
  const host = httpsHost(url);
  if (!host) return undefined;
  for (const [tier, domains] of Object.entries(sources.tiers)) {
    if (domains.some((d) => host === d.toLowerCase())) return tier;
  }
  return undefined;
}

function httpsHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Catálogo + temas elegidos + fuentes del autor → fuentes de la exposición.
 * Sin temas se usan todos. Las fuentes del autor entran como semillas y su dominio entra a la allowlist: con el
 * tier que ya tenga en el catálogo, o como "aportada".
 */
export function resolveSources(catalog: SourceCatalog, topics?: string[], userSources: Seed[] = []): Sources {
  const keys = topics?.length ? topics : Object.keys(catalog.topics);
  const unknown = keys.filter((k) => !(k in catalog.topics));
  if (unknown.length) throw new Error(`Tema desconocido: ${unknown.join(', ')}. Temas de config/sources.yml: ${Object.keys(catalog.topics).join(', ')}.`);

  const tiers: Record<string, string[]> = {};
  const add = (tier: string, d: string) => {
    if (!Object.values(tiers).some((list) => list.includes(d))) (tiers[tier] ??= []).push(d);
  };
  for (const k of keys) for (const [tier, domains] of Object.entries(catalog.topics[k]!.domains)) for (const d of domains) add(tier, d);

  for (const s of userSources) {
    const host = httpsHost(s.url);
    if (!host) throw new Error(`Fuente aportada inválida (solo https): ${s.url}`);
    // Un dominio del catálogo conserva su tier aunque su tema no esté elegido.
    const known = Object.values(catalog.topics)
      .flatMap((t) => Object.entries(t.domains))
      .find(([, domains]) => domains.includes(host))?.[0];
    add(known ?? USER_TIER, host);
  }

  const seen = new Set<string>();
  const seeds = [...keys.flatMap((k) => catalog.topics[k]!.seeds), ...userSources].filter((s) => !seen.has(s.url) && seen.add(s.url));
  return SourcesSchema.parse({ topics: keys, tiers, seeds, search: catalog.search, limits: catalog.limits });
}

export function loadSourceCatalog(path = 'config/sources.yml'): SourceCatalog {
  return SourceCatalogSchema.parse(parse(readFileSync(path, 'utf8')));
}

/** Todas las fuentes del catálogo (todos los temas). */
export function loadSources(path = 'config/sources.yml'): Sources {
  return resolveSources(loadSourceCatalog(path));
}
