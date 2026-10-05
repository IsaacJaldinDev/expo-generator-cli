import type { Claim } from '../schemas/claims.ts';
import type { Deck } from '../schemas/deck.ts';
import { claimMarkers } from '../validators/text.ts';
import { checkTiming, fmt, type TimingParams } from '../validators/timing.ts';

const KIND_LABEL = { hook: 'Hook', body: 'Desarrollo', close: 'Cierre' } as const;

/** deck.json → script.md. Los marcadores [^id] quedan como notas al pie de GitHub Markdown. */
export function renderScript(deck: Deck, claims: Claim[], timing: TimingParams): string {
  const report = checkTiming(deck, timing);
  const byId = new Map(report.sections.map((s) => [s.id, s]));
  const out: string[] = [
    `# ${deck.title}`,
    '',
    `> Generado desde \`deck.json\`: no editar a mano. Duración estimada **${fmt(report.totalSeconds)}** de ${fmt(report.budgetSeconds)} · ${report.wordsPerMinute} palabras/min`,
    '',
  ];

  deck.sections.forEach((section, i) => {
    const t = byId.get(section.id);
    const target = section.targetSeconds !== undefined ? ` / objetivo ${fmt(section.targetSeconds)}` : '';
    out.push(`## ${i + 1}. ${KIND_LABEL[section.kind]} — ${section.title}`, '');
    out.push(`*${section.goal}* · ${fmt(t?.seconds ?? 0)}${target}`, '');
    section.slides.forEach((slide, j) => {
      out.push(`### Slide ${i + 1}.${j + 1} · ${slide.title}`, '');
      out.push(`*Propósito:* ${slide.purpose}`, '');
      if (slide.bullets.length) {
        out.push('**En pantalla:**', ...slide.bullets.map((b) => `- ${b}`), '');
      }
      out.push(slide.script, '');
    });
  });

  const cited = [...new Set(deck.sections.flatMap((s) => s.slides.flatMap((sl) => claimMarkers(sl.script))))];
  if (cited.length) {
    const byClaim = new Map(claims.map((c) => [c.id, c]));
    out.push('## Fuentes', '');
    for (const id of cited) {
      const c = byClaim.get(id);
      out.push(`[^${id}]: ${c ? describeClaim(c) : '⚠️ claim inexistente en claims.json'}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function describeClaim(c: Claim): string {
  if (c.origin === 'author') return `${c.text} — apuntes del autor${c.knowledgeRef ? ` (${c.knowledgeRef})` : ''}`;
  const status = c.verified ? '✓ verificado' : '✗ sin verificar';
  return `${c.text} — ${c.sourceUrl} (${c.sourceTier ?? 'sin tier'}, ${status})`;
}
