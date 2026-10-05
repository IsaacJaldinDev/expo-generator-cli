import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { ToolDeps } from './deps.ts';

export interface KnowledgeFragment {
  /** `<archivo>#<n>`, p. ej. "notes#3": se usa como knowledgeRef en claims de origen author. */
  id: string;
  heading: string;
  text: string;
}

/** Parte un Markdown en fragmentos (párrafos o ítems de lista) con el encabezado vigente. */
export function fragmentMarkdown(name: string, markdown: string): KnowledgeFragment[] {
  const fragments: KnowledgeFragment[] = [];
  let heading = '';
  for (const block of markdown.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    for (const line of lines.filter((l) => /^#{1,6}\s/.test(l))) heading = line.replace(/^#+\s*/, '').trim();
    const body = lines.filter((l) => !/^#{1,6}\s/.test(l) && !/^<!--.*-->$/.test(l.trim()));
    if (body.length === 0) continue;
    const isList = body.every((l) => /^\s*([-*]|\d+\.)\s/.test(l));
    const pieces = isList ? body.map((l) => l.replace(/^\s*([-*]|\d+\.)\s+/, '')) : [body.join(' ')];
    for (const text of pieces) fragments.push({ id: `${name}#${fragments.length + 1}`, heading, text: text.trim() });
  }
  return fragments;
}

/** Fragmentos de todos los .md de knowledge/ (sin guardrail): para precargar el store en ediciones. */
export function loadKnowledgeFragments(dir: string): KnowledgeFragment[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .flatMap((f) => fragmentMarkdown(basename(f, '.md'), readFileSync(join(dir, f), 'utf8')));
}

export function readKnowledgeTool(deps: ToolDeps) {
  return tool({
    name: 'read_knowledge',
    description:
      'Lee los apuntes del autor (knowledge/*.md) y devuelve fragmentos con id. Úsalo antes de planificar. ' +
      'Los apuntes pasan por Bedrock Guardrails antes de llegar a ti.',
    inputSchema: z.object({}),
    callback: async () => {
      const files = readdirSync(deps.knowledgeDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      const blocked: string[] = [];
      const fragments: KnowledgeFragment[] = [];

      const results = await Promise.all(
        files.map(async (file) => {
          const raw = readFileSync(join(deps.knowledgeDir, file), 'utf8');
          if (!deps.checker) return { file, text: raw, blocked: false };
          // Converse no evalúa resultados de herramientas: los apuntes se revisan aquí como INPUT.
          const r = await deps.checker.check(raw, 'input');
          if (r.interventions.length) deps.sink({ kind: 'guardrail', via: 'apply-guardrail', interventions: r.interventions });
          return { file, text: r.text, blocked: r.blocked };
        }),
      );

      for (const r of results) {
        if (r.blocked) blocked.push(r.file);
        else fragments.push(...fragmentMarkdown(basename(r.file, '.md'), r.text));
      }
      // Solo los fragmentos que pasaron el guardrail pueden citarse como procedencia de autor.
      deps.store.setKnowledge(fragments);
      return {
        ok: blocked.length === 0,
        files: files.length,
        fragments,
        ...(blocked.length
          ? { blockedFiles: blocked, warning: 'Bedrock Guardrails bloqueó estos archivos; no los uses.' }
          : {}),
      };
    },
  });
}
