import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExpoAgent } from '../src/agent/agent.ts';
import { DeckStore } from '../src/agent/deck-store.ts';
import type { TraceEvent } from '../src/agent/events.ts';
import { STRUCTURED_OUTPUT_TOOL } from '../src/agent/hooks.ts';
import { ScriptedModel } from '../src/replay/scripted-model.ts';
import { htmlToText, missingNumbers, quoteAppearsIn, rankPassages } from '../src/research/pages.ts';
import { SourceLibrary } from '../src/research/search.ts';
import { loadSources, SourcesSchema, tierFor } from '../src/schemas/sources.ts';
import { validateDeck } from '../src/validators/deck-rules.ts';
import type { Stage } from '../src/tools/deps.ts';
import { fakeFetcher, PAGES, params, sources, words } from './fixtures.ts';

describe('allowlist y tiers (mapeo fijo, no LLM)', () => {
  it('tier por dominio exacto, solo https', () => {
    expect(tierFor(sources, 'https://modelcontextprotocol.io/docs/x')).toBe('primary');
    expect(tierFor(sources, 'https://github.com/a/b')).toBe('community');
    expect(tierFor(sources, 'https://evil-modelcontextprotocol.io/x')).toBeUndefined();
    expect(tierFor(sources, 'https://modelcontextprotocol.io.evil.com/x')).toBeUndefined();
    expect(tierFor(sources, 'http://modelcontextprotocol.io/x')).toBeUndefined();
    expect(tierFor(sources, 'no es url')).toBeUndefined();
  });

  it('una URL semilla fuera de la allowlist invalida la config', () => {
    expect(() => SourcesSchema.parse({ tiers: { primary: ['a.com'] }, seeds: [{ url: 'https://b.com/x' }] })).toThrow(/fuera de la allowlist/);
  });

  it('el sources.yml versionado es válido', () => {
    const s = loadSources();
    expect(s.seeds.length).toBeGreaterThanOrEqual(5);
    expect(s.limits.maxExternalClaims).toBe(5);
  });
});

describe('texto de las fuentes', () => {
  it('HTML → texto sin scripts y con entidades decodificadas', () => {
    const t = htmlToText(PAGES['https://github.com/mcp/servers']! + '<script>alert(1)</script>');
    expect(t).toContain('Model Context Protocol & community servers');
    expect(t).not.toContain('alert');
  });

  it('verificación del quote: literal, tolerante a comillas, mayúsculas y espacios', () => {
    const page = htmlToText(PAGES['https://modelcontextprotocol.io/intro']!);
    expect(quoteAppearsIn('Think of MCP like a USB-C port for AI applications.', page)).toBe(true);
    expect(quoteAppearsIn('think of  MCP like a usb-c port   for AI applications', page)).toBe(true);
    expect(quoteAppearsIn('MCP is used by 90% of AI startups', page)).toBe(false);
    expect(quoteAppearsIn('Think of MCP like a USB-C port for AI agents', page)).toBe(false); // parafrasear no vale
  });

  it('cifras: la cita debe contener los números de la afirmación (es ↔ en)', () => {
    expect(missingNumbers('Hay más de 10.000 servidores MCP públicos', 'There are now more than 10,000 active public MCP servers')).toEqual([]);
    expect(missingNumbers('El 90% de las startups usan MCP', 'They are meant to serve as educational examples, not production-ready.')).toEqual(['90']);
    expect(missingNumbers('MCP se publicó en noviembre de 2024', 'Nov 25, 2024 Today, we are open-sourcing MCP')).toEqual([]);
    expect(missingNumbers('MCP es como un USB-C', 'Think of MCP like a USB-C port')).toEqual([]);
  });

  it('todo pasaje existe literalmente en la página (oraciones cortas en medio incluidas)', () => {
    const page = htmlToText('<h1>Introducing the Model Context Protocol</h1><p>Nov 25, 2024</p><p>Today, we are open-sourcing the Model Context Protocol (MCP).</p><p>Docs</p><p>It is a new standard for connecting AI assistants.</p>');
    const passages = rankPassages('u', page, 'open-sourcing Model Context Protocol standard');
    expect(passages.length).toBeGreaterThan(0);
    for (const p of passages) expect(quoteAppearsIn(p.text, page)).toBe(true);
    expect(passages.some((p) => p.text.includes('Nov 25, 2024'))).toBe(true);
  });

  it('rankea pasajes por términos de la consulta', () => {
    const page = htmlToText(PAGES['https://modelcontextprotocol.io/intro']!);
    const [best] = rankPassages('u', page, 'USB-C port AI applications').sort((a, b) => b.score - a.score);
    expect(best!.text).toContain('USB-C port for AI applications');
  });
});

describe('SourceLibrary', () => {
  it('busca solo en semillas, cachea descargas y reporta las caídas', async () => {
    let downloads = 0;
    const lib = new SourceLibrary(
      SourcesSchema.parse({ ...sources, seeds: [...sources.seeds, { url: 'https://github.com/caida' }] }),
      async (url) => {
        downloads++;
        return fakeFetcher(url);
      },
    );
    const r1 = await lib.search('USB-C port');
    await lib.search('open-source standard');
    expect(r1.passages[0]).toMatchObject({ url: 'https://modelcontextprotocol.io/intro', tier: 'primary' });
    expect(r1.failed).toEqual(['https://github.com/caida']);
    expect(downloads).toBe(4); // 2 OK (cacheadas) + la caída, que se reintenta en la 2ª búsqueda
    await expect(lib.text('https://example.com/x')).rejects.toThrow(/fuera de la allowlist/);
  });
});

