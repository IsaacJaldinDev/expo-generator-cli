import type { DeckStore } from '../agent/deck-store.ts';
import type { NotesReview } from '../agent/notes-review.ts';
import type { TraceSink } from '../agent/events.ts';
import type { GuardrailChecker } from '../guardrails/apply.ts';
import type { CriticModelProvider } from '../providers/critic.ts';
import type { SourceLibrary } from '../research/search.ts';
import type { Sources } from '../schemas/sources.ts';
import type { DeckRuleParams } from '../validators/deck-rules.ts';

export type Stage = 'research' | 'deck';

/** Dependencias compartidas por las herramientas del agente. */
export interface ToolDeps {
  store: DeckStore;
  params: DeckRuleParams;
  outputDir: string;
  /** knowledge/<expo>/; undefined = sin apuntes locales. */
  knowledgeDir: string | undefined;
  sink: TraceSink;
  /** Presente solo si el guardrail está habilitado. */
  checker?: GuardrailChecker;
  /**
   * Etapa actual (mutable). En "research" (acto 2) el deck no se puede tocar todavía; en "deck" (acto 3+)
   * se escribe, se mide y se valida.
   */
  stage: { current: Stage };
  /** Crítico de voz (llamada separada). Ausente = critique_voice responde "deshabilitada". */
  critic?: { provider: CriticModelProvider; maxCalls: number };
  /** Revisión de los apuntes contra las fuentes (acto 2). */
  notes: NotesReview;
  /** Datos de la exposición para los archivos de la revisión. */
  notesContext: { expo: string; knowledgeDir: string; topics: string[] };
  /** Fuentes permitidas y su biblioteca (allowlist, tiers, descarga). */
  research: { sources: Sources; library: SourceLibrary };
}
