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
import { notesGate } from '../src/agent/notes-review.ts';
import { knowledgeHash } from '../src/schemas/notes-review.ts';
import { fragmentMarkdown } from '../src/tools/read-knowledge.ts';
import type { Stage } from '../src/tools/deps.ts';
import { fakeFetcher, PAGES, params, sources, words, notesDeps } from './fixtures.ts';

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

  async function run(turns: ReturnType<typeof call>[], stage: Stage = 'research', minExternalClaims = 0, notesMd = 'MCP es como USB-C.\n') {
    const dir = mkdtempSync(join(tmpdir(), 'expo-r-'));
    mkdirSync(join(dir, 'knowledge'));
    writeFileSync(join(dir, 'knowledge', 'notes.md'), notesMd);
    const nd = notesDeps();
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
      ...nd,
      sink: (e) => events.push(e),
      maxRevisionRounds: 0,
      structuredOutputRetries: 1,
      maxTurns: 30,
      maxToolCalls: 60,
    });
    await agent.invoke('x', invokeOptions);
    const trace = events.flatMap((e) => (e.kind === 'tool-end' ? [`${e.name}${e.ok ? '' : ' ✗'}`] : []));
    return { store, model, trace, dir, gate, notes: nd.notes, events };
  }

  it('solo se puede citar un pasaje real; las cifras deben estar en el pasaje', async () => {
    const { store, trace, model, dir } = await run([
      call('research', { claim: 'MCP es como un USB-C', query: 'USB-C port AI applications' }),
      call('record_claim', { text: 'MCP es como un puerto USB-C para la IA', passageId: 'p1' }),
      call('research', { claim: '90% de startups', query: 'startups percent production adoption' }),
      // el dato sembrado: el modelo intenta respaldarlo con un pasaje real que no habla de ese número
      call('record_claim', { text: 'El 90% de las startups de IA usan MCP', passageId: 'p1' }),
      call('record_claim', { text: 'Algo', passageId: 'p99' }),
      // un marcador en el texto no es una cifra
      call('record_claim', { text: 'MCP es como un puerto USB-C [^c-1].', passageId: 'p1' }),
    ]);

    expect(trace).toEqual(['research', 'record_claim', 'research ✗', 'record_claim ✗', 'record_claim ✗', 'record_claim']);
    expect(store.claims).toEqual([
      expect.objectContaining({ id: 'c-1', sourceTier: 'primary', verified: true, checks: { quoteFound: true, numbersMatch: true } }),
      expect.objectContaining({ id: 'c-2', sourceTier: 'primary', verified: false, checks: { quoteFound: true, numbersMatch: false } }),
      expect.objectContaining({ id: 'c-3', text: 'MCP es como un puerto USB-C.', verified: true }),
    ]);
    expect(store.claims[0]!.quote).toContain('Think of MCP like a USB-C port for AI applications.');
    expect(store.claims[0]!.sourceUrl).toBe('https://modelcontextprotocol.io/intro');
    const saved = JSON.parse(readFileSync(join(dir, 'output', 'claims.json'), 'utf8'));
    expect(saved.claims).toHaveLength(3);
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
      [call('read_knowledge'), call('review_note', { fragmentId: 'notes#1', explanation: 'Ninguna fuente lo trata.' }), call('update_section', { sectionId: 'hook', kind: 'hook', title: 'H', goal: 'g', slides: [{ title: 't', purpose: 'Un propósito claro', bullets: [], script: 'x' }] })],
      'research',
      1,
    );
    expect(trace).toEqual(['read_knowledge', 'review_note', 'update_section ✗']);
    expect(gate.lastResult?.problems[0]).toContain('Hay 0 claims externos verificados; se necesitan al menos 1');
  });

  it('topes en código: máximo de búsquedas por ejecución', async () => {
    const q = call('research', { claim: 'x', query: 'USB-C port' });
    const max = sources.limits.maxResearchCalls;
    const { trace } = await run(Array(max + 1).fill(q));
    expect(trace).toEqual([...Array(max).fill('research'), 'research ✗']);
  });

  const NOTES = [
    '# MCP',
    '',
    'MCP es un estándar de código abierto para conectar aplicaciones de IA con sistemas externos.',
    '',
    'El 90% de las startups de IA ya usan MCP en producción.',
    '',
    '# Ideas',
    '',
    'Me encanta enseñar con analogías.',
    '',
  ].join('\n');
  const research = call('research', { claim: 'estándar abierto', query: 'open-source standard connecting AI applications external systems' });

  it('revisión de apuntes: confirmado → claim citable; la fuente no alcanza a respaldarlo → sin-verificar (silencioso, no detiene)', async () => {
    const { trace, notes, store, gate, dir } = await run(
      [
        call('read_knowledge'),
        research,
        call('review_note', { fragmentId: 'notes#1', passageId: 'p1', relation: 'supports', explanation: 'La fuente lo define igual.' }),
        call('review_note', { fragmentId: 'notes#2', passageId: 'p1', relation: 'supports', explanation: 'Habla de MCP.' }),
        call('mark_own_notes', { fragmentIds: ['notes#3'] }),
      ],
      'research',
      1,
      NOTES,
    );
    expect(trace).toEqual(['read_knowledge', 'research', 'review_note', 'review_note', 'mark_own_notes']);
    expect(notes.list().map((r) => `${r.fragmentId}:${r.verdict}:${r.decidedBy}`)).toEqual(['notes#1:confirmado:codigo', 'notes#2:sin-verificar:codigo']);
    expect(notes.list()[1]!.reasons.join(' ')).toContain('no contiene las cifras 90');
    // el confirmado queda como claim externo verificado ligado al apunte (no consume cupo de huecos)
    expect(store.claims).toEqual([expect.objectContaining({ id: 'c-1', verified: true, knowledgeRef: 'notes#1' })]);
    // el apunte confirmado cuenta como claim verificado para la compuerta
    expect(gate.lastResult).toEqual({ ok: true, problems: [] });
    expect(notes.blocking()).toEqual([]);

    const md = readFileSync(join(dir, 'output', 'revision-apuntes.md'), 'utf8');
    expect(md).toContain('**Los apuntes pasaron la revisión.**');
    // lo que ninguna fuente confirma ni contradice no se reporta, pero sigue en tus apuntes
    expect(md).not.toMatch(/notes#2|Sin respaldo|sin respaldo/);
    expect(md).toMatch(/## ✓ Confirmados[\s\S]*notes#1/);
    const valid = readFileSync(join(dir, 'output', 'apuntes-validos', 'notes.md'), 'utf8');
    expect(valid).toContain('MCP es un estándar de código abierto');
    expect(valid).toContain('<!-- confirmado: https://modelcontextprotocol.io/intro -->');
    expect(valid).toContain('# Ideas\n\nMe encanta enseñar con analogías.');
    expect(valid).toContain('90%'); // sin-verificar: se conserva, sin comentario de fuente
    expect(valid).not.toMatch(/confirmado:.*\n.*90%/);
    // listo para pegar: el comentario no crea fragmentos nuevos
    expect(fragmentMarkdown('notes', valid).map((f) => f.text)).toEqual([
      'MCP es un estándar de código abierto para conectar aplicaciones de IA con sistemas externos.',
      'El 90% de las startups de IA ya usan MCP en producción.',
      'Me encanta enseñar con analogías.',
    ]);
  });

  it('revisión de apuntes: cobertura total; un dato no se puede marcar como propio; contradice → inconsistente (modelo); sin pasaje → sin-respaldo', async () => {
    const pending = await run([call('read_knowledge'), call('mark_own_notes', { fragmentIds: ['notes#2', 'notes#3'] })], 'research', 0, NOTES);
    expect(pending.trace).toEqual(['read_knowledge', 'mark_own_notes ✗']);
    expect(pending.notes.ownIds()).toEqual(['notes#3']); // notes#2 tiene "90%": rechazado
    expect(pending.gate.lastResult?.problems[0]).toMatch(/Faltan 2 fragmentos[\s\S]*notes#1[\s\S]*notes#2/);
    expect(readFileSync(join(pending.dir, 'output', 'revision-apuntes.md'), 'utf8')).toContain('**La revisión quedó incompleta**: faltan notes#1, notes#2');

    const { notes, gate, dir } = await run(
      [
        call('read_knowledge'),
        research,
        call('review_note', { fragmentId: 'notes#1', passageId: 'p1', relation: 'contradicts', explanation: 'La fuente dice que es propietario.' }),
        call('review_note', { fragmentId: 'notes#2', explanation: 'Ninguna fuente habla de startups.' }),
        call('review_note', { fragmentId: 'notes#9', explanation: 'x' }),
        call('mark_own_notes', { fragmentIds: ['notes#3'] }),
      ],
      'research',
      0,
      NOTES,
    );
    expect(notes.list().map((r) => `${r.fragmentId}:${r.verdict}:${r.decidedBy}`)).toEqual(['notes#1:inconsistente:modelo', 'notes#2:sin-verificar:modelo']);
    expect(notes.list()[0]).toMatchObject({ reasons: ['La fuente dice que es propietario.'], passage: expect.stringContaining('open-source standard') });
    // sin-verificar no detiene ni se reporta; inconsistente sí;
    // con un apunte inconsistente la compuerta deja terminar la etapa aunque falten claims: le toca al autor
    expect(notes.blocking().map((r) => r.fragmentId)).toEqual(['notes#1']);
    expect(gate.lastResult?.ok).toBe(true);
    const md = readFileSync(join(dir, 'output', 'revision-apuntes.md'), 'utf8');
    expect(md).toContain('**El proceso se detuvo.**');
    expect(md).toMatch(/## ✗ Inconsistencias[\s\S]*notes#1[\s\S]*Lo que dice la fuente:[\s\S]*señalado por el modelo/);
    expect(readFileSync(join(dir, 'output', 'apuntes-validos', 'notes.md'), 'utf8')).not.toContain('estándar de código abierto');
  });
});

describe('notesGate: el acto 3 solo escribe sobre apuntes revisados', () => {
  const fragments = [{ id: 'notes#1', heading: '', text: 'MCP es un protocolo abierto.' }];
  const write = (dir: string, reviews: unknown[], hash = knowledgeHash(fragments)) =>
    writeFileSync(join(dir, 'notes-review.json'), JSON.stringify({ knowledgeHash: hash, reviewedAt: '2026-10-05T00:00:00Z', reviews }));
  const review = (verdict: string) => ({ fragmentId: 'notes#1', text: 'x', verdict, decidedBy: 'codigo', reasons: [] });

  it('sin apuntes pasa; sin revisión, con apuntes cambiados o con inconsistencias no', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    expect(notesGate([], dir, ['inconsistente']).ok).toBe(true);
    expect(notesGate(fragments, dir, ['inconsistente'])).toMatchObject({ ok: false, reason: expect.stringContaining('todavía no se revisaron') });
    write(dir, [review('confirmado')], 'otra-huella');
    expect(notesGate(fragments, dir, ['inconsistente'])).toMatchObject({ ok: false, reason: expect.stringContaining('cambiaron') });
    write(dir, [review('inconsistente')]);
    expect(notesGate(fragments, dir, ['inconsistente'])).toMatchObject({ ok: false, reason: expect.stringContaining('notes#1') });
    write(dir, [review('sin-verificar')]);
    expect(notesGate(fragments, dir, ['inconsistente']).ok).toBe(true);
    writeFileSync(join(dir, 'notes-review.json'), JSON.stringify({ knowledgeHash: knowledgeHash(fragments), reviewedAt: 'x', reviews: [], pending: ['notes#1'] }));
    expect(notesGate(fragments, dir, ['inconsistente'])).toMatchObject({ ok: false, reason: expect.stringContaining('incompleta') });
    write(dir, [review('sin-verificar')]);
    expect(notesGate(fragments, dir, ['inconsistente']).ok).toBe(true);
  });
});
