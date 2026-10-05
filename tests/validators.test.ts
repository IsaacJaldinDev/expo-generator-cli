import { describe, expect, it } from 'vitest';
import { validateDeck } from '../src/validators/deck-rules.ts';
import { claimMarkers, countWords, looksLikeExternalFact, splitSentences, stripMarkers } from '../src/validators/text.ts';
import { checkTiming, fmt } from '../src/validators/timing.ts';
import { claims, params, section, validDeck, words } from './fixtures.ts';

describe('texto', () => {
  it('los marcadores de claim no cuentan como palabras', () => {
    expect(countWords('MCP se publicó en 2024[^c-ok].')).toBe(5);
    expect(stripMarkers('Dato[^c1][^c2].')).toBe('Dato.');
    expect(claimMarkers('Uno[^c1]. Dos[^c-2].')).toEqual(['c1', 'c-2']);
  });

  it('divide oraciones sin perder marcadores puestos antes o después del punto', () => {
    expect(splitSentences('Primera[^a]. Segunda.[^b] ¿Tercera? Sí.')).toEqual(['Primera[^a].', 'Segunda.[^b]', '¿Tercera?', 'Sí.']);
  });

  it('heurística de dato externo: %, años y cifras ≥ 100; no números chicos', () => {
    expect(looksLikeExternalFact('El 90% de las startups usan MCP.')).toBe(true);
    expect(looksLikeExternalFact('Se publicó en 2024.')).toBe(true);
    expect(looksLikeExternalFact('Hay más de 1.500 servidores.')).toBe(true);
    expect(looksLikeExternalFact('En 5 minutos verás 3 ideas.')).toBe(false);
    expect(looksLikeExternalFact('Se publicó en 2024[^c-ok].')).toBe(true); // el marcador lo decide el validador
  });
});

describe('check_timing (código, no LLM)', () => {
  it('deck en rango', () => {
    const r = checkTiming(validDeck(), params);
    expect(r).toMatchObject({ ok: true, totalSeconds: 90, totalWords: 90, deltaSeconds: 0 });
  });

  it('reporta el exceso en segundos y palabras a recortar', () => {
    const deck = validDeck();
    deck.sections[1] = section('que-es', 'body', 80); // 20 + 80 + 20 = 120 s
    const r = checkTiming(deck, params);
    expect(r.ok).toBe(false);
    expect(r.deltaSeconds).toBe(20);
    expect(r.problems[0]).toContain('sobran 20 s');
    expect(r.suggestion).toEqual({ sectionId: 'que-es', action: 'quitar', words: 30 }); // 20 + margen 10
  });

  it('reporta faltante bajo el mínimo (80%)', () => {
    const deck = { title: 't', sections: [section('hook', 'hook', 30)] };
    const r = checkTiming(deck, params);
    expect(r.deltaSeconds).toBe(-50);
    expect(r.problems[0]).toContain('faltan 50 s');
    expect(r.suggestion).toEqual({ sectionId: 'hook', action: 'agregar', words: 60 });
  });

  it('en una edición, la sugerencia apunta a la sección dentro del alcance', () => {
    const deck = validDeck();
    deck.sections[1] = section('que-es', 'body', 80); // 120 s: la más larga es que-es
    expect(checkTiming(deck, params).suggestion?.sectionId).toBe('que-es');
    expect(checkTiming(deck, params, ['hook']).suggestion).toEqual({ sectionId: 'hook', action: 'quitar', words: 30 });
  });

  it('marca la sección que excede su objetivo', () => {
    const deck = validDeck();
    deck.sections[0]!.targetSeconds = 15;
    const r = checkTiming(deck, params);
    expect(r.ok).toBe(true); // el total sigue en rango
    expect(r.sections[0]).toMatchObject({ seconds: 20, targetSeconds: 15, overBySeconds: 5 });
  });

  it('deck vacío no rompe (record_claim guarda antes de que existan secciones)', () => {
    const r = checkTiming({ title: 't', sections: [] }, params);
    expect(r).toMatchObject({ ok: false, deltaSeconds: -80, totalSeconds: 0 });
    expect(r.suggestion).toBeUndefined();
  });

  it('fmt', () => expect(fmt(305)).toBe('5:05'));
});

