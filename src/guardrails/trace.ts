import { z } from 'zod';

/**
 * Normaliza las evaluaciones de Bedrock Guardrails (traza de Converse o `assessments` de
 * ApplyGuardrail) a una lista de intervenciones legibles para la vista de trazas.
 * Shapes según https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailAssessment.html
 */

export type GuardrailSource = 'input' | 'output';
export type GuardrailPolicy =
  | 'contenido'
  | 'prompt-attack'
  | 'tema-denegado'
  | 'palabras'
  | 'datos-sensibles'
  | 'grounding';

export interface GuardrailIntervention {
  source: GuardrailSource;
  policy: GuardrailPolicy;
  /** Qué disparó la política (tipo de filtro, nombre del tema, entidad PII…). */
  detail: string;
  /** BLOCKED | ANONYMIZED | NONE (detectado sin acción) */
  action: string;
  /** Fragmento que activó la política, cuando Bedrock lo devuelve (match / regex). */
  match?: string;
}

const Action = z.string().optional();
const Detected = z.boolean().optional();

const AssessmentSchema = z
  .object({
    contentPolicy: z
      .object({
        filters: z
          .array(z.object({ type: z.string(), confidence: z.string().optional(), action: Action, detected: Detected }).loose())
          .default([]),
      })
      .loose()
      .optional(),
    topicPolicy: z
      .object({
        topics: z.array(z.object({ name: z.string(), action: Action, detected: Detected }).loose()).default([]),
      })
      .loose()
      .optional(),
    wordPolicy: z
      .object({
        customWords: z.array(z.object({ match: z.string(), action: Action, detected: Detected }).loose()).default([]),
        managedWordLists: z
          .array(z.object({ match: z.string(), type: z.string().optional(), action: Action, detected: Detected }).loose())
          .default([]),
      })
      .loose()
      .optional(),
    sensitiveInformationPolicy: z
      .object({
        piiEntities: z
          .array(z.object({ type: z.string(), match: z.string().optional(), action: Action, detected: Detected }).loose())
          .default([]),
        regexes: z
          .array(z.object({ name: z.string().optional(), match: z.string().optional(), action: Action, detected: Detected }).loose())
          .default([]),
      })
      .loose()
      .optional(),
    contextualGroundingPolicy: z
      .object({
        filters: z
          .array(z.object({ type: z.string(), score: z.number().optional(), threshold: z.number().optional(), action: Action, detected: Detected }).loose())
          .default([]),
      })
      .loose()
      .optional(),
  })
  .loose();

type Assessment = z.infer<typeof AssessmentSchema>;

/** Un filtro intervino si su acción no es NONE, o si `detected` es true (modo solo-detección). */
const fired = (f: { action?: string | undefined; detected?: boolean | undefined }): boolean =>
  (f.action !== undefined && f.action !== 'NONE') || f.detected === true;

export function assessmentToInterventions(raw: unknown, source: GuardrailSource): GuardrailIntervention[] {
  const parsed = AssessmentSchema.safeParse(raw);
  if (!parsed.success) return [];
  const a: Assessment = parsed.data;
  const out: GuardrailIntervention[] = [];
  const act = (x?: string) => x ?? 'NONE';

  for (const f of a.contentPolicy?.filters ?? []) {
    if (!fired(f)) continue;
    out.push({
      source,
      policy: f.type === 'PROMPT_ATTACK' ? 'prompt-attack' : 'contenido',
      detail: f.confidence ? `${f.type} (confianza ${f.confidence})` : f.type,
      action: act(f.action),
    });
  }
  for (const t of a.topicPolicy?.topics ?? []) {
    if (fired(t)) out.push({ source, policy: 'tema-denegado', detail: t.name, action: act(t.action) });
  }
  for (const w of [...(a.wordPolicy?.customWords ?? []), ...(a.wordPolicy?.managedWordLists ?? [])]) {
    if (fired(w)) out.push({ source, policy: 'palabras', detail: 'palabra filtrada', action: act(w.action), match: w.match });
  }
  for (const p of a.sensitiveInformationPolicy?.piiEntities ?? []) {
    if (fired(p)) out.push({ source, policy: 'datos-sensibles', detail: p.type, action: act(p.action), ...(p.match ? { match: p.match } : {}) });
  }
  for (const r of a.sensitiveInformationPolicy?.regexes ?? []) {
    if (fired(r)) out.push({ source, policy: 'datos-sensibles', detail: r.name ?? 'regex', action: act(r.action), ...(r.match ? { match: r.match } : {}) });
  }
  for (const g of a.contextualGroundingPolicy?.filters ?? []) {
    if (!fired(g)) continue;
    const score = g.score !== undefined && g.threshold !== undefined ? ` (score ${g.score} < umbral ${g.threshold})` : '';
    out.push({ source, policy: 'grounding', detail: `${g.type}${score}`, action: act(g.action) });
  }
  return out;
}

/**
 * Traza de Converse/ConverseStream: `trace.guardrail.inputAssessment` es un mapa
 * guardrailId → assessment; `outputAssessments` es un mapa guardrailId → assessment[].
 */
export function converseTraceToInterventions(trace: unknown): GuardrailIntervention[] {
  const guardrail = (trace as { guardrail?: unknown } | undefined)?.guardrail as
    | { inputAssessment?: Record<string, unknown>; outputAssessments?: Record<string, unknown[]> }
    | undefined;
  if (!guardrail) return [];
  const out: GuardrailIntervention[] = [];
  for (const a of Object.values(guardrail.inputAssessment ?? {})) out.push(...assessmentToInterventions(a, 'input'));
  for (const list of Object.values(guardrail.outputAssessments ?? {})) {
    for (const a of list ?? []) out.push(...assessmentToInterventions(a, 'output'));
  }
  return out;
}
