import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../src/agent/events.ts';
import { buildChain, formatChain } from '../src/cli/ui/chain.ts';
import { BriefView, ChainLine, ClaimsTable, CostView, DiffView, TraceView } from '../src/cli/ui/components.tsx';
import { diffDecks } from '../src/cli/ui/diff.ts';
import { reduceRows, type Row } from '../src/cli/ui/rows.ts';
import { claims, section, validDeck } from './fixtures.ts';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const end = (name: string, ok = true, id = name): TraceEvent => ({ kind: 'tool-end', id, name, ok, ms: 10 });

describe('cadena de la traza (lo que ve el público)', () => {
  it('agrupa repeticiones y marca revisiones ✓/✗', () => {
    const events: TraceEvent[] = [
      end('read_knowledge'),
      end('research'),
      end('research'),
      end('research'),
      end('record_claim'),
      end('record_claim'),
      end('record_claim'),
      end('check_timing', false),
      end('update_section'),
      end('check_timing'),
      end('validate_deck'),
    ];
    expect(formatChain(buildChain(events))).toBe(
      'read_knowledge → research ×3 → record_claim ×3 → check_timing ✗ → update_section → check_timing ✓ → validate_deck ✓',
    );
  });

  it('un rechazo en medio de herramientas iguales corta el grupo; el guardrail aparece en la cadena', () => {
    const events: TraceEvent[] = [
      end('record_claim'),
      end('record_claim', false),
      end('record_claim'),
      { kind: 'guardrail', via: 'apply-guardrail', interventions: [{ source: 'input', policy: 'prompt-attack', detail: 'PROMPT_ATTACK', action: 'BLOCKED' }] },
    ];
    expect(formatChain(buildChain(events))).toBe('record_claim → record_claim ✗ → record_claim → 🛡 guardrail ✗');
  });
});

describe('filas de la traza', () => {
  it('tool-start → corriendo; tool-end → ✓/✗ con nota; update_section muestra la sección', () => {
    let rows: Row[] = [];
    rows = reduceRows(rows, { kind: 'stage-start', stage: 'deck', title: 'ACTO 3' });
    rows = reduceRows(rows, { kind: 'tool-start', id: 't1', name: 'update_section', input: { sectionId: 'hook', slides: [{}, {}] } });
    expect(rows[1]).toMatchObject({ kind: 'tool', status: 'running', detail: '[hook] slides (2 slides)' });
    rows = reduceRows(rows, { kind: 'tool-end', id: 't1', name: 'update_section', ok: false, ms: 900, note: 'Edición puntual' });
    expect(rows[1]).toMatchObject({ status: 'fail', ms: 900, note: 'Edición puntual' });
    const out = strip(renderToString(<TraceView rows={rows} />, { columns: 100 }));
    expect(out).toContain('━━ ACTO 3 ━━');
    expect(out).toMatch(/✗\s+update_section\s+Edición puntual\s+0\.9s/);
  });

  it('detalle legible: research muestra la afirmación y record_claim el pasaje', () => {
    let rows = reduceRows([], { kind: 'tool-start', id: 'a', name: 'research', input: { claim: 'MCP es como USB-C', query: 'usb-c' } });
    rows = reduceRows(rows, { kind: 'tool-start', id: 'b', name: 'record_claim', input: { text: 'MCP es abierto', passageId: 'p3' } });
    rows = reduceRows(rows, { kind: 'tool-start', id: 'c', name: 'check_timing', input: {} });
    expect(rows.map((r) => (r.kind === 'tool' ? r.detail : ''))).toEqual(['«MCP es como USB-C»', 'p3 → «MCP es abierto»', '']);
  });

  it('el guardrail se dibuja como banner con política, contenido y acción', () => {
    const rows = reduceRows([], {
      kind: 'guardrail',
      via: 'apply-guardrail',
      interventions: [{ source: 'output', policy: 'datos-sensibles', detail: 'EMAIL', action: 'ANONYMIZED', match: 'ana@uni.edu' }],
    });
    const out = strip(renderToString(<TraceView rows={rows} />, { columns: 100 }));
    expect(out).toContain('BEDROCK GUARDRAILS · ANONYMIZED');
    expect(out).toContain('datos-sensibles · EMAIL · en OUTPUT  «ana@uni.edu»');
  });

  it('solo muestra las últimas filas y cuenta las anteriores', () => {
    let rows: Row[] = [];
    for (let i = 0; i < 20; i++) rows = reduceRows(rows, { kind: 'info', message: `paso ${i}` });
    const out = strip(renderToString(<TraceView rows={rows} maxRows={5} />));
    expect(out).toContain('… 15 pasos anteriores');
    expect(out).toContain('paso 19');
    expect(out).not.toContain('paso 14');
  });
});

