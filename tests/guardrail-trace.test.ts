import { describe, expect, it } from 'vitest';
import { assessmentToInterventions, converseTraceToInterventions } from '../src/guardrails/trace.ts';

describe('parser de trazas de Bedrock Guardrails', () => {
  it('traza de Converse: prompt attack en input y PII enmascarada en output', () => {
    const trace = {
      guardrail: {
        inputAssessment: {
          abc123: {
            contentPolicy: {
              filters: [
                { type: 'PROMPT_ATTACK', confidence: 'HIGH', filterStrength: 'HIGH', action: 'BLOCKED', detected: true },
                { type: 'HATE', confidence: 'NONE', action: 'NONE', detected: false },
              ],
            },
          },
        },
        outputAssessments: {
          abc123: [
            {
              sensitiveInformationPolicy: {
                piiEntities: [
                  { type: 'EMAIL', match: 'ana@uni.edu', action: 'ANONYMIZED', detected: true },
                  { type: 'PHONE', match: '+591 70000000', action: 'ANONYMIZED', detected: true },
                ],
              },
            },
          ],
        },
      },
    };
    expect(converseTraceToInterventions(trace)).toEqual([
      { source: 'input', policy: 'prompt-attack', detail: 'PROMPT_ATTACK (confianza HIGH)', action: 'BLOCKED' },
      { source: 'output', policy: 'datos-sensibles', detail: 'EMAIL', action: 'ANONYMIZED', match: 'ana@uni.edu' },
      { source: 'output', policy: 'datos-sensibles', detail: 'PHONE', action: 'ANONYMIZED', match: '+591 70000000' },
    ]);
  });

  it('ApplyGuardrail: grounding por debajo del umbral', () => {
    const assessment = {
      contextualGroundingPolicy: {
        filters: [
          { type: 'GROUNDING', score: 0.12, threshold: 0.75, action: 'BLOCKED', detected: true },
          { type: 'RELEVANCE', score: 0.9, threshold: 0.5, action: 'NONE', detected: false },
        ],
      },
    };
    expect(assessmentToInterventions(assessment, 'output')).toEqual([
      { source: 'output', policy: 'grounding', detail: 'GROUNDING (score 0.12 < umbral 0.75)', action: 'BLOCKED' },
    ]);
  });

  it('modo solo-detección (action NONE, detected true) también se reporta', () => {
    const a = { topicPolicy: { topics: [{ name: 'Citas inventadas', type: 'DENY', action: 'NONE', detected: true }] } };
    expect(assessmentToInterventions(a, 'input')).toHaveLength(1);
  });

  it('trazas vacías o desconocidas no rompen', () => {
    expect(converseTraceToInterventions(undefined)).toEqual([]);
    expect(converseTraceToInterventions({ other: 1 })).toEqual([]);
    expect(assessmentToInterventions('basura', 'input')).toEqual([]);
  });
});
