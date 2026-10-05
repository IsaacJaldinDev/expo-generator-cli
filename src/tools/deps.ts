import type { DeckStore } from '../agent/deck-store.ts';
import type { TraceSink } from '../agent/events.ts';
import type { GuardrailChecker } from '../guardrails/apply.ts';
import type { SourceLibrary } from '../research/search.ts';
import type { Sources } from '../schemas/sources.ts';
import type { DeckRuleParams } from '../validators/deck-rules.ts';

export type Stage = 'research' | 'deck';

/** Dependencias compartidas por las herramientas del agente. */
export interface ToolDeps {
  store: DeckStore;
  params: DeckRuleParams;
  outputDir: string;
  knowledgeDir: string;
  sink: TraceSink;
  /** Presente solo si el guardrail está habilitado. */
  checker?: GuardrailChecker;
  /**
   * Etapa actual (mutable). En "research" (acto 2) el deck no se puede tocar todavía; en "deck" (acto 3+)
   * se escribe, se mide y se valida.
   */
  stage: { current: Stage };
  /** Fuentes permitidas y su biblioteca (allowlist, tiers, descarga). */
  research: { sources: Sources; library: SourceLibrary };
}
