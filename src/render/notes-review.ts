import type { NoteReview, NotesReviewFile, NoteVerdict } from '../schemas/notes-review.ts';
import type { KnowledgeFragment } from '../tools/read-knowledge.ts';

const fileOf = (id: string) => id.split('#')[0]!;
const quoteBlock = (text: string) => text.split('\n').map((l) => `> ${l}`).join('\n');
const decided = (r: NoteReview) => (r.decidedBy === 'codigo' ? 'comprobado en código' : 'señalado por el modelo: compruébalo tú');

/** revision-apuntes.md: el resumen para el autor. Lo que hay que corregir primero, después lo que está bien. */
export function renderNotesReview(
  file: NotesReviewFile,
  fragments: KnowledgeFragment[],
  ctx: { expo: string; knowledgeDir: string; topics: string[]; stopOn: NoteVerdict[] },
): string {
  const by = (v: NoteVerdict) => file.reviews.filter((r) => r.verdict === v);
  const blocking = file.reviews.filter((r) => ctx.stopOn.includes(r.verdict));
  const heading = (id: string) => fragments.find((f) => f.id === id)?.heading;

  const out: string[] = [
    `# Revisión de apuntes · ${ctx.expo}`,
    '',
    `${file.reviewedAt.slice(0, 10)} · apuntes: \`${ctx.knowledgeDir}/\` · fuentes: ${ctx.topics.join(', ')}`,
    '',
    `**Resultado:** ✓ ${by('confirmado').length} confirmados · ✗ ${by('inconsistente').length} inconsistentes · ` +
      `${file.own.length} propios (ideas, experiencias u opiniones: no requieren fuente)`,
    '',
    file.pending.length
      ? `**La revisión quedó incompleta**: faltan ${file.pending.join(', ')}. Vuelve a correr el acto 2.`
      : blocking.length
      ? `**El proceso se detuvo.** Corrige ${blocking.length === 1 ? 'el apunte marcado' : `los ${blocking.length} apuntes marcados`} en \`${ctx.knowledgeDir}/\` y vuelve a correr el acto 2.`
      : '**Los apuntes pasaron la revisión.** El acto 3 puede usarlos.',
    '',
  ];

  const inconsistent = by('inconsistente');
  if (inconsistent.length) {
    out.push('## ✗ Inconsistencias: revisar antes de seguir', '');
    for (const r of inconsistent) {
      out.push(`### ${r.fragmentId}${heading(r.fragmentId) ? ` · ${heading(r.fragmentId)}` : ''}`, '', quoteBlock(r.text), '');
      if (r.sourceUrl) out.push(`- **Fuente** (${r.sourceTier ?? '?'}): ${r.sourceUrl}`);
      if (r.passage) out.push(`- **Lo que dice la fuente:** «${r.passage}»`);
      for (const reason of r.reasons) out.push(`- ${reason}`);
      out.push(`- _${decided(r)}_`, '');
    }
  }

  const confirmed = by('confirmado');
  if (confirmed.length) {
    out.push('## ✓ Confirmados por una fuente', '');
    for (const r of confirmed) {
      const score = r.groundingScore !== undefined ? `, grounding ${r.groundingScore.toFixed(2)}` : '';
      out.push(`- **${r.fragmentId}** «${r.text}» — ${r.sourceUrl} (${r.sourceTier}${score})${r.claimId ? ` · claim ${r.claimId}` : ''}`);
    }
    out.push('');
  }


  out.push(
    '## Listo para usar',
    '',
    `\`apuntes-validos/\` tiene tus apuntes sin los que están marcados (✗ y ?), con el mismo formato y la fuente de los confirmados ` +
      `como comentario. Cópialos a \`${ctx.knowledgeDir}/\`, agrega tus correcciones y vuelve a correr el acto 2.`,
    '',
  );
  return out.join('\n');
}

/**
 * apuntes-validos/<archivo>.md: los fragmentos confirmados y los propios, agrupados por encabezado, listos para
 * copiar. La fuente de un confirmado va como comentario HTML: read_knowledge ignora esas líneas.
 */
export function renderValidNotes(fragments: KnowledgeFragment[], file: Pick<NotesReviewFile, 'reviews' | 'own'>): Map<string, string> {
  const byId = new Map(file.reviews.map((r) => [r.fragmentId, r]));
  const own = new Set(file.own);
  const files = new Map<string, string[]>();
  const lastHeading = new Map<string, string>();
  for (const f of fragments) {
    const r = byId.get(f.id);
    // Todo menos lo inconsistente (y lo que el agente no llegó a cubrir): confirmado, propio o sin verificar.
    if (r ? r.verdict === 'inconsistente' : !own.has(f.id)) continue;
    const name = fileOf(f.id);
    const lines = files.get(name) ?? [];
    if (f.heading && lastHeading.get(name) !== f.heading) {
      lines.push(`# ${f.heading}`, '');
      lastHeading.set(name, f.heading);
    }
    lines.push(f.text);
    if (r?.verdict === 'confirmado') lines.push(`<!-- confirmado: ${r.sourceUrl} -->`);
    lines.push('');
    files.set(name, lines);
  }
  return new Map([...files].map(([name, lines]) => [name, lines.join('\n')]));
}
