import type { Claim } from '../src/schemas/claims.ts';
import { SourcesSchema, type Sources } from '../src/schemas/sources.ts';
import type { Deck, Section } from '../src/schemas/deck.ts';
import type { DeckRuleParams } from '../src/validators/deck-rules.ts';

export const sources: Sources = SourcesSchema.parse({
  tiers: { primary: ['modelcontextprotocol.io'], community: ['github.com'] },
  seeds: [{ url: 'https://modelcontextprotocol.io/intro' }, { url: 'https://github.com/mcp/servers' }],
});

/** Páginas falsas para tests sin red. */
export const PAGES: Record<string, string> = {
  'https://modelcontextprotocol.io/intro':
    '<html><script>var x=1;</script><h1>What is MCP?</h1><p>MCP is an open-source standard for connecting AI applications to external systems.</p>' +
    '<p>Think of MCP like a USB-C port for AI applications. Just as USB-C provides a standardized way to connect devices, MCP provides a standardized way to connect AI applications.</p></html>',
  'https://github.com/mcp/servers': '<p>This repository is a collection of reference implementations for the Model Context Protocol &amp; community servers.</p>',
};
export const fakeFetcher = async (url: string): Promise<string> => {
  const page = PAGES[url];
  if (!page) throw new Error(`HTTP 404 al descargar ${url}`);
  return page;
};

/** 60 palabras por minuto: 1 palabra = 1 segundo, fácil de razonar en los tests. */
export const params: DeckRuleParams = {
  wordsPerMinute: 60,
  budgetSeconds: 100,
  minFillRatio: 0.8,
  maxWordsPerSlide: 12,
  minPurposeWords: 3,
  minExternalClaims: 0,
};

export const words = (n: number, w = 'palabra'): string => Array.from({ length: n }, () => w).join(' ') + '.';

export const section = (id: string, kind: Section['kind'], scriptWords: number, extra: Partial<Section> = {}): Section => ({
  id,
  kind,
  title: `Sección ${id}`,
  goal: 'Objetivo de la sección',
  slides: [
    {
      id: `${id}-1`,
      title: 'Título corto',
      purpose: 'Engancha a la audiencia con una pregunta',
      bullets: ['Una idea'],
      script: words(scriptWords),
    },
  ],
  ...extra,
});

/** Deck válido: hook 20 + body 50 + close 20 = 90 s de 100 s. */
export const validDeck = (): Deck => ({
  title: 'Charla de prueba',
  sections: [section('hook', 'hook', 20), section('que-es', 'body', 50), section('cierre', 'close', 20)],
});

export const claims: Claim[] = [
  { id: 'c-autor', text: 'Un apunte del autor', origin: 'author', knowledgeRef: 'notes#1', verified: true },
  {
    id: 'c-ok',
    text: 'MCP se publicó en noviembre de 2024',
    origin: 'external',
    sourceUrl: 'https://modelcontextprotocol.io/',
    sourceTier: 'primary',
    quote: 'open protocol',
    verified: true,
  },
  {
    id: 'c-nover',
    text: 'El 90% de las startups usan MCP',
    origin: 'external',
    sourceUrl: 'https://example.com/tweet',
    sourceTier: 'social',
    verified: false,
  },
];
