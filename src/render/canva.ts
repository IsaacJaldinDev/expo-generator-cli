import type { BrandGuide } from '../schemas/brand.ts';
import type { Deck, Section, Slide } from '../schemas/deck.ts';
import { stripMarkers } from '../validators/text.ts';

/** Input de la herramienta create-design del MCP de Canva (schema real en docs/canva-tools.json). */
export interface CanvaDesignInput {
  brief: string;
  format: string;
  outline: { sections: { title: string; description: string; points?: string[] }[] };
  user_intent: string;
}

/** Cuántas slides del deck van a Canva: 3 (hook, arquitectura, cierre: la demo corta) o todas. */
export type CanvaSlides = 3 | 'all';

export interface PickedSlide {
  role: 'hook' | 'arquitectura' | 'desarrollo' | 'cierre';
  sectionId: string;
  slide: Slide;
}

const ARCH = /arquitectura|host|cliente|servidor|c[oó]mo funciona|piezas|componentes/i;
/** "- Menos código" / "• Menos código" / "1. Menos código" → "Menos código" (Canva pone sus propias viñetas). */
export const cleanBullet = (b: string): string => stripMarkers(b).replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim();

const text = (s: Slide) => `${s.title} ${s.purpose} ${s.bullets.join(' ')}`;

/**
 * Elige las 3 slides de la demo en código: la primera del hook, la de arquitectura (la slide de desarrollo que
 * más habla de host/cliente/servidor) y la primera del cierre.
 */
export function pickCanvaSlides(deck: Deck, slides: CanvaSlides = 3): PickedSlide[] {
  if (slides === 'all') {
    const all = deck.sections.flatMap((s) =>
      s.slides.map((slide): PickedSlide => ({ role: s.kind === 'hook' ? 'hook' : s.kind === 'close' ? 'cierre' : 'desarrollo', sectionId: s.id, slide })),
    );
    if (all.length === 0) throw new Error('El deck no tiene slides para generar.');
    return all;
  }
  const first = (s?: Section) => (s?.slides[0] ? { sectionId: s.id, slide: s.slides[0] } : undefined);
  const hook = first(deck.sections.find((s) => s.kind === 'hook')) ?? first(deck.sections[0]);
  const close = first(deck.sections.findLast((s) => s.kind === 'close')) ?? first(deck.sections.at(-1));
  const body = deck.sections.filter((s) => s.kind === 'body');
  const scored = body
    .flatMap((s) => s.slides.map((slide) => ({ sectionId: s.id, slide, score: (text(slide).match(new RegExp(ARCH, 'gi')) ?? []).length })))
    .sort((a, b) => b.score - a.score);
  const arch = scored[0]?.score ? scored[0] : first(body[Math.floor(body.length / 2)]);
  if (!hook || !close || !arch) throw new Error('El deck necesita al menos un hook, una sección de desarrollo y un cierre para generar las slides.');
  return [
    { role: 'hook', ...hook },
    { role: 'arquitectura', sectionId: arch.sectionId, slide: arch.slide },
    { role: 'cierre', ...close },
  ];
}

/**
 * deck.json + brand-guide.yml → input de create-design. Los hex van escritos en el brief: el brand kit de Canva
 * no garantiza colores exactos (y create-design no lo usa).
 */
export function renderCanvaInput(deck: Deck, brand: BrandGuide, opts: { slides?: CanvaSlides; audience?: string | undefined } = {}): CanvaDesignInput {
  const picked = pickCanvaSlides(deck, opts.slides);
  const c = brand.colors;
  const brief = [
    `Presentación de ${picked.length} slides en español para una charla: "${deck.title}".${opts.audience ? ` Audiencia: ${opts.audience}.` : ''}`,
    `Paleta OBLIGATORIA con estos hex exactos: fondo ${c.background}; títulos, cifras y acentos ${c.primary}; texto ${c.secondary}.`,
    `No uses otros colores de fondo. El color ${c.primary} solo en títulos y en una palabra de acento por slide, nunca en texto corrido.`,
    `Tipografías: ${brand.fonts.heading} para títulos, ${brand.fonts.body} para el texto.`,
    brand.mood && !/PLACEHOLDER/.test(brand.mood) ? `Estilo: ${brand.mood}.` : 'Estilo: claro y cercano, minimalista, mucho espacio en blanco.',
    `Una idea por slide, como máximo ${brand.layout.maxWordsPerSlide} palabras visibles, texto grande legible desde la última fila de un auditorio.`,
  ].join(' ');
  return {
    brief,
    format: 'Presentation (16:9)',
    outline: {
      sections: picked.map(({ slide }) => ({
        title: stripMarkers(slide.title),
        description: stripMarkers(slide.purpose),
        ...(slide.bullets.length ? { points: slide.bullets.map(cleanBullet).filter(Boolean) } : {}),
      })),
    },
    user_intent: `Generar ${picked.length} slides de la charla con la línea gráfica exacta del autor`,
  };
}
