import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeckStore } from '../src/agent/deck-store.ts';
import { toolVerdict } from '../src/agent/hooks.ts';
import { renderScript } from '../src/render/script.ts';
import { renderTiming } from '../src/render/timing.ts';
import { DeckSchema } from '../src/schemas/deck.ts';
import { fragmentMarkdown } from '../src/tools/read-knowledge.ts';
import { JsonBlock, TextBlock, ToolResultBlock } from '@strands-agents/sdk';
import { claims, params, validDeck, words } from './fixtures.ts';

describe('renderers', () => {
  it('script.md: secciones, propósito, pantalla, script y notas al pie de los claims citados', () => {
    const deck = validDeck();
    deck.sections[1]!.slides[0]!.script = `MCP se publicó en noviembre de 2024[^c-ok]. ${words(43)}`; // 7 + 43 = 50
    const md = renderScript(deck, claims, params);
    expect(md).toContain('# Charla de prueba');
    expect(md).toContain('Duración estimada **1:30** de 1:40');
    expect(md).toContain('## 1. Hook — Sección hook');
    expect(md).toContain('*Propósito:* Engancha');
    expect(md).toContain('- Una idea');
    expect(md).toContain('[^c-ok]: MCP se publicó en noviembre de 2024 — https://modelcontextprotocol.io/ (primary, ✓ verificado)');
    expect(md).not.toContain('[^c-nover]:'); // solo los citados
  });

  it('timing.md: tabla con total y estado', () => {
    const md = renderTiming(validDeck(), params);
    expect(md).toContain('| hook | 1 | 20 | 0:20 | — |  |');
    expect(md).toContain('| **Total** | 3 | 90 | **1:30** | 1:40 | ✓ dentro del presupuesto |');
  });
});

