import type { TraceSink } from '../agent/events.ts';
import { buildSystemPrompt } from '../agent/system-prompt.ts';
import { deckParams } from '../agent/params.ts';
import { createAgentModel } from '../providers/bedrock.ts';
import { emptyCassette, loadCassette, recordingChecker, RecordingModel, replayChecker, ReplayModel, saveCassette } from '../replay/cassette.ts';
import { loadBrandGuide } from '../schemas/brand.ts';
import { loadBrief } from '../schemas/brief.ts';
import type { Config } from '../schemas/config.ts';
import { loadSources } from '../schemas/sources.ts';
import { createGuardrailChecker, withCostTracking } from './apply.ts';
import type { ScenarioDeps } from './scenarios.ts';

export type RunMode = 'live' | 'record' | 'replay';

export const cassettePath = (name: string) => `demo/cassettes/guardrails/${name}.json`;

/** Dependencias de un escenario según el modo: en vivo, grabando el cassette o reproduciéndolo sin red. */
export function scenarioDeps(cfg: Config, name: string, mode: RunMode, sink: TraceSink): { deps: ScenarioDeps; finish(): void } {
  const brief = loadBrief();
  const systemPrompt = buildSystemPrompt(brief, deckParams(cfg, brief, loadBrandGuide(), loadSources()));
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
