import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../src/agent/cost.ts';
import { activeModel, loadConfig, parseConfig } from '../src/schemas/config.ts';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';

const raw = () => parse(readFileSync('config/config.yml', 'utf8'));

describe('config.yml', () => {
  it('el config versionado es válido', () => {
    const cfg = loadConfig('config/config.yml', {});
    expect(activeModel(cfg).modelId).toMatch(/mistral/);
    expect(cfg.canva.tokenDir.startsWith('~')).toBe(false);
  });

  it('cambiar de modelo es una sola línea', () => {
    const r = raw();
    r.model.active = 'nova';
    expect(activeModel(parseConfig(r, {})).modelId).toMatch(/nova/);
  });

  it('AWS_PROFILE y AWS_REGION del entorno tienen prioridad', () => {
    const cfg = parseConfig(raw(), { AWS_PROFILE: 'otro', AWS_REGION: 'us-west-2' });
    expect(cfg.aws).toEqual({ profile: 'otro', region: 'us-west-2' });
  });

  it('rechaza un modelo activo inexistente y un guardrail habilitado sin id', () => {
    const r = raw();
    r.model.active = 'gpt';
    expect(() => parseConfig(r, {})).toThrow(/model.active/);
    const r2 = raw();
    r2.guardrail.enabled = true;
    r2.guardrail.id = '';
    expect(() => parseConfig(r2, {})).toThrow(/guardrail.id/);
  });

  it('costo: tokens cacheados se cobran aparte', () => {
    const usd = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 1_000_000, cacheWriteInputTokens: 0 },
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    );
    expect(usd).toBeCloseTo(2 + 1 + 0.2);
  });
});
