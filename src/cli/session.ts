import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StructuredOutputError, type AgentResult, type Model } from '@strands-agents/sdk';
import { buildUserMessage, createExpoAgent, STAGE_INSTRUCTIONS, type RunSummary } from '../agent/agent.ts';
import { addUsage, emptyUsage, estimateCostUsd } from '../agent/cost.ts';
import { DeckStore } from '../agent/deck-store.ts';
import type { TraceEvent, TraceSink, UsageTotals } from '../agent/events.ts';
import { NOTES_REVIEW_JSON, NOTES_REVIEW_MD, notesGate, NotesReview, VALID_NOTES_DIR } from '../agent/notes-review.ts';
import { deckParams } from '../agent/params.ts';
import { buildSystemPrompt } from '../agent/system-prompt.ts';
import { createGuardrailChecker, withCostTracking, type GuardrailChecker } from '../guardrails/apply.ts';
import { cachedSystemPrompt, createAgentModel } from '../providers/bedrock.ts';
import { buildRubric, createCritic } from '../providers/critic.ts';
import { httpFetcher } from '../research/pages.ts';
import { SourceLibrary } from '../research/search.ts';
import type { Brief } from '../schemas/brief.ts';
import { activeModel, loadConfig, type Config, type ModelOption } from '../schemas/config.ts';
import type { Deck } from '../schemas/deck.ts';
import { resolveExpo, type Expo } from '../schemas/expo.ts';
import { knowledgeHash } from '../schemas/notes-review.ts';
import type { Stage } from '../tools/deps.ts';
import { loadKnowledgeFragments } from '../tools/read-knowledge.ts';
import { validateDeck, type DeckRuleParams, type DeckValidation } from '../validators/deck-rules.ts';
import { loadFillers } from '../validators/voice-lint.ts';

export const STAGE_TITLES: Record<Stage, string> = {
  research: 'ACTO 2 · huecos y research',
  deck: 'ACTO 3 · plan y validación',
};

export interface SessionOptions {
  /** Nombre de la exposición (input/<expo>.json); por defecto expo.active de config.yml. */
  expo?: string;
  /** Borra los artefactos de output/<expo>/ antes de empezar. */
  fresh?: boolean;
  /** Borra el deck pero conserva claims.json (acto 3 desde cero con la investigación ya hecha). */
  resetDeck?: boolean;
  noGuardrail?: boolean;
  /** Instrucción de edición; con un deck existente activa la edición puntual. */
  instruction?: string;
  scope?: string[];
  stages?: Stage[];
  /** Etiqueta del acto para runs.jsonl. */
  act: string;
  /** Envoltorios para grabar o reproducir (cassettes). */
  wrapModel?: (m: Model) => Model;
  wrapChecker?: (c: GuardrailChecker) => GuardrailChecker;
  sink: TraceSink;
}

export interface SessionOutcome {
  ok: boolean;
  seconds: number;
  stages: { stage: Stage; seconds: number; ok: boolean }[];
  error?: string;
  validation: DeckValidation;
  usage: UsageTotals;
  costUsd: number;
}

export interface Session {
  cfg: Config;
  expo: Expo;
  /** Revisión de los apuntes contra las fuentes (acto 2). */
  notes: NotesReview;
  brief: Brief;
  model: ModelOption & { key: string };
  store: DeckStore;
  params: DeckRuleParams;
  stages: Stage[];
  instruction: string;
  /** Copia del deck al iniciar: base del diff de la edición. */
  deckBefore: Deck;
  isEdit: boolean;
  usage(): UsageTotals;
  /** Costo acumulado de ApplyGuardrail en esta sesión. */
  guardrailUsd(): number;
  run(): Promise<SessionOutcome>;
}

const OUTPUT_FILES = ['deck.json', 'claims.json', 'script.md', 'timing.md', NOTES_REVIEW_JSON, NOTES_REVIEW_MD, VALID_NOTES_DIR];

