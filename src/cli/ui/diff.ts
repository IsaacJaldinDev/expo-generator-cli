import { diffWords } from 'diff';
import type { Deck, Section } from '../../schemas/deck.ts';
import { stripMarkers } from '../../validators/text.ts';

export interface WordPart {
  text: string;
  op: 'same' | 'add' | 'del';
}

export interface SlideDiff {
  index: number;
  status: 'same' | 'changed' | 'added' | 'removed';
  title: { before?: string; after?: string };
  script: WordPart[];
  /** Fracción del texto que se conserva (0–1). Bajo 0.5 es una reescritura: se muestra antes/ahora. */
  similarity: number;
}

/** Proporción de caracteres sin cambios respecto del más largo de los dos textos. */
export function similarity(parts: WordPart[]): number {
  const same = parts.filter((p) => p.op === 'same').reduce((n, p) => n + p.text.trim().length, 0);
  const before = parts.filter((p) => p.op !== 'add').reduce((n, p) => n + p.text.trim().length, 0);
  const after = parts.filter((p) => p.op !== 'del').reduce((n, p) => n + p.text.trim().length, 0);
  return Math.max(before, after) === 0 ? 1 : same / Math.max(before, after);
}

export const textOf = (parts: WordPart[], side: 'before' | 'after'): string =>
  parts
    .filter((p) => p.op === 'same' || p.op === (side === 'before' ? 'del' : 'add'))
    .map((p) => p.text)
    .join('');

export interface SectionDiff {
  id: string;
  status: 'same' | 'changed' | 'added' | 'removed';
  slides: SlideDiff[];
}

const words = (before: string, after: string): WordPart[] =>
  diffWords(stripMarkers(before), stripMarkers(after)).map((c) => ({
    text: c.value,
    op: c.added ? 'add' : c.removed ? 'del' : 'same',
  }));

function diffSection(before: Section | undefined, after: Section | undefined): SectionDiff {
  const id = (after ?? before)!.id;
  if (!before) return { id, status: 'added', slides: after!.slides.map((s, i) => ({ index: i, status: 'added', title: { after: s.title }, script: words('', s.script), similarity: 0 })) };
  if (!after) return { id, status: 'removed', slides: [] };
  if (JSON.stringify(before) === JSON.stringify(after)) return { id, status: 'same', slides: [] };

  const n = Math.max(before.slides.length, after.slides.length);
  const slides: SlideDiff[] = [];
  for (let i = 0; i < n; i++) {
    const b = before.slides[i];
    const a = after.slides[i];
    if (!a) slides.push({ index: i, status: 'removed', title: { before: b!.title }, script: words(b!.script, ''), similarity: 0 });
    else if (!b) slides.push({ index: i, status: 'added', title: { after: a.title }, script: words('', a.script), similarity: 0 });
    else if (JSON.stringify(a) !== JSON.stringify({ ...b, id: a.id })) {
      const script = words(b.script, a.script);
      slides.push({ index: i, status: 'changed', title: { before: b.title, after: a.title }, script, similarity: similarity(script) });
    }
  }
  return { id, status: 'changed', slides };
}

/** Diff por sección y slide, con el script comparado palabra por palabra (sin marcadores de claims). */
export function diffDecks(before: Deck, after: Deck): SectionDiff[] {
  const ids = [...new Set([...after.sections.map((s) => s.id), ...before.sections.map((s) => s.id)])];
  return ids.map((id) =>
    diffSection(
      before.sections.find((s) => s.id === id),
      after.sections.find((s) => s.id === id),
    ),
  );
}
