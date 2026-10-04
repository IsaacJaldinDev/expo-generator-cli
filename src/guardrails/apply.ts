import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  type GuardrailContentBlock,
  type GuardrailContentQualifier,
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
}

export interface GuardrailChecker {
  check(text: string, source: GuardrailSource, opts?: { qualifiers?: GuardrailContentQualifier[] }): Promise<GuardrailCheckResult>;
}

/**
 * ApplyGuardrail evalúa texto sin invocar un modelo. Lo usamos donde Converse NO evalúa:
 * los resultados de herramientas (apuntes leídos) y los argumentos de herramientas (texto que va al deck).
 */
export function createGuardrailChecker(cfg: Config, client?: BedrockRuntimeClient): GuardrailChecker {
  const runtime =
    client ?? new BedrockRuntimeClient({ region: cfg.aws.region, credentials: fromIni({ profile: cfg.aws.profile }) });

  return {
    async check(text, source, opts = {}) {
      if (!cfg.guardrail.enabled) return { intervened: false, text, blocked: false, interventions: [] };
      const content: GuardrailContentBlock[] = [
        { text: { text, ...(opts.qualifiers ? { qualifiers: opts.qualifiers } : {}) } },
      ];
      const res = await runtime.send(
        new ApplyGuardrailCommand({
          guardrailIdentifier: cfg.guardrail.id,
          guardrailVersion: cfg.guardrail.version,
          source: source === 'input' ? 'INPUT' : 'OUTPUT',
          content,
        }),
      );
      const interventions = (res.assessments ?? []).flatMap((a) => assessmentToInterventions(a, source));
      const intervened = res.action === 'GUARDRAIL_INTERVENED';
      const outText = (res.outputs ?? []).map((o) => o.text ?? '').join('');
      return {
        intervened,
        text: intervened && outText ? outText : text,
        blocked: interventions.some((i) => i.action === 'BLOCKED'),
        interventions,
      };
    },
  };
}
