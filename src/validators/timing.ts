import type { Deck, Section } from '../schemas/deck.ts';
import { countWords } from './text.ts';

export interface TimingParams {
  wordsPerMinute: number;
  /** Duración objetivo de la charla, en segundos. */
  budgetSeconds: number;
  /** Fracción mínima del presupuesto que el script debe llenar (0.8 = no menos del 80%). */
  minFillRatio: number;
}

export interface SectionTiming {
  id: string;
  title: string;
  words: number;
  seconds: number;
  targetSeconds?: number;
  /** > 0 si la sección excede su objetivo. */
  overBySeconds?: number;
}

export interface TimingReport {
  ok: boolean;
  wordsPerMinute: number;
  budgetSeconds: number;
  totalWords: number;
  totalSeconds: number;
  /** > 0: exceso sobre el presupuesto; < 0: segundos que faltan para el mínimo. 0 si está en rango. */
  deltaSeconds: number;
  /** Corrección sugerida en código: una sola sección y cuántas palabras agregar/quitar. */
  suggestion?: { sectionId: string; action: 'agregar' | 'quitar'; words: number };
  sections: SectionTiming[];
  problems: string[];
}

export const secondsFor = (words: number, wpm: number): number => Math.round((words / wpm) * 60);

export function sectionTiming(section: Section, wpm: number): SectionTiming {
  const words = section.slides.reduce((n, s) => n + countWords(s.script), 0);
  const seconds = secondsFor(words, wpm);
  const t: SectionTiming = { id: section.id, title: section.title, words, seconds };
  if (section.targetSeconds !== undefined) {
    t.targetSeconds = section.targetSeconds;
    if (seconds > section.targetSeconds) t.overBySeconds = seconds - section.targetSeconds;
  }
  return t;
}

/** Timing calculado en código: palabras del script ÷ palabras por minuto. */
/** `preferSections`: si se indica (alcance de una edición), la sugerencia elige solo entre esas secciones. */
export function checkTiming(deck: Deck, p: TimingParams, preferSections?: Iterable<string>): TimingReport {
  const sections = deck.sections.map((s) => sectionTiming(s, p.wordsPerMinute));
  const totalWords = sections.reduce((n, s) => n + s.words, 0);
  const totalSeconds = sections.reduce((n, s) => n + s.seconds, 0);
  const minSeconds = Math.round(p.budgetSeconds * p.minFillRatio);
  const problems: string[] = [];
  let deltaSeconds = 0;
  let suggestion: TimingReport['suggestion'];
  // Holgura por sección: objetivo − duración (sin objetivo, se compara contra el promedio).
  const avg = sections.length ? totalSeconds / sections.length : 0;
  const slack = (s: SectionTiming) => (s.targetSeconds ?? avg) - s.seconds;
  // Margen de 10 palabras para no quedar justo en el borde.
  const wordsFor = (secs: number) => Math.ceil((secs / 60) * p.wordsPerMinute) + 10;
  const preferred = new Set(preferSections ?? []);
  const candidates = sections.some((s) => preferred.has(s.id)) ? sections.filter((s) => preferred.has(s.id)) : sections;

  if (sections.length === 0) {
    deltaSeconds = -minSeconds;
    problems.push(`El deck no tiene secciones todavía: faltan ${minSeconds} s de contenido.`);
  } else if (totalSeconds > p.budgetSeconds) {
    deltaSeconds = totalSeconds - p.budgetSeconds;
    const target = candidates.reduce((a, b) => (slack(b) < slack(a) ? b : a));
    suggestion = { sectionId: target.id, action: 'quitar', words: wordsFor(deltaSeconds) };
    problems.push(
      `La charla dura ${fmt(totalSeconds)} y el máximo es ${fmt(p.budgetSeconds)}: sobran ${deltaSeconds} s. ` +
        `Quita ~${suggestion.words} palabras del script de la sección "${target.id}" (hoy ${target.words}) y deja las demás igual.`,
    );
  } else if (totalSeconds < minSeconds) {
    deltaSeconds = totalSeconds - minSeconds;
    const target = candidates.reduce((a, b) => (slack(b) > slack(a) ? b : a));
    suggestion = { sectionId: target.id, action: 'agregar', words: wordsFor(-deltaSeconds) };
    problems.push(
      `La charla dura ${fmt(totalSeconds)}: faltan ${-deltaSeconds} s para el mínimo de ${fmt(minSeconds)}. ` +
        `Agrega ~${suggestion.words} palabras al script de la sección "${target.id}" (hoy ${target.words} → ~${target.words + suggestion.words}) y deja las demás igual.`,
    );
  }
  for (const s of sections) {
    if (s.overBySeconds) problems.push(`La sección "${s.id}" dura ${s.seconds} s; su objetivo es ${s.targetSeconds} s (+${s.overBySeconds} s).`);
  }

  return {
    ok: deltaSeconds === 0,
    wordsPerMinute: p.wordsPerMinute,
    budgetSeconds: p.budgetSeconds,
    totalWords,
    totalSeconds,
    deltaSeconds,
    ...(suggestion ? { suggestion } : {}),
    sections,
    problems,
  };
}

export const fmt = (secs: number): string => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
