import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StopReason,
  type Usage,
  type StreamOptions,
} from '@strands-agents/sdk';

/** Una respuesta del modelo, ya decidida. Es lo que un cassette de replay guardará en la fase 7. */
export interface ScriptedResponse {
  text?: string;
  toolUses?: { name: string; input: unknown; id?: string }[];
  stopReason?: StopReason;
  usage?: Partial<Usage>;
  /** Traza cruda de Bedrock (p. ej. { guardrail: {...} }) para simular intervenciones. */
  trace?: unknown;
}

export type ScriptedTurn = ScriptedResponse | ((messages: Message[], options?: StreamOptions) => ScriptedResponse);

/**
 * Modelo determinista que reproduce turnos guionizados como eventos de streaming del SDK.
 * Sirve para tests sin AWS y como base del modo --replay.
 */
export class ScriptedModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'scripted' };
  private turn = 0;
  readonly calls: { messages: Message[]; options?: StreamOptions | undefined }[] = [];

  constructor(private readonly turns: ScriptedTurn[]) {
    super();
  }

  updateConfig(modelConfig: BaseModelConfig): void {
    this.config = { ...this.config, ...modelConfig };
  }

  getConfig(): BaseModelConfig {
    return this.config;
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls.push({ messages: [...messages], options });
    const next = this.turns[this.turn++];
    if (!next) throw new Error(`ScriptedModel: no hay turno #${this.turn} en el guion`);
    const r = typeof next === 'function' ? next(messages, options) : next;
    const toolUses = r.toolUses ?? [];

    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (r.text) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: r.text } };
      yield { type: 'modelContentBlockStopEvent' };
    }
    for (const [i, t] of toolUses.entries()) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: t.name, toolUseId: t.id ?? `tool-${this.turn}-${i}` },
      };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(t.input) } };
      yield { type: 'modelContentBlockStopEvent' };
    }
    yield { type: 'modelMessageStopEvent', stopReason: r.stopReason ?? (toolUses.length > 0 ? 'toolUse' : 'endTurn') };
    const inputTokens = r.usage?.inputTokens ?? 100;
    const outputTokens = r.usage?.outputTokens ?? 20;
    yield {
      type: 'modelMetadataEvent',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(r.usage?.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: r.usage.cacheReadInputTokens } : {}),
        ...(r.usage?.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: r.usage.cacheWriteInputTokens } : {}),
      },
      ...(r.trace !== undefined ? { trace: r.trace } : {}),
    };
  }
}
