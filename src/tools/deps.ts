import type { DeckStore } from '../agent/deck-store.ts';
import type { TraceSink } from '../agent/events.ts';
import type { GuardrailChecker } from '../guardrails/apply.ts';
import type { DeckRuleParams } from '../validators/deck-rules.ts';

/** Dependencias compartidas por las herramientas del agente. */
export interface ToolDeps {
  store: DeckStore;
  params: DeckRuleParams;
  outputDir: string;
  knowledgeDir: string;
  sink: TraceSink;
  /** Presente solo si el guardrail está habilitado. */
  checker?: GuardrailChecker;
}