describe('DeckStore', () => {
  it('crea secciones en posición, asigna ids de slide y registra el cambio', () => {
    const store = new DeckStore({ title: 't', sections: [] });
    const slide = { title: 'T', purpose: 'Un propósito claro', bullets: [], script: 'Hola.' };
    store.applyPatch({ sectionId: 'cierre', kind: 'close', title: 'Cierre', goal: 'g', slides: [slide] });
    store.applyPatch({ sectionId: 'hook', kind: 'hook', title: 'Hook', goal: 'g', position: 0, slides: [slide, slide] });
    expect(store.deck.sections.map((s) => s.id)).toEqual(['hook', 'cierre']);
    expect(store.deck.sections[0]!.slides.map((s) => s.id)).toEqual(['hook-1', 'hook-2']);
    expect(store.changes.map((c) => c.action)).toEqual(['created', 'created']);
  });

  it('un parche parcial solo cambia los campos enviados', () => {
    const store = new DeckStore(validDeck());
    const before = structuredClone(store.deck);
    const change = store.applyPatch({ sectionId: 'hook', title: 'Nuevo título' });
    expect(change.action).toBe('updated');
    expect(store.deck.sections[0]!.title).toBe('Nuevo título');
    expect(store.deck.sections[0]!.slides).toEqual(before.sections[0]!.slides);
    expect(store.deck.sections.slice(1)).toEqual(before.sections.slice(1));
  });

  it('pega los marcadores sueltos a la oración que respaldan', () => {
    const store = new DeckStore(validDeck());
    store.applyPatch({
      sectionId: 'hook',
      slides: [{ title: 'T', purpose: 'Un propósito claro', bullets: [], script: '¿Pregunta? [^c-ok] Otra frase  [^c-autor].' }],
    });
    expect(store.deck.sections[0]!.slides[0]!.script).toBe('¿Pregunta?[^c-ok] Otra frase[^c-autor].');
  });

  it('citar un fragmento de los apuntes registra un claim de autor verificado en código', () => {
    const store = new DeckStore(validDeck());
    store.setKnowledge([{ id: 'notes#3', text: 'Con MCP el problema pasa de N×M a N+M.' }]);
    store.applyPatch({
      sectionId: 'hook',
      slides: [{ title: 'T', purpose: 'Un propósito claro', bullets: [], script: 'Pasa de N×M a N+M[^notes#3]. Otra[^notes#99].' }],
    });
    expect(store.claims).toEqual([
      { id: 'notes#3', text: 'Con MCP el problema pasa de N×M a N+M.', origin: 'author', knowledgeRef: 'notes#3', verified: true },
    ]); // notes#99 no existe: no se registra y validate_deck lo reportará
  });

  it('los objetivos por sección se escalan en código si suman más que la charla', () => {
    const store = new DeckStore(validDeck());
    store.deck.sections.forEach((s, i) => (s.targetSeconds = [90, 120, 90][i]));
    expect(store.normalizeTargets(100)).toBe(true);
    expect(store.deck.sections.map((s) => s.targetSeconds)).toEqual([30, 40, 30]); // 90+120+90 → suma 100
    expect(store.normalizeTargets(100)).toBe(false);
  });

  it('edición puntual: la primera sección tocada fija el alcance y el resto se rechaza', () => {
    const store = new DeckStore(validDeck());
    store.startEdit();
    store.applyPatch({ sectionId: 'hook', title: 'Más provocador' });
    expect(() => store.applyPatch({ sectionId: 'que-es', title: 'x' })).toThrow(/solo puedes modificar "hook"/);
    store.applyPatch({ sectionId: 'hook', goal: 'otra vez hook: permitido' });
    const explicit = new DeckStore(validDeck());
    explicit.startEdit(['hook', 'cierre']);
    explicit.applyPatch({ sectionId: 'cierre', title: 'ok' });
    expect(() => explicit.applyPatch({ sectionId: 'que-es', title: 'x' })).toThrow(/"hook", "cierre"/);
  });

  it('rechaza una sección nueva incompleta y permite eliminar', () => {
    const store = new DeckStore(validDeck());
    expect(() => store.applyPatch({ sectionId: 'nueva', title: 'x' })).toThrow(/faltan los campos kind, goal, slides/);
    store.applyPatch({ sectionId: 'que-es', remove: true });
    expect(store.deck.sections.map((s) => s.id)).toEqual(['hook', 'cierre']);
  });

  it('save escribe los 4 archivos consistentes y load los recupera', () => {
    const dir = mkdtempSync(join(tmpdir(), 'expo-'));
    const store = new DeckStore(validDeck(), claims);
    store.save(dir, params);
    const reloaded = DeckStore.load(dir, 'x');
    expect(reloaded.deck).toEqual(DeckSchema.parse(store.deck));
    expect(reloaded.claims).toHaveLength(3);
    expect(readFileSync(join(dir, 'script.md'), 'utf8')).toContain('**1:30**');
    expect(readFileSync(join(dir, 'timing.md'), 'utf8')).toContain('**1:30**');
  });
});

describe('read_knowledge', () => {
  it('fragmenta por párrafo e ítem de lista, con encabezado e id estable', () => {
    const md = '<!-- PLACEHOLDER -->\n# Qué es\n\nPárrafo uno\ncontinúa aquí.\n\n# Arquitectura\n\n- Host: app\n- Servidor: programa\n';
    expect(fragmentMarkdown('notes', md)).toEqual([
      { id: 'notes#1', heading: 'Qué es', text: 'Párrafo uno continúa aquí.' },
      { id: 'notes#2', heading: 'Arquitectura', text: 'Host: app' },
      { id: 'notes#3', heading: 'Arquitectura', text: 'Servidor: programa' },
    ]);
  });
});

describe('veredicto de herramienta en la traza', () => {
  const block = (content: (JsonBlock | TextBlock)[], status: 'success' | 'error' = 'success') =>
    new ToolResultBlock({ toolUseId: 't', status, content });

  it('ok:false en el JSON se muestra como ✗ con el primer problema', () => {
    expect(toolVerdict(block([new JsonBlock({ json: { ok: false, problems: ['sobran 20 s'] } })]))).toEqual({
      ok: false,
      note: 'sobran 20 s',
    });
    expect(toolVerdict(block([new JsonBlock({ json: { ok: false, errors: [{ message: 'falta hook' }] } })])).note).toBe('falta hook');
    expect(toolVerdict(block([new JsonBlock({ json: { ok: true } })]))).toEqual({ ok: true });
    expect(toolVerdict(block([new TextBlock('x')], 'error'), new Error('boom'))).toEqual({ ok: false, note: 'boom' });
  });
});
