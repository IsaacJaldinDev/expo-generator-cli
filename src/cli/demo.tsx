/**
 * CLI de la demo: un comando por acto de la charla.
 *   npm run demo -- brief                      # 1 · brief y apuntes
 *   npm run demo -- research                   # 2 · huecos y research (desde cero)
 *   npm run demo -- plan                       # 3 · plan y validación (con los claims del acto 2)
 *   npm run demo -- edit "Haz el inicio más provocador"   # 4 · edición conversacional + diff
 *   npm run demo -- bedrock                    # 5 · costo y cambio de modelo
 *   npm run demo -- guardrails [escenario|all] # 6 · Bedrock Guardrails (--record / --replay)
 *   npm run demo -- canva                      # 7 · 3 slides en Canva vía MCP (--record / --replay)
 *   npm run demo -- full                       # 2 + 3 seguidos
 * Flags: --no-guardrail · --scope=hook,cierre
 */
import { readFileSync } from 'node:fs';
import { Box, render, Text } from 'ink';
import { loadBrief } from '../schemas/brief.ts';
import { activeModel, loadConfig } from '../schemas/config.ts';
import { loadKnowledgeFragments } from '../tools/read-knowledge.ts';
import { BriefView, CostView, Header } from './ui/components.tsx';
import { createEventBus, RunApp, type ResultPanel } from './ui/RunApp.tsx';
import { ScenarioApp } from './ui/ScenarioApp.tsx';
import { listScenarios } from '../guardrails/scenarios.ts';
import type { RunMode } from '../guardrails/scenario-context.ts';
import { createSession, loadRuns, recordRun, type SessionOptions, type SessionOutcome } from './session.ts';
import { DeckStore } from '../agent/deck-store.ts';
import { emptyUsage } from '../agent/cost.ts';
import { loadBrandGuide } from '../schemas/brand.ts';
import { renderCanvaInput } from '../render/canva.ts';
import type { CanvaResult } from '../canva/generate.ts';
import { runCanva } from '../canva/run.ts';
import { CanvaApp } from './ui/CanvaApp.tsx';

const ALIASES: Record<string, string> = { '1': 'brief', '2': 'research', '3': 'plan', '4': 'edit', '5': 'bedrock', '6': 'guardrails', '7': 'canva' };
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const act = ALIASES[positional[0] ?? ''] ?? positional[0] ?? 'help';
const rest = positional.slice(1).join(' ').trim();
const scope = args.find((a) => a.startsWith('--scope='))?.slice('--scope='.length);
const noGuardrail = args.includes('--no-guardrail');

/** Renderiza algo estático y termina. */
async function show(node: React.ReactNode) {
  const app = render(node);
  app.unmount();
  await app.waitUntilExit();
}

/** Corre una sesión del agente con la vista de trazas en vivo. */
async function runAct(label: string, title: string, panel: ResultPanel, opts: Omit<SessionOptions, 'sink'>) {
  const bus = createEventBus();
  const session = createSession({ ...opts, sink: bus.emit });
  let ok = false;
  // El acto 2 no tiene deck todavía: su éxito es la etapa (claims verificados), no validate_deck.
  const onDone = (o: SessionOutcome) => (ok = o.ok && (panel === 'claims' || o.validation.ok));
  const app = render(<RunApp bus={bus} session={session} act={label} title={title} panel={panel} onDone={onDone} />, {
    exitOnCtrlC: true,
  });
  await app.waitUntilExit();
  if (!ok) process.exitCode = 1;
}

function configActiveLine(): { line: number; text: string } {
  const lines = readFileSync('config/config.yml', 'utf8').split('\n');
  const i = lines.findIndex((l) => /^\s+active:/.test(l));
  return { line: i + 1, text: lines[i]?.trim() ?? '' };
}

