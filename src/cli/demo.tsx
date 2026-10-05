/**
 * CLI de la demo: un comando por acto de la charla.
 *   npm run demo -- brief                      # 1 · brief y apuntes
 *   npm run demo -- research                   # 2 · huecos y research (desde cero)
 *   npm run demo -- plan                       # 3 · plan y validación (con los claims del acto 2)
 *   npm run demo -- edit "Haz el inicio más provocador"   # 4 · edición conversacional + diff
 *   npm run demo -- bedrock                    # 5 · costo y cambio de modelo
 *   npm run demo -- guardrails <escenario>     # 6 · (fase 5)
 *   npm run demo -- canva                      # 7 · (fase 6)
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
import { createSession, loadRuns, type SessionOptions, type SessionOutcome } from './session.ts';

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
  case 'guardrails':
  case 'canva':
    await show(<Text color="yellow">{`El acto "${act}" llega en la fase ${act === 'guardrails' ? 5 : 6}.`}</Text>);
    break;
  default:
    await show(
      <Box flexDirection="column">
        <Text bold>npm run demo -- {'<acto>'}</Text>
        <Text>  brief · research · plan · edit "instrucción" · bedrock · guardrails · canva · full</Text>
        <Text dimColor>  (o 1–7) · flags: --no-guardrail --scope=hook,cierre</Text>
      </Box>,
    );
}
