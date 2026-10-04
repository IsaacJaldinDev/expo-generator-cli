import { BedrockModel, CachePointBlock, TextBlock, type BedrockModelOptions, type SystemPrompt } from '@strands-agents/sdk';
import { fromIni } from '@aws-sdk/credential-providers';
import { activeModel, type Config } from '../schemas/config.ts';

export interface AgentModelOptions {
  /** Aplica guardrailConfig en Converse si la config lo tiene habilitado. */
  guardrail?: boolean;
}

/** Crea el BedrockModel del agente a partir de config.yml. Cambiar model.active cambia de Claude a Nova. */
export function createAgentModel(cfg: Config, opts: AgentModelOptions = {}): BedrockModel {
  const m = activeModel(cfg);
  const options: BedrockModelOptions = {
    modelId: m.modelId,
    region: cfg.aws.region,
    clientConfig: { credentials: fromIni({ profile: cfg.aws.profile }) },
    maxTokens: m.maxTokens,
    temperature: m.temperature,
  };
  if (m.promptCache === 'auto') {
    // 'auto' solo activa caché si el modelId contiene "claude" (verificado en el SDK 1.19.0)
    options.cacheConfig = { strategy: 'auto' };
  }
  if ((opts.guardrail ?? true) && cfg.guardrail.enabled) {
    options.guardrailConfig = {
      guardrailIdentifier: cfg.guardrail.id,
      guardrailVersion: cfg.guardrail.version,
      trace: cfg.guardrail.trace,
      // El enmascarado de PII no funciona en modo async
      streamProcessingMode: 'sync',
    };
  }
  return new BedrockModel(options);
}

/**
 * System prompt con cache point manual si el modelo activo lo soporta (Nova).
 * Verificado en us-east-2: Nova 2 Lite escribe y luego lee el caché; Mistral Large 3 rechaza cache points.
 */
export function cachedSystemPrompt(cfg: Config, text: string): SystemPrompt {
  return activeModel(cfg).promptCache === 'cachepoint'
    ? [new TextBlock(text), new CachePointBlock({ cacheType: 'default' })]
    : text;
}
