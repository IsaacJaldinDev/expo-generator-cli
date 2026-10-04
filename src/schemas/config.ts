import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const PricingSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().default(0),
  cacheWrite: z.number().nonnegative().default(0),
});

const ModelOptionSchema = z.object({
  modelId: z.string().min(1),
  maxTokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(1).default(0.3),
  /** auto: el SDK cachea (solo Claude) · cachepoint: CachePointBlock manual tras el system prompt · none: el modelo no lo soporta */
  promptCache: z.enum(['auto', 'cachepoint', 'none']).default('none'),
  pricing: PricingSchema,
});

export const ConfigSchema = z
  .object({
    aws: z.object({
      profile: z.string().min(1),
      region: z.string().min(1),
    }),
    model: z.object({
      active: z.string().min(1),
      options: z.record(z.string(), ModelOptionSchema),
    }),
    guardrail: z.object({
      enabled: z.boolean().default(false),
      id: z.string().default(''),
      version: z.string().default('DRAFT'),
      trace: z.enum(['enabled', 'enabled_full', 'disabled']).default('enabled'),
      pricing: z.record(z.string(), z.number().nonnegative()).default({}),
    }),
    critic: z.object({
      provider: z.enum(['bedrock', 'ollama']).default('bedrock'),
    }),
    timing: z.object({
      wordsPerMinute: z.number().positive().default(135),
    }),
    agent: z.object({
      maxRevisionRounds: z.number().int().min(0).max(5).default(2),
      structuredOutputRetries: z.number().int().min(0).max(3).default(1),
    }),
    canva: z.object({
      mcpUrl: z.url(),
      redirectPort: z.number().int().min(1024).max(65535),
      tokenDir: z.string().min(1),
      timeoutMs: z.number().int().positive().default(60000),
      fallbackDeckUrl: z.string().default(''),
    }),
  })
  .superRefine((cfg, ctx) => {
    if (!(cfg.model.active in cfg.model.options)) {
      ctx.addIssue({
        code: 'custom',
        path: ['model', 'active'],
        message: `model.active="${cfg.model.active}" no existe en model.options (${Object.keys(cfg.model.options).join(', ')})`,
      });
    }
    if (cfg.guardrail.enabled && !cfg.guardrail.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['guardrail', 'id'],
        message: 'guardrail.enabled=true requiere guardrail.id',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ModelOption = z.infer<typeof ModelOptionSchema>;

const expandHome = (p: string): string => (p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p);

/** Parsea un objeto ya leído del YAML y aplica overrides de entorno (AWS_PROFILE, AWS_REGION). */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = ConfigSchema.parse(raw);
  if (env.AWS_PROFILE) cfg.aws.profile = env.AWS_PROFILE;
  if (env.AWS_REGION) cfg.aws.region = env.AWS_REGION;
  cfg.canva.tokenDir = expandHome(cfg.canva.tokenDir);
  return cfg;
}

export function loadConfig(path = 'config/config.yml', env: NodeJS.ProcessEnv = process.env): Config {
  return parseConfig(parse(readFileSync(path, 'utf8')), env);
}

export function activeModel(cfg: Config): ModelOption & { key: string } {
  // superRefine garantiza que existe
  return { key: cfg.model.active, ...cfg.model.options[cfg.model.active]! };
}
