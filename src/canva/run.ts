import type { TraceSink } from '../agent/events.ts';
import type { CanvaDesignInput } from '../render/canva.ts';
import { emptyCassette, loadCassette, saveCassette } from '../replay/cassette.ts';
import type { Config } from '../schemas/config.ts';
import { createCanvaClient } from './client.ts';
import { generateSlides, mcpCaller, recordingCaller, replayCaller, type CanvaResult } from './generate.ts';

export const CANVA_CASSETTE = 'demo/cassettes/canva.json';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Acto 7 en vivo, grabando el cassette o reproduciéndolo. Nunca lanza: los fallos vuelven como { ok: false }. */
export async function runCanva(cfg: Config, input: CanvaDesignInput, mode: 'live' | 'record' | 'replay', sink: TraceSink): Promise<CanvaResult> {
  const t0 = performance.now();
  try {
    if (mode === 'replay') {
      const cassette = loadCassette(CANVA_CASSETTE);
      const speed = cfg.replay.speed;
      return await generateSlides(input, replayCaller(cassette), {
        sink,
        timeoutMs: Number.POSITIVE_INFINITY,
        sleep: (ms) => (speed > 0 ? sleep(ms / speed) : Promise.resolve()),
      });
    }
    const { client } = await createCanvaClient(cfg);
    const cassette = emptyCassette('canva');
    const live = mcpCaller(client);
    const result = await generateSlides(input, mode === 'record' ? recordingCaller(live, cassette) : live, {
      sink,
      timeoutMs: cfg.canva.timeoutMs,
      sleep,
    });
    if (mode === 'record' && result.ok) saveCassette(CANVA_CASSETTE, cassette);
    await client.disconnect().catch(() => {});
    return result;
  } catch (err) {
    return { ok: false, seconds: (performance.now() - t0) / 1000, error: (err as Error).message };
  }
}
