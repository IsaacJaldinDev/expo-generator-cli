import type { TraceSink } from '../agent/events.ts';
import { buildSystemPrompt } from '../agent/system-prompt.ts';
import { deckParams } from '../agent/params.ts';
import { createAgentModel } from '../providers/bedrock.ts';
import { emptyCassette, loadCassette, recordingChecker, RecordingModel, replayChecker, ReplayModel, saveCassette } from '../replay/cassette.ts';
import type { Config } from '../schemas/config.ts';
import { resolveExpo } from '../schemas/expo.ts';
import { createGuardrailChecker, withCostTracking } from './apply.ts';
import type { ScenarioDeps } from './scenarios.ts';

export type RunMode = 'live' | 'record' | 'replay';

export const cassettePath = (name: string) => `demo/cassettes/guardrails/${name}.json`;

/** Dependencias de un escenario según el modo: en vivo, grabando el cassette o reproduciéndolo sin red. */
export function scenarioDeps(cfg: Config, name: string, mode: RunMode, sink: TraceSink): { deps: ScenarioDeps; finish(): void } {
  // Los escenarios traen sus propios apuntes; de la exposición activa solo toman el brief para el system prompt.
  const expo = resolveExpo(cfg.expo.active);
  const systemPrompt = buildSystemPrompt(expo.brief, deckParams(cfg, expo.brief, expo.brand, expo.sources));
  const track = (usd: number) => sink({ kind: 'guardrail-usage', costUsd: usd });

  if (mode === 'replay') {
    const cassette = loadCassette(cassettePath(name));
    return {
      deps: {
        checker: withCostTracking(replayChecker(cassette, cfg.replay.speed), track),
        model: () => new ReplayModel(cassette, cfg.replay.eventDelayMs, cfg.replay.speed),
        systemPrompt,
        sink,
      },
      finish: () => {},
    };
  }
  if (!cfg.guardrail.enabled) throw new Error('Los escenarios de guardrails necesitan guardrail.enabled=true en config/config.yml.');
  const cassette = emptyCassette(name);
  const live = createGuardrailChecker(cfg);
  return {
    deps: {
      checker: withCostTracking(mode === 'record' ? recordingChecker(live, cassette) : live, track),
      model: () => (mode === 'record' ? new RecordingModel(createAgentModel(cfg), cassette) : createAgentModel(cfg)),
      systemPrompt,
      sink,
    },
    finish: () => {
      if (mode === 'record') saveCassette(cassettePath(name), cassette);
    },
  };
}
