import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderNotesReview, renderValidNotes } from '../render/notes-review.ts';
import { knowledgeHash, NotesReviewFileSchema, type NoteReview, type NotesReviewFile, type NoteVerdict } from '../schemas/notes-review.ts';
import type { KnowledgeFragment } from '../tools/read-knowledge.ts';
import { looksLikeExternalFact } from '../validators/text.ts';

export const NOTES_REVIEW_JSON = 'notes-review.json';
export const NOTES_REVIEW_MD = 'revision-apuntes.md';
export const VALID_NOTES_DIR = 'apuntes-validos';

/**
 * Estado de la revisión de apuntes (acto 2). Los fragmentos son los que pasaron el guardrail en read_knowledge.
 * Cobertura total, exigida en código: cada fragmento queda revisado contra una fuente (review_note) o marcado
 * como propio (mark_own_notes: idea, experiencia u opinión). Un fragmento que parece dato (cifras, %, años)
 * no se puede marcar como propio.
 */
export class NotesReview {
  fragments: KnowledgeFragment[] = [];
  /** read_knowledge ya corrió en esta ejecución. */
  loaded = false;
  private reviews = new Map<string, NoteReview>();
  private own = new Set<string>();

  /**
   * @param rawHash huella de los apuntes tal como están en disco (antes del guardrail, que puede enmascarar texto):
   *                es la que compara notesGate en el acto 3.
   */
  constructor(
    readonly stopOn: NoteVerdict[],
    private readonly rawHash: string,
  ) {}

  setFragments(fragments: KnowledgeFragment[]): void {
    this.fragments = fragments;
    this.loaded = true;
    const ids = new Set(fragments.map((f) => f.id));
    for (const id of this.reviews.keys()) if (!ids.has(id)) this.reviews.delete(id);
    for (const id of this.own) if (!ids.has(id)) this.own.delete(id);
  }

  fragment(id: string): KnowledgeFragment | undefined {
    return this.fragments.find((f) => f.id === id);
  }

  /** Revisar de nuevo un fragmento reemplaza la revisión anterior. */
  record(review: NoteReview): void {
    this.reviews.set(review.fragmentId, review);
    this.own.delete(review.fragmentId);
  }

  /** Marca fragmentos como propios del autor (no requieren fuente). Rechaza los que parecen datos o ya se revisaron. */
  markOwn(ids: string[]): { accepted: string[]; refused: { id: string; reason: string }[] } {
    const accepted: string[] = [];
    const refused: { id: string; reason: string }[] = [];
    for (const id of ids) {
      const f = this.fragment(id);
      if (!f) refused.push({ id, reason: 'no existe' });
      else if (looksLikeExternalFact(f.text)) refused.push({ id, reason: 'tiene cifras, porcentajes o años: revísalo con review_note' });
      else if (this.reviews.has(id)) refused.push({ id, reason: 'ya está revisado contra una fuente' });
      else {
        this.own.add(id);
        accepted.push(id);
      }
    }
    return { accepted, refused };
  }

  ownIds(): string[] {
    return this.fragments.filter((f) => this.own.has(f.id)).map((f) => f.id);
  }

  /** Revisiones en el orden de los apuntes. */
  list(): NoteReview[] {
    return this.fragments.flatMap((f) => this.reviews.get(f.id) ?? []);
  }

  /** Fragmentos sin revisar ni marcar como propios. */
  pending(): KnowledgeFragment[] {
    return this.fragments.filter((f) => !this.reviews.has(f.id) && !this.own.has(f.id));
  }

  /** Revisiones que detienen el proceso (config: notesReview.stopOn). */
  blocking(): NoteReview[] {
    return this.list().filter((r) => this.stopOn.includes(r.verdict));
  }

  file(): NotesReviewFile {
    return { knowledgeHash: this.rawHash, reviewedAt: new Date().toISOString(), reviews: this.list(), own: this.ownIds(), pending: this.pending().map((f) => f.id) };
  }

  /** notes-review.json (contrato) + revision-apuntes.md (para el autor) + apuntes-validos/ (para copiar y pegar). */
  save(outputDir: string, ctx: { expo: string; knowledgeDir: string; topics: string[] }): void {
    if (!this.loaded || this.fragments.length === 0) return;
    mkdirSync(outputDir, { recursive: true });
    const file = this.file();
    writeFileSync(join(outputDir, NOTES_REVIEW_JSON), JSON.stringify(file, null, 2) + '\n');
    writeFileSync(join(outputDir, NOTES_REVIEW_MD), renderNotesReview(file, this.fragments, { ...ctx, stopOn: this.stopOn }));
    const validDir = join(outputDir, VALID_NOTES_DIR);
    rmSync(validDir, { recursive: true, force: true });
    mkdirSync(validDir);
    for (const [name, md] of renderValidNotes(this.fragments, file)) writeFileSync(join(validDir, `${name}.md`), md);
  }
}

export function loadNotesReview(outputDir: string): NotesReviewFile | undefined {
  const p = join(outputDir, NOTES_REVIEW_JSON);
  return existsSync(p) ? NotesReviewFileSchema.parse(JSON.parse(readFileSync(p, 'utf8'))) : undefined;
}

/**
 * ¿Se puede escribir el deck (acto 3) con estos apuntes? Sin apuntes, sí. Con apuntes: tiene que haber una
 * revisión del acto 2 de exactamente estos apuntes y sin veredictos que detengan el proceso.
 */
export function notesGate(fragments: KnowledgeFragment[], outputDir: string, stopOn: NoteVerdict[]): { ok: true } | { ok: false; reason: string } {
  if (fragments.length === 0) return { ok: true };
  const review = loadNotesReview(outputDir);
  if (!review) return { ok: false, reason: 'Tus apuntes todavía no se revisaron contra las fuentes: corre primero el acto 2 (research).' };
  if (review.knowledgeHash !== knowledgeHash(fragments)) {
    return { ok: false, reason: 'Tus apuntes cambiaron desde la última revisión: corre otra vez el acto 2 (research) para revisarlos.' };
  }
  if (review.pending.length) {
    return { ok: false, reason: `La revisión de tus apuntes quedó incompleta (faltan ${review.pending.join(', ')}): corre otra vez el acto 2.` };
  }
  const blocking = review.reviews.filter((r) => stopOn.includes(r.verdict));
  if (blocking.length) {
    return {
      ok: false,
      reason: `Hay ${blocking.length} apunte(s) por corregir (${blocking.map((r) => r.fragmentId).join(', ')}). Revisa ${join(outputDir, NOTES_REVIEW_MD)}, corrige tus apuntes y vuelve a correr el acto 2.`,
    };
  }
  return { ok: true };
}
