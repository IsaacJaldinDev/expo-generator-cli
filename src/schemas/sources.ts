import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const SourcesSchema = z
  .object({
    tiers: z.record(z.string(), z.array(z.string().min(1))),
    seeds: z.array(z.object({ url: z.url(), note: z.string().default('') })),
    search: z.object({ provider: z.enum(['seeds']).default('seeds') }).default({ provider: 'seeds' }),
    limits: z
      .object({
        maxResearchCalls: z.number().int().positive().default(8),
        minExternalClaims: z.number().int().min(0).default(3),
        maxExternalClaims: z.number().int().positive().default(5),
        fetchTimeoutMs: z.number().int().positive().default(15000),
        minQuoteChars: z.number().int().positive().default(20),
      })
      .default({ maxResearchCalls: 8, minExternalClaims: 3, maxExternalClaims: 5, fetchTimeoutMs: 15000, minQuoteChars: 20 }),
  })
  .superRefine((s, ctx) => {
    for (const [i, seed] of s.seeds.entries()) {
      if (!tierFor(s, seed.url)) {
        ctx.addIssue({ code: 'custom', path: ['seeds', i, 'url'], message: `${seed.url} está fuera de la allowlist de tiers` });
      }
    }
  });
export type Sources = z.infer<typeof SourcesSchema>;

/** Tier del dominio de la URL según el mapeo fijo; undefined = fuera de la allowlist. */
export function tierFor(sources: Pick<Sources, 'tiers'>, url: string): string | undefined {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return undefined;
    host = u.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [tier, domains] of Object.entries(sources.tiers)) {
    if (domains.some((d) => host === d.toLowerCase())) return tier;
  }
  return undefined;
}

export function loadSources(path = 'config/sources.yml'): Sources {
  return SourcesSchema.parse(parse(readFileSync(path, 'utf8')));
}
