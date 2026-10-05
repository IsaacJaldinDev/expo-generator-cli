import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../src/agent/events.ts';
import { generateSlides, parseToolResult, recordingCaller, replayCaller, type CanvaCaller } from '../src/canva/generate.ts';
import { cleanBullet, pickCanvaSlides, renderCanvaInput } from '../src/render/canva.ts';
import { emptyCassette } from '../src/replay/cassette.ts';
import { loadBrandGuide } from '../src/schemas/brand.ts';
import type { Deck } from '../src/schemas/deck.ts';

const slide = (id: string, title: string, bullets: string[] = [], purpose = 'Un propósito claro') => ({ id, title, purpose, bullets, script: 'x' });
const deck: Deck = {
  title: 'MCP: el enchufe universal',
  sections: [
    { id: 'hook', kind: 'hook', title: 'H', goal: 'g', slides: [slide('hook-1', '¿Cuántas veces copiaste hoy?', ['- Copiar, pegar, repetir'])] },
    { id: 'que-es', kind: 'body', title: 'Q', goal: 'g', slides: [slide('que-es-1', 'Qué es MCP'), slide('que-es-2', 'Un estándar abierto[^c-1]')] },
    { id: 'como', kind: 'body', title: 'C', goal: 'g', slides: [slide('como-1', 'Host, cliente y servidor', ['1. Host: tu app', '2. Servidor: las herramientas'])] },
    { id: 'cierre', kind: 'close', title: 'Z', goal: 'g', slides: [slide('cierre-1', 'Tu reto de esta semana'), slide('cierre-2', 'Gracias')] },
  ],
};

describe('render: deck.json + brand-guide.yml → create-design', () => {
  it('elige hook, la slide de arquitectura y el cierre', () => {
    expect(pickCanvaSlides(deck).map((p) => `${p.role}:${p.slide.id}`)).toEqual(['hook:hook-1', 'arquitectura:como-1', 'cierre:cierre-1']);
  });

  it('el brief incrusta los hex exactos y las fuentes; el outline no lleva marcadores ni viñetas', () => {
    const brand = loadBrandGuide();
    const input = renderCanvaInput(deck, brand);
    expect(input.brief).toContain('#F6F7EB');
    expect(input.brief).toContain('#E94F37');
    expect(input.brief).toContain('#393E41');
    expect(input.brief).toContain(brand.fonts.heading);
    expect(input.format).toBe('Presentation (16:9)');
    expect(input.outline.sections.map((s) => s.title)).toEqual(['¿Cuántas veces copiaste hoy?', 'Host, cliente y servidor', 'Tu reto de esta semana']);
    expect(input.outline.sections[0]!.points).toEqual(['Copiar, pegar, repetir']);
    expect(input.outline.sections[1]!.points).toEqual(['Host: tu app', 'Servidor: las herramientas']);
    expect(JSON.stringify(input)).not.toContain('[^');
  });

  it('cleanBullet', () => {
    expect(['- a', '• b', '* c', '3) d', '10. e', 'f[^c-1]'].map(cleanBullet)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('sin hook, desarrollo o cierre no se puede generar', () => {
    expect(() => pickCanvaSlides({ title: 't', sections: [] })).toThrow(/al menos un hook/);
  });
});

describe('generateSlides (create-design → job → páginas)', () => {
  const input = renderCanvaInput(deck, loadBrandGuide());
  const pages = { items: [1, 2, 3].map((n) => ({ page_number: n, thumbnail: { url: `https://t/${n}.png` } })) };

  /** Simula Canva: pending → in_progress → completed. */
  function fakeCanva(final: Record<string, unknown> = { status: 'completed', design: { id: 'D1', url: 'https://canva.link/x' } }) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const responses: Record<string, unknown>[] = [
      { job_id: 'j', status: 'pending', continuation_token: 't1', polling_policy: { wait_seconds: 15 } },
      { job_id: 'j', status: 'in_progress', continuation_token: 't2', polling_policy: { wait_seconds: 10 } },
      { job_id: 'j', ...final },
      pages,
    ];
    const call: CanvaCaller = async (name, args) => {
      calls.push({ name, args });
      return responses.shift()!;
    };
    return { call, calls };
  }

  it('respeta polling_policy.wait_seconds, pasa el continuation_token y verifica 3 páginas', async () => {
    const { call, calls } = fakeCanva();
    const waits: number[] = [];
    const events: TraceEvent[] = [];
    const r = await generateSlides(input, call, { sink: (e) => events.push(e), timeoutMs: 60_000, sleep: async (ms) => void waits.push(ms) });

    expect(r).toMatchObject({ ok: true, designId: 'D1', url: 'https://canva.link/x', pages: 3, thumbnails: ['https://t/1.png', 'https://t/2.png', 'https://t/3.png'] });
    expect(waits).toEqual([15_000, 10_000]);
    expect(calls.map((c) => c.name)).toEqual(['create-design', 'get-create-design-async-job', 'get-create-design-async-job', 'get-design-pages']);
    expect(calls[2]!.args).toMatchObject({ job_id: 'j', continuation_token: 't2' });
    expect(events.filter((e) => e.kind === 'tool-end').every((e) => (e as { ok: boolean }).ok)).toBe(true);
  });

  it('un job fallido termina limpio con ok: false (no lanza)', async () => {
    const { call } = fakeCanva({ status: 'failed', error: { code: 'generation_failed' } });
    const r = await generateSlides(input, call, { sink: () => {}, timeoutMs: 60_000, sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('generation_failed');
  });

  it('timeout: si Canva no termina a tiempo, ok: false con mensaje claro', async () => {
    const call: CanvaCaller = async () => ({ job_id: 'j', status: 'in_progress', continuation_token: 't', polling_policy: { wait_seconds: 10 } });
    let now = 0;
    const r = await generateSlides(input, call, {
      sink: () => {},
      timeoutMs: 1,
      sleep: async () => {
        now++;
        await new Promise((res) => setTimeout(res, 5));
      },
    });
    expect(now).toBeGreaterThanOrEqual(0);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/no terminó en/);
  });

  it('errores del MCP (isError) se vuelven mensajes legibles', () => {
    expect(() => parseToolResult({ isError: true, content: [{ type: 'text', text: 'rate limited' }] })).toThrow(/rate limited/);
    expect(parseToolResult({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(parseToolResult({ structuredContent: { b: 2 } })).toEqual({ b: 2 });
  });

  it('cassette: grabar y reproducir las llamadas a Canva en orden', async () => {
    const cassette = emptyCassette('canva');
    const { call } = fakeCanva();
    const rec = await generateSlides(input, recordingCaller(call, cassette), { sink: () => {}, timeoutMs: 60_000, sleep: async () => {} });
    expect(cassette.mcp?.map((m) => m.name)).toEqual(['create-design', 'get-create-design-async-job', 'get-create-design-async-job', 'get-design-pages']);
    const rep = await generateSlides(input, replayCaller(cassette), { sink: () => {}, timeoutMs: 60_000, sleep: async () => {} });
    expect(rep).toMatchObject({ ok: true, url: rec.url, pages: 3 });
    await expect(replayCaller(cassette)('get-design-pages', {})).rejects.toThrow(/no coincide/);
  });
});
