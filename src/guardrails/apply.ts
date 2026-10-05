import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  type ApplyGuardrailCommandOutput,
  type GuardrailContentBlock,
  type GuardrailContentQualifier,
  type GuardrailUsage,
} from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import type { Config } from '../schemas/config.ts';
import { assessmentToInterventions, type GuardrailIntervention, type GuardrailSource } from './trace.ts';

export interface GuardrailCheckResult {
  intervened: boolean;
  /** Texto a usar después del guardrail: enmascarado ({EMAIL}, {PHONE}) o el mensaje de bloqueo. */
  text: string;
  blocked: boolean;
  interventions: GuardrailIntervention[];
  /** Costo estimado de esta evaluación (unidades de texto × precios de config). */
  costUsd: number;
}

export interface GroundingResult {
  grounded: boolean;
  groundingScore?: number;
  relevanceScore?: number;
  interventions: GuardrailIntervention[];
  costUsd: number;
}

export interface GroundingRequest {
  /** Fuente de verdad (p. ej. el pasaje del claim). */
  source: string;
  /** Para qué se usa el contenido (p. ej. la afirmación o el propósito de la slide). */
  query: string;
  /** El texto a verificar (p. ej. la oración del script). */
  content: string;
}

export interface GuardrailChecker {
  check(text: string, source: GuardrailSource, opts?: { qualifiers?: GuardrailContentQualifier[] }): Promise<GuardrailCheckResult>;
  /** Contextual grounding: ¿el contenido está respaldado por la fuente? */
  ground(req: GroundingRequest): Promise<GroundingResult>;
}

/** USD de una evaluación según las unidades que reporta Bedrock y guardrail.pricing (por 1000 unidades). */
export function guardrailCostUsd(usage: GuardrailUsage | undefined, pricing: Record<string, number>): number {
  if (!usage) return 0;
  const per = (units: number | undefined, key: string) => ((units ?? 0) * (pricing[key] ?? 0)) / 1000;
  return (
    per(usage.contentPolicyUnits, 'contentFilters') +
    per(usage.topicPolicyUnits, 'deniedTopics') +
    per(usage.sensitiveInformationPolicyUnits, 'sensitiveInfo') +
    per(usage.contextualGroundingPolicyUnits, 'contextualGrounding')
  );
}

/** Interpreta la respuesta de ApplyGuardrail. Exportada para el replay (cassettes guardan la respuesta cruda). */
export function interpretCheck(res: Pick<ApplyGuardrailCommandOutput, 'action' | 'outputs' | 'assessments' | 'usage'>, text: string, source: GuardrailSource, pricing: Record<string, number>): GuardrailCheckResult {
  const interventions = (res.assessments ?? []).flatMap((a) => assessmentToInterventions(a, source));
  const intervened = res.action === 'GUARDRAIL_INTERVENED';
  const outText = (res.outputs ?? []).map((o) => o.text ?? '').join('');
  return {
    intervened,
    text: intervened && outText ? outText : text,
    blocked: interventions.some((i) => i.action === 'BLOCKED'),
    interventions,
    costUsd: guardrailCostUsd(res.usage, pricing),
  };
}

export function interpretGrounding(res: Pick<ApplyGuardrailCommandOutput, 'assessments' | 'usage'>, pricing: Record<string, number>): GroundingResult {
  const filters = res.assessments?.[0]?.contextualGroundingPolicy?.filters ?? [];
  const score = (type: string) => filters.find((f) => f.type === type)?.score;
  const groundingScore = score('GROUNDING');
  const relevanceScore = score('RELEVANCE');
  const failed = filters.some((f) => f.type === 'GROUNDING' && f.action === 'BLOCKED');
  return {
    grounded: !failed,
    ...(groundingScore !== undefined ? { groundingScore } : {}),
    ...(relevanceScore !== undefined ? { relevanceScore } : {}),
    // Solo la parte de grounding: la relevancia respecto del query no dice si el dato es cierto.
    interventions: (res.assessments ?? [])
      .flatMap((a) => assessmentToInterventions(a, 'output'))
      .filter((i) => i.policy === 'grounding' && i.detail.startsWith('GROUNDING')),
    costUsd: guardrailCostUsd(res.usage, pricing),
  };
}

/**
 * ApplyGuardrail evalúa texto sin invocar un modelo. Lo usamos donde Converse NO evalúa:
 * los resultados de herramientas (apuntes leídos) y los argumentos de herramientas (texto que va al deck),
 * y para el contextual grounding de los claims.
 */
export function createGuardrailChecker(cfg: Config, client?: BedrockRuntimeClient): GuardrailChecker {
  const runtime =
    client ?? new BedrockRuntimeClient({ region: cfg.aws.region, credentials: fromIni({ profile: cfg.aws.profile }) });
  const apply = (source: 'INPUT' | 'OUTPUT', content: GuardrailContentBlock[], full = false) =>
    runtime.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: cfg.guardrail.id,
        guardrailVersion: cfg.guardrail.version,
        source,
        content,
        ...(full ? { outputScope: 'FULL' as const } : {}),
      }),
    );

  return {
    async check(text, source, opts = {}) {
      if (!cfg.guardrail.enabled) return { intervened: false, text, blocked: false, interventions: [], costUsd: 0 };
      const res = await apply(source === 'input' ? 'INPUT' : 'OUTPUT', [
        { text: { text, ...(opts.qualifiers ? { qualifiers: opts.qualifiers } : {}) } },
      ]);
      return interpretCheck(res, text, source, cfg.guardrail.pricing);
    },
    async ground({ source, query, content }) {
      if (!cfg.guardrail.enabled) return { grounded: true, interventions: [], costUsd: 0 };
      const res = await apply(
        'OUTPUT',
        [
          { text: { text: source, qualifiers: ['grounding_source'] } },
          { text: { text: query, qualifiers: ['query'] } },
          { text: { text: content, qualifiers: ['guard_content'] } },
        ],
        true, // FULL: devuelve el puntaje aunque pase
      );
      return interpretGrounding(res, cfg.guardrail.pricing);
    },
  };
}

/** Envuelve un checker para reportar el costo de cada evaluación a la traza. */
export function withCostTracking(inner: GuardrailChecker, onCost: (usd: number) => void): GuardrailChecker {
  return {
    async check(text, source, opts) {
      const r = await inner.check(text, source, opts);
      onCost(r.costUsd);
      return r;
    },
    async ground(req) {
      const r = await inner.ground(req);
      onCost(r.costUsd);
      return r;
    },
  };
}
