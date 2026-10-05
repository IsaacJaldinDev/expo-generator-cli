import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';
import type { GroundingRequest, GroundingResult, GuardrailCheckResult, GuardrailChecker } from '../guardrails/apply.ts';
import type { PageFetcher } from '../research/pages.ts';

/**
 * Cassette: todas las llamadas externas de una ejecución (modelo, guardrail, fuentes), en orden.
 * --record las graba; --replay las reproduce sin red, con el mismo streaming.
 */
export interface Cassette {
  version: 1;
  name: string;
  recordedAt: string;
  /** `ms[i]`: duración real de la llamada i, para reproducir con el mismo ritmo. */
  model: { calls: ModelStreamEvent[][]; ms?: number[] };
  /** `ms`: latencia real, para reproducir con el mismo ritmo. */
  guardrail: { key: string; op: 'check' | 'ground'; ms?: number; result: GuardrailCheckResult | GroundingResult }[];
  pages: { url: string; body: string }[];
  /** Llamadas al MCP de Canva, en orden, con su latencia real. */
  mcp?: { name: string; result: unknown; ms: number }[];
}

export const emptyCassette = (name: string): Cassette => ({
  version: 1,
  name,
  recordedAt: new Date().toISOString(),
  model: { calls: [] },
  guardrail: [],
  pages: [],
});

export function loadCassette(path: string): Cassette {
  if (!existsSync(path)) throw new Error(`No hay cassette en ${path}: grábalo primero con --record.`);
  return JSON.parse(readFileSync(path, 'utf8')) as Cassette;
}

export function saveCassette(path: string, c: Cassette): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...c, recordedAt: new Date().toISOString() }, null, 1) + '\n');
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Los eventos del SDK son clases: se guardan como datos planos. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Envuelve un modelo real y graba los eventos de cada llamada. */
export class RecordingModel extends Model<BaseModelConfig> {
  constructor(
    private readonly inner: Model,
    private readonly cassette: Cassette,
  ) {
    super();
  }
  updateConfig(c: BaseModelConfig): void {
    this.inner.updateConfig(c);
  }
  getConfig(): BaseModelConfig {
    return this.inner.getConfig();
  }
  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const call: ModelStreamEvent[] = [];
    const t = performance.now();
    this.cassette.model.calls.push(call);
    const ms = (this.cassette.model.ms ??= []);
    const i = ms.push(0) - 1;
    for await (const e of this.inner.stream(messages, options)) {
      call.push(plain(e));
      yield e;
    }
    ms[i] = Math.round(performance.now() - t);
  }
}

/**
 * Reproduce las llamadas grabadas, en orden. El ritmo: la duración real grabada (÷ speed) repartida entre los
 * eventos, o `delayMs` por evento si no hay duración grabada.
 */
export class ReplayModel extends Model<BaseModelConfig> {
  private next = 0;
  private config: BaseModelConfig;

  constructor(
    private readonly cassette: Cassette,
    private readonly delayMs = 0,
    private readonly speed = 1,
    modelId = 'replay',
  ) {
    super();
    this.config = { modelId };
  }
  updateConfig(c: BaseModelConfig): void {
    this.config = { ...this.config, ...c };
  }
  getConfig(): BaseModelConfig {
    return this.config;
  }
  async *stream(): AsyncIterable<ModelStreamEvent> {
    const i = this.next++;
    const call = this.cassette.model.calls[i];
    if (!call) throw new Error(`Cassette "${this.cassette.name}": no hay más llamadas al modelo grabadas (#${this.next}). Vuelve a grabarlo.`);
    const total = this.cassette.model.ms?.[i];
    const perEvent = this.speed > 0 && total ? total / this.speed / Math.max(1, call.length) : this.delayMs;
    for (const e of call) {
      if (perEvent) await sleep(perEvent);
      yield e;
    }
  }
}

export function recordingChecker(inner: GuardrailChecker, cassette: Cassette): GuardrailChecker {
  return {
    async check(text, source, opts) {
      const t = performance.now();
      const result = await inner.check(text, source, opts);
      cassette.guardrail.push({ key: hash(['check', text, source, opts ?? {}]), op: 'check', ms: Math.round(performance.now() - t), result });
      return result;
    },
    async ground(req: GroundingRequest) {
      const t = performance.now();
      const result = await inner.ground(req);
      cassette.guardrail.push({ key: hash(['ground', req]), op: 'ground', ms: Math.round(performance.now() - t), result });
      return result;
    },
  };
}

/** `speed`: 1 = latencia real grabada, 2 = el doble de rápido, 0 = instantáneo. */
export function replayChecker(cassette: Cassette, speed = 1): GuardrailChecker {
  const find = async (key: string, what: string) => {
    const hit = cassette.guardrail.find((g) => g.key === key);
    if (!hit) throw new Error(`Cassette "${cassette.name}": no hay respuesta de guardrail grabada para ${what}. Vuelve a grabarlo.`);
    if (speed > 0 && hit.ms) await sleep(hit.ms / speed);
    return hit.result;
  };
  return {
    check: async (text, source, opts) => (await find(hash(['check', text, source, opts ?? {}]), 'check')) as GuardrailCheckResult,
    ground: async (req) => (await find(hash(['ground', req]), 'ground')) as GroundingResult,
  };
}

export function recordingFetcher(inner: PageFetcher, cassette: Cassette): PageFetcher {
  return async (url) => {
    const body = await inner(url);
    if (!cassette.pages.some((p) => p.url === url)) cassette.pages.push({ url, body });
    return body;
  };
}

export function replayFetcher(cassette: Cassette): PageFetcher {
  return async (url) => {
    const page = cassette.pages.find((p) => p.url === url);
    if (!page) throw new Error(`Cassette "${cassette.name}": la página ${url} no está grabada.`);
    return page.body;
  };
}