/** Arma todo lo necesario para una ejecución del agente. No imprime nada: emite eventos al sink. */
export function createSession(opts: SessionOptions): Session {
  const cfg = loadConfig();
  if (opts.noGuardrail) cfg.guardrail.enabled = false;
  const expo = resolveExpo(opts.expo ?? cfg.expo.active);
  const { brief, sources, outputDir } = expo;
  const model = activeModel(cfg);
  const params = deckParams(cfg, brief, expo.brand, sources, loadFillers());
  const critic = createCritic(
    cfg.critic.provider,
    () => createAgentModel(cfg, { guardrail: false, ...(cfg.critic.model ? { modelKey: cfg.critic.model } : {}) }),
    buildRubric(readFileSync('voice/examples.md', 'utf8'), readFileSync('voice/anti-patterns.md', 'utf8')),
  );

  if (opts.fresh) for (const f of OUTPUT_FILES) rmSync(join(outputDir, f), { force: true, recursive: true });
  else if (opts.resetDeck) for (const f of ['deck.json', 'script.md', 'timing.md']) rmSync(join(outputDir, f), { force: true });

  const store = DeckStore.load(outputDir, brief.title);
  // En ediciones el agente puede no llamar read_knowledge: precarga los fragmentos para verificar citas a los apuntes.
  const rawFragments = loadKnowledgeFragments(expo.knowledgeDir);
  store.setKnowledge(rawFragments);
  const notes = new NotesReview(cfg.notesReview.stopOn, knowledgeHash(rawFragments));
  const notesContext = { expo: expo.name, knowledgeDir: expo.knowledgeDir ?? `knowledge/${expo.name}`, topics: sources.topics };
  const hasDeck = store.deck.sections.length > 0;
  const instructionArg = opts.instruction?.trim() ?? '';
  const isEdit = hasDeck && instructionArg !== '';
  if (isEdit) store.startEdit(opts.scope ?? []);
  const stages: Stage[] = opts.stages ?? (hasDeck ? ['deck'] : ['research', 'deck']);
  const stage: { current: Stage } = { current: stages[0]! };
  const instruction =
    instructionArg || (hasDeck ? 'Revisa la exposición y deja todo validado.' : 'Prepara la exposición completa a partir del brief y de mis apuntes.');
  const deckBefore = structuredClone(store.deck);

  let usage = emptyUsage();
  let guardrailUsd = 0;
  const sink = (e: TraceEvent) => {
    if (e.kind === 'model-call' && e.usage) usage = addUsage(usage, e.usage);
    if (e.kind === 'guardrail-usage') guardrailUsd += e.costUsd;
    opts.sink(e);
  };
  const checker: GuardrailChecker | undefined = cfg.guardrail.enabled
    ? withCostTracking(opts.wrapChecker ? opts.wrapChecker(createGuardrailChecker(cfg)) : createGuardrailChecker(cfg), (costUsd) =>
        sink({ kind: 'guardrail-usage', costUsd }),
      )
    : undefined;

  const { agent, abort, gate, invokeOptions } = createExpoAgent({
    model: opts.wrapModel ? opts.wrapModel(createAgentModel(cfg)) : createAgentModel(cfg),
    systemPrompt: cachedSystemPrompt(cfg, buildSystemPrompt(brief, params)),
    store,
    params,
    outputDir,
    knowledgeDir: expo.knowledgeDir,
    notes,
    notesContext,
    research: { sources, library: new SourceLibrary(sources, httpFetcher(sources.limits.fetchTimeoutMs)) },
    critic: { provider: critic, maxCalls: cfg.critic.maxCalls },
    stage,
    sink,
    ...(checker ? { checker } : {}),
    maxRevisionRounds: cfg.agent.maxRevisionRounds,
    structuredOutputRetries: cfg.agent.structuredOutputRetries,
    maxTurns: cfg.agent.maxTurns,
    maxToolCalls: cfg.agent.maxToolCalls,
  });

  /** Ejecuta una etapa. Devuelve si hay que detener las siguientes. */
  async function runStage(s: Stage): Promise<{ ok: boolean; stop: boolean; seconds: number }> {
    stage.current = s;
    gate.reset();
    const t = performance.now();
    sink({ kind: 'stage-start', stage: s, title: STAGE_TITLES[s] });
    const message = isEdit
      ? buildUserMessage(instruction, store.deck, { claims: store.claims }, true)
      : buildUserMessage(STAGE_INSTRUCTIONS[s], store.deck, { claims: store.claims }, s === 'deck');

    let result: AgentResult | undefined;
    let warning: string | undefined;
    try {
      result = await agent.invoke(message, invokeOptions);
    } catch (err) {
      // El resumen estructurado es cosmético: el estado (deck/claims) lo valida la compuerta.
      if (!(err instanceof StructuredOutputError)) throw err;
      warning = 'El modelo no entregó el resumen estructurado.';
    }
    if (result?.stopReason === 'cancelled' && abort.signal.reason instanceof Error) throw abort.signal.reason;

    const stopReason = result?.stopReason ?? 'structuredOutputError';
    if (stopReason === 'limitTurns') warning = `Tope de ${cfg.agent.maxTurns} turnos alcanzado: el agente se detuvo.`;
    if (stopReason === 'guardrailIntervened') warning = `Bedrock Guardrails detuvo la ejecución: ${String(result)}`;
    let ok = gate.lastResult?.ok ?? false;
    const problems = [...(gate.lastResult?.problems ?? [])];
    // Un apunte inconsistente detiene el proceso: el autor lo corrige a mano (revision-apuntes.md).
    const blocking = s === 'research' ? notes.blocking() : [];
    if (blocking.length) {
      ok = false;
      problems.push(...blocking.map((r) => `Apunte ${r.verdict} ${r.fragmentId} «${r.text.slice(0, 70)}»`));
      warning = `Tus apuntes tienen ${blocking.length} punto(s) por revisar: ${join(outputDir, NOTES_REVIEW_MD)}`;
    }
    const seconds = (performance.now() - t) / 1000;
    const summary = (result?.structuredOutput as RunSummary | undefined)?.summary;
    sink({
      kind: 'stage-end',
      stage: s,
      seconds,
      stopReason,
      ok,
      problems,
      ...(summary ? { summary } : {}),
      ...(warning ? { warning } : {}),
    });
    return { ok, stop: !ok || stopReason === 'limitTurns' || stopReason === 'guardrailIntervened', seconds };
  }

  return {
    cfg,
    expo,
    notes,
    brief,
    model,
    store,
    params,
    stages,
    instruction,
    deckBefore,
    isEdit,
    usage: () => usage,
    guardrailUsd: () => guardrailUsd,
    async run() {
      const t0 = performance.now();
      const done: SessionOutcome['stages'] = [];
      let error: string | undefined;
      try {
        for (const s of stages) {
          // El deck nuevo solo se escribe sobre apuntes revisados y sin inconsistencias.
          if (s === 'deck' && !isEdit && !done.some((d) => d.stage === 'research')) {
            const g = notesGate(rawFragments, outputDir, cfg.notesReview.stopOn);
            if (!g.ok) throw new Error(g.reason);
          }
          const r = await runStage(s);
          done.push({ stage: s, seconds: r.seconds, ok: r.ok });
          if (r.stop) break;
        }
      } catch (err) {
        error = `${(err as Error).name}: ${(err as Error).message}`;
      }
      store.save(outputDir, params);
      notes.save(outputDir, notesContext);
      const validation = validateDeck(store.deck, store.claims, params);
      const seconds = (performance.now() - t0) / 1000;
      const costUsd = estimateCostUsd(usage, model.pricing) + guardrailUsd;
      const ok = !error && done.length === stages.length && done.every((d) => d.ok);
      recordRun({ at: new Date().toISOString(), act: opts.act, expo: expo.name, model: model.key, modelId: model.modelId, seconds, stages: done, usage, costUsd, ok });
      return { ok, seconds, stages: done, ...(error ? { error } : {}), validation, usage, costUsd };
    },
  };
}

export interface RunRecord {
  at: string;
  act: string;
  /** Exposición (input/<expo>.json). Las corridas anteriores a la fase 6b no lo tienen. */
  expo?: string;
  model: string;
  modelId: string;
  seconds: number;
  stages: { stage: string; seconds: number; ok: boolean }[];
  usage: UsageTotals;
  costUsd: number;
  ok: boolean;
}

/**
 * Historial de ejecuciones de todas las exposiciones (output/runs.jsonl): duración por acto (¿en vivo o en
 * video?) y costo por modelo (acto 5), que no depende del tema.
 */
export const RUNS_FILE = 'output/runs.jsonl';

export function recordRun(r: RunRecord, file = RUNS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(r) + '\n');
}

export function loadRuns(file = RUNS_FILE): RunRecord[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunRecord);
  } catch {
    return [];
  }
}
