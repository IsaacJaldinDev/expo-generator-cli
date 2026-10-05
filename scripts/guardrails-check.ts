/**
 * Mide que cada escenario de guardrails dispare SIEMPRE (criterio de éxito: 100%).
 *   npm run guardrails:check                  # todos, 3 veces cada uno, en vivo
 *   npm run guardrails:check -- --times=10
 *   npm run guardrails:check -- --record      # además graba los cassettes (1 vez)
 *   npm run guardrails:check -- --replay      # verifica que los cassettes reproducen la intervención
 */
import { styleText } from 'node:util';
import { scenarioDeps, type RunMode } from '../src/guardrails/scenario-context.ts';
import { listScenarios, loadScenario, runScenario } from '../src/guardrails/scenarios.ts';
import { loadConfig } from '../src/schemas/config.ts';

const args = process.argv.slice(2);
const mode: RunMode = args.includes('--record') ? 'record' : args.includes('--replay') ? 'replay' : 'live';
const times = mode === 'live' ? Number(args.find((a) => a.startsWith('--times='))?.split('=')[1] ?? 3) : 1;
const only = args.filter((a) => !a.startsWith('--'));
const cfg = loadConfig();

let allOk = true;
for (const name of only.length ? only : listScenarios()) {
  const s = loadScenario(name);
  let hits = 0;
  let usd = 0;
  const t0 = performance.now();
  for (let i = 0; i < times; i++) {
    const { deps, finish } = scenarioDeps(cfg, name, mode, (e) => {
      if (e.kind === 'guardrail-usage') usd += e.costUsd;
    });
    const out = await runScenario(s, deps);
    finish();
    if (out.triggered) hits++;
  }
  const ok = hits === times;
  allOk &&= ok;
  console.log(
    ok ? styleText('green', '✓') : styleText('red', '✗'),
    name.padEnd(14),
    styleText('bold', `${hits}/${times}`),
    styleText('dim', `${s.expect.policy} ${s.expect.action} · ${mode} · ${((performance.now() - t0) / 1000 / times).toFixed(1)}s c/u · ~$${(usd / times).toFixed(4)} c/u`),
  );
}
if (!allOk) process.exitCode = 1;