describe('diff de la edición', () => {
  it('solo la sección editada aparece cambiada; el resto queda "sin cambios"', () => {
    const before = validDeck();
    const after = structuredClone(before);
    after.sections[0]!.slides[0]!.script = '¿Y si tu IA dejara de pedirte que copies y pegues? palabra.';
    after.sections[0]!.slides[0]!.title = 'Más provocador';
    const diffs = diffDecks(before, after);
    expect(diffs.map((d) => `${d.id}:${d.status}`)).toEqual(['hook:changed', 'que-es:same', 'cierre:same']);
    expect(diffs[0]!.slides[0]!.script.filter((p) => p.op === 'add').map((p) => p.text).join('')).toContain('copies y pegues');

    const out = strip(renderToString(<DiffView diffs={diffs} />, { columns: 100 }));
    expect(out).toContain('~ sección hook');
    expect(out).toContain('título: Título corto → Más provocador');
    expect(out).toContain('= sin cambios: que-es, cierre');
  });

  it('una reescritura completa se muestra como antes/ahora en lugar de intercalar palabras', () => {
    const before = validDeck();
    const after = structuredClone(before);
    after.sections[0]!.slides[0]!.script = 'Miren, yo tenía cinco modelos y tres herramientas distintas.';
    const [hook] = diffDecks(before, after);
    expect(hook!.slides[0]!.similarity).toBeLessThan(0.5);
    const out = strip(renderToString(<DiffView diffs={[hook!]} />, { columns: 100 }));
    expect(out).toContain('Miren, yo tenía cinco modelos y tres herramientas distintas.');
    expect(out).toContain('palabra palabra');
  });

  it('secciones agregadas y eliminadas', () => {
    const before = validDeck();
    const after = { ...before, sections: [before.sections[0]!, section('nueva', 'body', 5)] };
    expect(diffDecks(before, after).map((d) => `${d.id}:${d.status}`)).toEqual(['hook:same', 'nueva:added', 'que-es:removed', 'cierre:removed']);
  });
});

describe('paneles', () => {
  it('claims: ✓/✗, tier y motivo del rechazo', () => {
    const out = strip(renderToString(<ClaimsTable claims={claims} />, { columns: 120 }));
    expect(out).toMatch(/✓\s+c-ok\s+primary\s+MCP se publicó/);
    expect(out).toMatch(/✗\s+c-nover\s+social/);
    expect(out).toContain('+ 1 claims de autor');
  });

  it('brief: marca los datos de los apuntes que parecen externos', () => {
    const out = strip(
      renderToString(
        <BriefView
          brief={{ title: 'T', topic: 't', audience: 'a', durationMinutes: 5, objective: 'o', language: 'es', mustInclude: [] }}
          fragments={[
            { id: 'notes#1', heading: '', text: 'MCP es un protocolo abierto.' },
            { id: 'notes#2', heading: '', text: 'El 90% de las startups usan MCP.' },
          ]}
        />,
        { columns: 120 },
      ),
    );
    expect(out).toContain('5 minutos');
    expect(out).toContain('⚠ notes#2');
    expect(out).not.toContain('⚠ notes#1');
  });

  it('bedrock: costo por modelo y la línea de config a cambiar', () => {
    const run = (model: string, costUsd: number, seconds: number) => ({
      at: '',
      act: 'full',
      model,
      modelId: model,
      seconds,
      stages: [],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      costUsd,
      ok: true,
    });
    const out = strip(
      renderToString(
        <CostView runs={[run('mistral', 0.08, 80), run('mistral', 0.06, 60), run('nova', 0.04, 100)]} active={{ key: 'mistral', modelId: 'mistral.x' }} configLine={{ line: 10, text: 'active: mistral' }} />,
        { columns: 120 },
      ),
    );
    expect(out).toMatch(/mistral\s+2 ejecuciones · 70s prom\. · \$0\.070 prom\./);
    expect(out).toContain('línea 10');
    expect(out).toContain('active: mistral');
  });

  it('la cadena se dibuja con flechas', () => {
    const out = strip(renderToString(<ChainLine links={buildChain([end('research'), end('validate_deck')])} />, { columns: 100 }));
    expect(out).toContain('research → validate_deck ✓');
  });
});
