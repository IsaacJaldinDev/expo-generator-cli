import { Box, Text, useAnimation, useApp } from 'ink';
import { useEffect, useState } from 'react';
import type { TraceEvent } from '../../agent/events.ts';
import { scenarioDeps, type RunMode } from '../../guardrails/scenario-context.ts';
import { loadScenario, runScenario, type Scenario, type ScenarioOutcome } from '../../guardrails/scenarios.ts';
import type { Config } from '../../schemas/config.ts';
import { buildChain } from './chain.ts';
import { ChainLine, Header, TraceView } from './components.tsx';
import { reduceRows, type Row } from './rows.ts';

interface Done {
  scenario: Scenario;
  outcome?: ScenarioOutcome;
  error?: string;
}

/** Acto 6: corre uno o varios escenarios de guardrails y muestra si intervino como se esperaba. */
export function ScenarioApp({ cfg, names, mode, onDone }: { cfg: Config; names: string[]; mode: RunMode; onDone: (allOk: boolean) => void }) {
  const { exit } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [current, setCurrent] = useState<Scenario>();
  const [done, setDone] = useState<Done[]>([]);
  const [finished, setFinished] = useState(false);
  const [usd, setUsd] = useState(0);
  const { time } = useAnimation({ interval: 500, isActive: !finished });

  useEffect(() => {
    void (async () => {
      const results: Done[] = [];
      for (const name of names) {
        const scenario = loadScenario(name);
        setCurrent(scenario);
        const sink = (e: TraceEvent) => {
          if (e.kind === 'guardrail-usage') setUsd((u) => u + e.costUsd);
          setEvents((p) => [...p, e]);
          setRows((p) => reduceRows(p, e));
        };
        sink({ kind: 'stage-start', stage: 'deck', title: scenario.title });
        try {
          const { deps, finish } = scenarioDeps(cfg, name, mode, sink);
          const outcome = await runScenario(scenario, deps);
          finish();
          results.push({ scenario, outcome });
        } catch (err) {
          results.push({ scenario, error: (err as Error).message });
        }
        setDone([...results]);
      }
      setCurrent(undefined);
      setFinished(true);
      onDone(results.every((r) => r.outcome?.triggered));
    })();
  }, []);

  useEffect(() => {
    if (finished) setTimeout(() => exit(), 50);
  }, [finished]);

  return (
    <Box flexDirection="column">
      <Header
        act="ACTO 6"
        title="Bedrock Guardrails en vivo"
        subtitle={`guardrail ${cfg.guardrail.id} (${cfg.guardrail.version}) · ${mode === 'replay' ? 'REPLAY (cassette)' : mode === 'record' ? 'grabando cassette' : 'en vivo'}`}
      />
      {current && (
        <Box marginBottom={1}>
          <Text italic dimColor wrap="wrap">
            {current.explain.trim()}
          </Text>
        </Box>
      )}
      <TraceView rows={rows} maxRows={finished ? 8 : 12} />
      <ChainLine links={buildChain(events)} />
      {done.map(({ scenario, outcome, error }) => (
        <Box key={scenario.name} flexDirection="column" marginTop={1}>
          <Text bold color={outcome?.triggered ? 'green' : 'red'}>
            {outcome?.triggered ? '✓' : '✗'} {scenario.title}
            <Text dimColor>{`  · esperado: ${scenario.expect.policy} ${scenario.expect.action}`}</Text>
          </Text>
          {error && <Text color="red">{`   ${error}`}</Text>}
          {outcome?.details.slice(0, 5).map((d, i) => (
            // wrap (no truncar): en PII lo importante es ver {EMAIL} y {PHONE} al final de la línea
            <Text key={i} color={/\{[A-Z_]+\}/.test(d) ? 'yellow' : undefined} dimColor={!/\{[A-Z_]+\}/.test(d)} wrap="wrap">{`   ${d}`}</Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1} gap={2}>
        <Text bold>⏱ {(time / 1000).toFixed(0)}s</Text>
        <Text bold color="yellow">
          ~${usd.toFixed(4)} USD
        </Text>
        <Text dimColor>ApplyGuardrail por unidades de texto</Text>
      </Box>
    </Box>
  );
}