describe('acto 2: huecos → research → record_claim (por pasaje) → claims.json', () => {
  const call = (name: string, input: unknown = {}) => ({ toolUses: [{ name, input }] });

  async function run(turns: ReturnType<typeof call>[], stage: Stage = 'research', minExternalClaims = 0) {
    const dir = mkdtempSync(join(tmpdir(), 'expo-r-'));
    mkdirSync(join(dir, 'knowledge'));
    writeFileSync(join(dir, 'knowledge', 'notes.md'), 'MCP es como USB-C.\n');
    const events: TraceEvent[] = [];
    const store = new DeckStore({ title: 'T', sections: [] });
    const model = new ScriptedModel([...turns, call(STRUCTURED_OUTPUT_TOOL, { summary: 'ok', sectionsChanged: [] })]);
    const { agent, invokeOptions, gate } = createExpoAgent({
      model,
      systemPrompt: 't',
      store,
      params: { ...params, minExternalClaims },
      outputDir: join(dir, 'output'),
      knowledgeDir: join(dir, 'knowledge'),
      research: { sources, library: new SourceLibrary(sources, fakeFetcher) },
      stage: { current: stage },
      sink: (e) => events.push(e),
      maxRevisionRounds: 0,
      structuredOutputRetries: 1,
      maxTurns: 30,
      maxToolCalls: 60,
    });
    await agent.invoke('x', invokeOptions);
    const trace = events.flatMap((e) => (e.kind === 'tool-end' ? [`${e.name}${e.ok ? '' : ' ✗'}`] : []));
    return { store, model, trace, dir, gate };
  }

  it('solo se puede citar un pasaje real; las cifras deben estar en el pasaje', async () => {
    const { store, trace, model, dir } = await run([
      call('research', { claim: 'MCP es como un USB-C', query: 'USB-C port AI applications' }),
      call('record_claim', { text: 'MCP es como un puerto USB-C para la IA', passageId: 'p1' }),
      call('research', { claim: '90% de startups', query: 'startups percent production adoption' }),
      // el dato sembrado: el modelo intenta respaldarlo con un pasaje real que no habla de ese número
      call('record_claim', { text: 'El 90% de las startups de IA usan MCP', passageId: 'p1' }),
      call('record_claim', { text: 'Algo', passageId: 'p99' }),
    ]);

    expect(trace).toEqual(['research', 'record_claim', 'research ✗', 'record_claim ✗', 'record_claim ✗']);
    expect(store.claims).toEqual([
      expect.objectContaining({ id: 'c-1', sourceTier: 'primary', verified: true, checks: { quoteFound: true, numbersMatch: true } }),
      expect.objectContaining({ id: 'c-2', sourceTier: 'primary', verified: false, checks: { quoteFound: true, numbersMatch: false } }),
    ]);
    expect(store.claims[0]!.quote).toContain('Think of MCP like a USB-C port for AI applications.');
    expect(store.claims[0]!.sourceUrl).toBe('https://modelcontextprotocol.io/intro');
    const saved = JSON.parse(readFileSync(join(dir, 'output', 'claims.json'), 'utf8'));
    expect(saved.claims).toHaveLength(2);
    expect(JSON.stringify(model.calls[2]!.messages.at(-1))).toContain('[^c-1]'); // instrucción de cita

    // el script puede citar c-1 pero no c-2
    const deck = {
      title: 'T',
      sections: [
        {
          id: 'hook',
          kind: 'hook' as const,
          title: 'H',
          goal: 'g',
          slides: [{ id: 'hook-1', title: 't', purpose: 'Un propósito claro', bullets: [], script: `MCP es como un USB-C[^c-1]. El 90% de las startups lo usan[^c-2]. ${words(80)}` }],
        },
      ],
    };
    expect(validateDeck(deck, store.claims, params).errors.map((e) => e.rule)).toEqual(['claim-sin-verificar']);
  });

  it('etapa research: update_section bloqueado y la compuerta exige claims verificados', async () => {
    const { trace, gate } = await run(
      [call('update_section', { sectionId: 'hook', kind: 'hook', title: 'H', goal: 'g', slides: [{ title: 't', purpose: 'Un propósito claro', bullets: [], script: 'x' }] })],
      'research',
      1,
    );
    expect(trace).toEqual(['update_section ✗']);
    expect(gate.lastResult?.problems[0]).toContain('Hay 0 claims externos verificados; se necesitan al menos 1');
  });

  it('topes en código: máximo de búsquedas por ejecución', async () => {
    const q = call('research', { claim: 'x', query: 'USB-C port' });
    const { trace } = await run([q, q, q, q, q, q, q]);
    expect(trace).toEqual(['research', 'research', 'research', 'research', 'research', 'research', 'research ✗']);
  });
});
