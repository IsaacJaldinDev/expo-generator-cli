import type { McpClient } from '@strands-agents/sdk';
import type { TraceSink } from '../agent/events.ts';
import type { CanvaDesignInput } from '../render/canva.ts';
import type { Cassette } from '../replay/cassette.ts';

/** Llama una herramienta del MCP de Canva y devuelve su resultado estructurado (JSON). */
export type CanvaCaller = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Resultado de MCP → objeto: structuredContent, o el JSON del primer bloque de texto. isError → excepción legible. */
export function parseToolResult(raw: unknown): Record<string, unknown> {
  const r = raw as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };
  const text = r?.content?.find((c) => c.type === 'text')?.text;
  if (r?.isError) throw new Error(`Canva respondió con error: ${text ?? 'sin detalle'}`);
  if (r?.structuredContent) return r.structuredContent;
  try {
    return JSON.parse(text ?? '{}') as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

export function mcpCaller(client: McpClient): CanvaCaller {
  let tools: Awaited<ReturnType<McpClient['listTools']>> | undefined;
  return async (name, args) => {
    tools ??= await client.listTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`El MCP de Canva no expone la herramienta "${name}".`);
    return parseToolResult(await client.callTool(tool, args as never));
  };
}

/** Graba cada llamada (y su latencia) en el cassette. */
export function recordingCaller(inner: CanvaCaller, cassette: Cassette): CanvaCaller {
  return async (name, args) => {
    const t = performance.now();
    const result = await inner(name, args);
    (cassette.mcp ??= []).push({ name, result, ms: Math.round(performance.now() - t) });
    return result;
  };
}

/** Reproduce las llamadas grabadas en orden. */
export function replayCaller(cassette: Cassette): CanvaCaller {
  let i = 0;
  return async (name) => {
    const hit = cassette.mcp?.[i++];
    if (!hit || hit.name !== name) throw new Error(`Cassette "${cassette.name}": la llamada #${i} a Canva no coincide con la grabación (${name}).`);
    return hit.result as Record<string, unknown>;
  };
}

export interface CanvaResult {
  ok: boolean;
  seconds: number;
  designId?: string;
  url?: string;
  editUrl?: string;
  pages?: number;
  thumbnails?: string[];
  error?: string;
}

export interface GenerateOptions {
  sink: TraceSink;
  timeoutMs: number;
  /** Espera entre consultas; en replay se escala con replay.speed. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * Un solo camino: create-design (outline) → get-create-design-async-job respetando polling_policy.wait_seconds
 * → get-design-pages (verifica cuántas slides salieron). Nunca lanza: los fallos vuelven como { ok: false }.
 */
export async function generateSlides(input: CanvaDesignInput, call: CanvaCaller, opts: GenerateOptions): Promise<CanvaResult> {
  const t0 = performance.now();
  const elapsed = () => (performance.now() - t0) / 1000;
  let n = 0;
  const step = async (name: string, args: Record<string, unknown>, detail: unknown, verdict?: (r: Record<string, unknown>) => { ok: boolean; note?: string }) => {
    const id = `canva-${n++}`;
    const t = performance.now();
    opts.sink({ kind: 'tool-start', id, name, input: detail });
    try {
      const r = await call(name, args);
      const v = verdict?.(r) ?? { ok: true };
      opts.sink({ kind: 'tool-end', id, name, ok: v.ok, ms: Math.round(performance.now() - t), ...(v.note ? { note: v.note } : {}) });
      return r;
    } catch (err) {
      opts.sink({ kind: 'tool-end', id, name, ok: false, ms: Math.round(performance.now() - t), note: (err as Error).message });
      throw err;
    }
  };

  try {
    let job = await step('create-design', input as unknown as Record<string, unknown>, { claim: `${input.outline.sections.length} slides · ${input.format}` });
    while (job.status !== 'completed') {
      if (job.status === 'failed' || job.error) throw new Error(`Canva no pudo generar el diseño: ${JSON.stringify(job.error ?? job.status)}`);
      if (elapsed() * 1000 > opts.timeoutMs) throw new Error(`Canva no terminó en ${Math.round(opts.timeoutMs / 1000)} s.`);
      const wait = Number((job.polling_policy as { wait_seconds?: number } | undefined)?.wait_seconds ?? 10);
      await opts.sleep(wait * 1000);
      job = await step(
        'get-create-design-async-job',
        { job_id: job.job_id, continuation_token: job.continuation_token, user_intent: 'Esperar a que termine la generación de las slides' },
        { claim: `esperé ${wait}s` },
        (r) => ({ ok: r.status !== 'failed', note: String(r.status) }),
      );
    }
    const design = job.design as { id: string; url?: string; edit_url?: string };
    const pages = await step(
      'get-design-pages',
      { design_id: design.id, limit: 10, user_intent: 'Verificar cuántas slides se generaron' },
      { claim: design.id },
      (r) => {
        const count = Array.isArray(r.pages) ? r.pages.length : Array.isArray(r.items) ? r.items.length : undefined;
        return { ok: count === input.outline.sections.length, note: `${count ?? '?'} slides` };
      },
    );
    const list = (Array.isArray(pages.pages) ? pages.pages : Array.isArray(pages.items) ? pages.items : []) as { thumbnail?: { url?: string } }[];
    return {
      ok: true,
      seconds: elapsed(),
      designId: design.id,
      ...(design.url ? { url: design.url } : {}),
      ...(design.edit_url ? { editUrl: design.edit_url } : {}),
      pages: list.length,
      thumbnails: list.flatMap((p) => (p.thumbnail?.url ? [p.thumbnail.url] : [])),
    };
  } catch (err) {
    return { ok: false, seconds: elapsed(), error: (err as Error).message };
  }
}