describe('validate_deck', () => {
  const rules = (deck = validDeck(), c = claims) => validateDeck(deck, c, params).errors.map((e) => e.rule);

  it('deck válido pasa', () => {
    expect(validateDeck(validDeck(), claims, params)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('exige hook y que sea la primera sección', () => {
    const deck = validDeck();
    deck.sections.reverse();
    expect(rules(deck)).toContain('hook');
    deck.sections = deck.sections.filter((s) => s.kind !== 'hook');
    expect(validateDeck(deck, claims, params).errors.find((e) => e.rule === 'hook')?.message).toContain('Falta');
  });

  it('palabras visibles por slide y propósito', () => {
    const deck = validDeck();
    deck.sections[0]!.slides[0]!.bullets = [words(15)];
    deck.sections[1]!.slides[0]!.purpose = 'Nada';
    expect(rules(deck)).toEqual(expect.arrayContaining(['palabras-por-slide', 'proposito']));
  });

  it('RECHAZA un claim externo sin verificar y un claim inexistente', () => {
    const deck = validDeck();
    deck.sections[1]!.slides[0]!.script = `El 90% de las startups usan MCP[^c-nover]. Y algo más[^c-fantasma]. ${words(40)}`;
    const errs = validateDeck(deck, claims, params).errors;
    expect(errs.map((e) => e.rule)).toEqual(['claim-sin-verificar', 'claim-inexistente']);
    expect(errs[0]!.message).toContain('fuente no está verificada');
  });

  it('acepta claims verificados y de autor', () => {
    const deck = validDeck();
    deck.sections[1]!.slides[0]!.script = `MCP se publicó en noviembre de 2024[^c-ok]. Lo viví en persona[^c-autor]. ${words(38)}`;
    expect(rules(deck)).toEqual([]);
  });

  it('RECHAZA un dato con cifra sin claim (el dato sembrado del acto 3)', () => {
    const deck = validDeck();
    deck.sections[1]!.slides[0]!.script = `El 90% de las startups de IA ya usan MCP en producción. ${words(40)}`;
    const e = validateDeck(deck, claims, params).errors;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ rule: 'dato-sin-fuente', where: 'que-es-1' });
  });

  it('RECHAZA ids de fragmentos de apuntes usados como claims', () => {
    const deck = validDeck();
    deck.sections[1]!.slides[0]!.script = `MCP es un protocolo abierto[^notes#1]. ${words(45)}`;
    const e = validateDeck(deck, claims, params).errors;
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain('[^notes#1], que no existe');
  });

  it('una cifra citada solo a los apuntes NO pasa: necesita claim externo', () => {
    const deck = validDeck();
    deck.sections[1]!.slides[0]!.script = `El 90% de las startups usan MCP[^c-autor]. ${words(42)}`;
    const e = validateDeck(deck, claims, params).errors;
    expect(e.map((x) => x.rule)).toEqual(['dato-sin-fuente']);
    expect(e[0]!.message).toContain('Citar los apuntes no basta');
  });

  it('exige un mínimo de claims externos verificados citados', () => {
    const deck = validDeck();
    deck.sections[1]!.slides[0]!.script = `MCP se publicó en noviembre de 2024[^c-ok]. Lo viví[^c-autor]. ${words(42)}`;
    expect(validateDeck(deck, claims, { ...params, minExternalClaims: 1 }).ok).toBe(true);
    const e = validateDeck(deck, claims, { ...params, minExternalClaims: 2 }).errors;
    expect(e.map((x) => x.rule)).toEqual(['fuentes-externas']);
    expect(e[0]!.message).toContain('cita 1 claims externos verificados; el mínimo es 2');
  });

  it('duración fuera de presupuesto es error', () => {
    const deck = validDeck();
    deck.sections[1] = section('que-es', 'body', 80);
    expect(rules(deck)).toEqual(['duracion']);
  });

  it('cierre faltante es solo un aviso', () => {
    const deck = validDeck();
    deck.sections[2]!.kind = 'body';
    const v = validateDeck(deck, claims, params);
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.rule)).toEqual(['cierre']);
  });
});