switch (act) {
  case 'brief':
    await show(
      <Box flexDirection="column">
        <Header act="ACTO 1" title="Brief y apuntes" subtitle="Lo que recibe el agente: un brief, mis apuntes, mi voz y mi línea gráfica" />
        <BriefView brief={loadBrief()} fragments={loadKnowledgeFragments('knowledge')} />
      </Box>,
    );
    break;
  case 'research':
    await runAct('ACTO 2', 'Huecos y research', 'claims', { act: 'research', fresh: true, stages: ['research'], noGuardrail });
    break;
  case 'plan':
    await runAct('ACTO 3', 'Plan y validación', 'deck', { act: 'plan', resetDeck: true, stages: ['deck'], noGuardrail });
    break;
  case 'full':
    await runAct('ACTOS 2+3', 'De apuntes a exposición', 'deck', { act: 'full', fresh: true, noGuardrail });
    break;
  case 'edit': {
    if (!rest) {
      console.error('Uso: npm run demo -- edit "Haz el inicio más provocador"');
      process.exitCode = 1;
      break;
    }
    await runAct('ACTO 4', 'Edición conversacional', 'diff', {
      act: 'edit',
      instruction: rest,
      stages: ['deck'],
      noGuardrail,
      ...(scope ? { scope: scope.split(',') } : {}),
    });
    break;
  }
  case 'bedrock': {
    const cfg = loadConfig();
    const m = activeModel(cfg);
    await show(
      <Box flexDirection="column">
        <Header act="ACTO 5" title="Bedrock: costo y modelo" subtitle="Precios en config/config.yml · uso real medido en cada ejecución" />
        <CostView runs={loadRuns()} active={{ key: m.key, modelId: m.modelId }} configLine={configActiveLine()} />
      </Box>,
    );
    break;
  }
  case 'guardrails': {
    const names = !rest || rest === 'all' ? listScenarios() : rest.split(/[\s,]+/);
    const mode: RunMode = args.includes('--record') ? 'record' : args.includes('--replay') ? 'replay' : 'live';
    let ok = false;
    const app = render(<ScenarioApp cfg={loadConfig()} names={names} mode={mode} onDone={(v) => (ok = v)} />, { exitOnCtrlC: true });
    await app.waitUntilExit();
    if (!ok) process.exitCode = 1;
    break;
  }
  case 'canva': {
    const mode = args.includes('--record') ? 'record' : args.includes('--replay') ? 'replay' : 'live';
    const cfg = loadConfig();
    const brand = loadBrandGuide();
    const store = DeckStore.load('output', loadBrief().title);
    if (store.deck.sections.length === 0) {
      console.error('No hay deck en output/: corre primero el acto 3 (npm run demo -- plan) o carga un checkpoint.');
      process.exitCode = 1;
      break;
    }
    const input = renderCanvaInput(store.deck, brand);
    let result: CanvaResult | undefined;
    const app = render(
      <CanvaApp
        brand={brand}
        input={input}
        mode={mode === 'replay' ? 'REPLAY (cassette)' : mode === 'record' ? 'grabando cassette' : 'en vivo'}
        fallbackUrl={cfg.canva.fallbackDeckUrl}
        run={(sink) => runCanva(cfg, input, mode, sink)}
        onDone={(r) => (result = r)}
      />,
      { exitOnCtrlC: true },
    );
    await app.waitUntilExit();
    if (result) recordRun('output', { at: new Date().toISOString(), act: 'canva', model: 'canva-mcp', modelId: mode, seconds: result.seconds, stages: [], usage: emptyUsage(), costUsd: 0, ok: result.ok });
    // El transporte HTTP del MCP puede dejar handles abiertos: el acto termina aquí.
    process.exit(result?.ok ? 0 : 1);
  }
  default:
    await show(
      <Box flexDirection="column">
        <Text bold>npm run demo -- {'<acto>'}</Text>
        <Text>  brief · research · plan · edit "instrucción" · bedrock · guardrails · canva · full</Text>
        <Text dimColor>  (o 1–7) · flags: --no-guardrail --scope=hook,cierre · guardrails: --record --replay</Text>
      </Box>,
    );
}
