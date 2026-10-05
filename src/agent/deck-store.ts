import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaimsFileSchema, type Claim } from '../schemas/claims.ts';
import { DeckSchema, emptyDeck, SectionSchema, type Deck, type Section, type SectionPatch } from '../schemas/deck.ts';
import { claimMarkers } from '../validators/text.ts';
import { renderScript } from '../render/script.ts';
import { renderTiming } from '../render/timing.ts';
import type { DeckRuleParams } from '../validators/deck-rules.ts';

export interface SectionChange {
  sectionId: string;
  action: 'created' | 'updated' | 'removed';
  before?: Section;
  after?: Section;
}

/** "semana? [^c1] Es algo" → "semana?[^c1] Es algo": el marcador queda pegado a la oración que respalda. */
export const attachMarkers = (script: string): string => script.replace(/\s+(\[\^[^\]\s]+\])/g, '$1');

/**
 * Estado de la tarea: deck.json + claims.json. Única puerta de escritura del deck.
 * El LLM nunca reescribe el deck completo: cada cambio es un parche a una sección.
 */
export const KNOWLEDGE_REF = /^[a-z0-9-]+#\d+$/;

export class DeckStore {
  readonly changes: SectionChange[] = [];
  /** Fragmentos de knowledge/ por id: permiten verificar en código las citas a los apuntes. */
  private knowledge = new Map<string, string>();
  /**
   * Alcance de una edición puntual. Si existe, solo esas secciones se pueden modificar; si está vacío,
   * la primera sección modificada lo fija. "Modifica solo lo necesario" lo garantiza el código, no el prompt.
   */
  editScope: Set<string> | undefined;

  startEdit(scope: string[] = []): void {
    this.editScope = new Set(scope);
  }

  constructor(
    public deck: Deck,
    public claims: Claim[] = [],
  ) {}

  static load(outputDir: string, title: string): DeckStore {
    const deckPath = join(outputDir, 'deck.json');
    const claimsPath = join(outputDir, 'claims.json');
    const deck = existsSync(deckPath) ? DeckSchema.parse(JSON.parse(readFileSync(deckPath, 'utf8'))) : emptyDeck(title);
    const claims = existsSync(claimsPath)
      ? ClaimsFileSchema.parse(JSON.parse(readFileSync(claimsPath, 'utf8'))).claims
      : [];
    return new DeckStore(deck, claims);
  }

  /** Registra un claim externo con id determinista `c-<n>`. `verified` y `sourceTier` los calcula quien llama, en código. */
  addExternalClaim(c: {
    text: string;
    sourceUrl: string;
    sourceTier: string;
    quote: string;
    verified: boolean;
    checks: { quoteFound: boolean; numbersMatch: boolean; grounded?: boolean; groundingScore?: number };
  }): Claim {
    const n = this.claims.filter((x) => x.origin === 'external').length + 1;
    let id = `c-${n}`;
    for (let k = n; this.claims.some((x) => x.id === id); k++) id = `c-${k + 1}`;
    const claim: Claim = { id, origin: 'external', ...c, retrievedAt: new Date().toISOString() };
    this.claims.push(claim);
    return claim;
  }

  setKnowledge(fragments: { id: string; text: string }[]): void {
    this.knowledge = new Map(fragments.map((f) => [f.id, f.text]));
  }

  /**
   * Un marcador a un fragmento de los apuntes ([^notes#3]) es procedencia de autor: se registra en
   * claims.json con origin=author. verified lo calcula el código: el fragmento existe en knowledge/.
   */
  private registerAuthorClaims(section: Section): void {
    for (const id of section.slides.flatMap((s) => claimMarkers(s.script))) {
      if (!KNOWLEDGE_REF.test(id) || this.claims.some((c) => c.id === id)) continue;
      const text = this.knowledge.get(id);
      if (text === undefined) continue; // validate_deck lo reporta como claim inexistente
      this.claims.push({ id, text, origin: 'author', knowledgeRef: id, verified: true });
    }
  }

  /**
   * Los objetivos por sección son aritmética: se corrigen en código, no se le piden al LLM.
   * Si suman más que la charla, se escalan proporcionalmente (múltiplos de 5 s). Devuelve true si escaló.
   */
  normalizeTargets(budgetSeconds: number): boolean {
    const withTarget = this.deck.sections.filter((s) => s.targetSeconds !== undefined);
    const sum = withTarget.reduce((n, s) => n + s.targetSeconds!, 0);
    if (sum <= budgetSeconds) return false;
    const factor = budgetSeconds / sum;
    for (const s of withTarget) s.targetSeconds = Math.max(5, Math.floor((s.targetSeconds! * factor) / 5) * 5);
    return true;
  }

  section(id: string): Section | undefined {
    return this.deck.sections.find((s) => s.id === id);
  }

  /** Aplica un parche validado a UNA sección. Lanza un Error legible si el parche no es aplicable. */
  applyPatch(patch: SectionPatch): SectionChange {
    if (this.editScope) {
      if (this.editScope.size === 0) this.editScope.add(patch.sectionId);
      else if (!this.editScope.has(patch.sectionId)) {
        const scope = [...this.editScope].map((s) => `"${s}"`).join(', ');
        throw new Error(
          `Edición puntual: solo puedes modificar ${scope}. No toques "${patch.sectionId}"; si el tiempo no cuadra, ajusta ${scope}.`,
        );
      }
    }
    const idx = this.deck.sections.findIndex((s) => s.id === patch.sectionId);
    const before = idx >= 0 ? structuredClone(this.deck.sections[idx]!) : undefined;

    if (patch.remove) {
      if (!before) throw new Error(`No existe la sección "${patch.sectionId}".`);
      this.deck.sections.splice(idx, 1);
      return this.record({ sectionId: patch.sectionId, action: 'removed', before });
    }

    if (!before) {
      const missing = (['kind', 'title', 'goal', 'slides'] as const).filter((k) => patch[k] === undefined);
      if (missing.length) {
        throw new Error(`La sección "${patch.sectionId}" es nueva: faltan los campos ${missing.join(', ')}.`);
      }
    }

    const base: Section = before ?? { id: patch.sectionId, kind: patch.kind!, title: '', goal: '', slides: [] };
    const next: Section = {
      ...base,
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.targetSeconds !== undefined ? { targetSeconds: patch.targetSeconds } : {}),
      ...(patch.slides !== undefined
        ? { slides: patch.slides.map((s, i) => ({ ...s, script: attachMarkers(s.script), id: `${patch.sectionId}-${i + 1}` })) }
        : {}),
    };
    const after = SectionSchema.parse(next);
    this.registerAuthorClaims(after);

    if (before) {
      this.deck.sections[idx] = after;
    } else {
      const pos = Math.min(patch.position ?? this.deck.sections.length, this.deck.sections.length);
      this.deck.sections.splice(pos, 0, after);
    }
    return this.record({ sectionId: patch.sectionId, action: before ? 'updated' : 'created', before, after });
  }

  /** Escribe deck.json + claims.json y re-renderiza script.md y timing.md: siempre consistentes entre sí. */
  save(outputDir: string, params: DeckRuleParams): void {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'deck.json'), JSON.stringify(this.deck, null, 2) + '\n');
    writeFileSync(join(outputDir, 'claims.json'), JSON.stringify({ claims: this.claims }, null, 2) + '\n');
    writeFileSync(join(outputDir, 'script.md'), renderScript(this.deck, this.claims, params));
    writeFileSync(join(outputDir, 'timing.md'), renderTiming(this.deck, params));
  }

  private record(change: SectionChange): SectionChange {
    this.changes.push(change);
    return change;
  }
}
