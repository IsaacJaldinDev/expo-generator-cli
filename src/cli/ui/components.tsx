import { Box, Text, useAnimation, useWindowSize } from 'ink';
import type { UsageTotals } from '../../agent/events.ts';
import type { Brief } from '../../schemas/brief.ts';
import type { Claim } from '../../schemas/claims.ts';
import type { Deck } from '../../schemas/deck.ts';
import type { DeckValidation } from '../../validators/deck-rules.ts';
import { looksLikeExternalFact } from '../../validators/text.ts';
import { checkTiming, fmt, type TimingParams } from '../../validators/timing.ts';
import type { KnowledgeFragment } from '../../tools/read-knowledge.ts';
import type { RunRecord } from '../session.ts';
import { formatLink, type ChainLink } from './chain.ts';
import { textOf, type SectionDiff } from './diff.ts';
import type { Row } from './rows.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 3)}`;

export function Spinner() {
  const { frame } = useAnimation({ interval: 90 });
  return <Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text>;
}

export function Header({ act, title, subtitle }: { act: string; title: string; subtitle: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
      <Text bold color="magenta">
        {act} · {title}
      </Text>
      <Text dimColor>{subtitle}</Text>
    </Box>
  );
}

function RowView({ row, columns }: { row: Row; columns: number }) {
  switch (row.kind) {
    case 'stage':
      return (
        <Text bold color="magenta">
          ━━ {row.title} ━━
        </Text>
      );
    case 'tool':
      return (
        <Box>
          <Box width={3}>{row.status === 'running' ? <Spinner /> : <Text color={row.status === 'ok' ? 'green' : 'red'}>{row.status === 'ok' ? '✓' : '✗'}</Text>}</Box>
          <Box width={17}>
            <Text bold color={row.status === 'fail' ? 'red' : 'cyan'}>
              {row.name}
            </Text>
          </Box>
          <Box width={Math.max(10, columns - 3 - 17 - 8)}>
            <Text color={row.status === 'fail' ? 'red' : undefined} dimColor={row.status !== 'fail'} wrap="truncate-end">
              {row.status === 'fail' && row.note ? row.note : row.detail}
            </Text>
          </Box>
          <Box width={8} justifyContent="flex-end">
            <Text dimColor>{row.ms !== undefined ? `${(row.ms / 1000).toFixed(1)}s` : ''}</Text>
          </Box>
        </Box>
      );
    case 'guardrail': {
      const i = row.intervention;
      return (
        <Box flexDirection="column" marginY={0}>
          <Text backgroundColor="red" color="white" bold>
            {' 🛡  BEDROCK GUARDRAILS · '}
            {i.action}
            {' '}
          </Text>
          <Text color="red" bold>
            {'   '}
            {i.policy} · {i.detail} · en {i.source === 'input' ? 'INPUT' : 'OUTPUT'}
            {i.match ? `  «${cut(i.match, 40)}»` : ''}
          </Text>
        </Box>
      );
    }
    case 'gate':
      return (
        <Box flexDirection="column">
          <Text bold color={row.ok ? 'green' : 'red'}>
            {row.ok ? '✓ compuerta: validación OK' : `✗ compuerta: no puede terminar (ronda ${row.round})`}
          </Text>
          {!row.ok && row.problems.slice(0, 2).map((p, i) => <Text key={i} color="red">{`   ${cut(p, 110)}`}</Text>)}
        </Box>
      );
    case 'note':
      return <Text color={row.tone === 'error' ? 'red' : 'yellow'}>{`⚠ ${row.text}`}</Text>;
    case 'stage-end':
      return (
        <Text dimColor>
          {`━━ ${row.stage}: ${row.seconds.toFixed(1)}s ${row.ok ? '✓' : '✗'}`}
          {row.summary ? ` · ${cut(row.summary, 90)}` : ''}
        </Text>
      );
  }
}

/** Ventana de las últimas filas: en un proyector no caben más y el público sigue lo último que pasó. */
export function TraceView({ rows, maxRows = 14 }: { rows: Row[]; maxRows?: number }) {
  const { columns } = useWindowSize();
  const visible = rows.slice(-maxRows);
  return (
    <Box flexDirection="column">
      {rows.length > visible.length && <Text dimColor>{`  … ${rows.length - visible.length} pasos anteriores`}</Text>}
      {visible.map((r) => (
        <RowView key={r.key} row={r} columns={Math.min(columns || 100, 120)} />
      ))}
    </Box>
  );
}

export function ChainLine({ links }: { links: ChainLink[] }) {
  if (links.length === 0) return null;
  return (
    <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text wrap="wrap">
        {links.map((l, i) => (
          <Text key={i}>
            {i > 0 && <Text dimColor>{' → '}</Text>}
            <Text bold color={l.ok === false ? 'red' : l.ok === true ? 'green' : 'cyan'}>
              {formatLink(l)}
            </Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export function Footer({ seconds, usage, costUsd, model }: { seconds: number; usage: UsageTotals; costUsd: number; model: string }) {
  return (
    <Box marginTop={1} gap={2}>
      <Text bold>⏱ {seconds.toFixed(0)}s</Text>
      <Text>
        tokens <Text bold>{usage.inputTokens.toLocaleString('es')}</Text> in / <Text bold>{usage.outputTokens.toLocaleString('es')}</Text> out
      </Text>
      {usage.cacheReadInputTokens > 0 && <Text dimColor>caché {usage.cacheReadInputTokens.toLocaleString('es')}</Text>}
      <Text bold color="yellow">
        ~{usd(costUsd)} USD
      </Text>
      <Text dimColor>{model}</Text>
    </Box>
  );
}

export function ClaimsTable({ claims }: { claims: Claim[] }) {
  const external = claims.filter((c) => c.origin === 'external');
  const author = claims.filter((c) => c.origin === 'author');
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>claims.json</Text>
      {external.map((c) => (
        <Box key={c.id}>
          <Box width={3}>
            <Text color={c.verified ? 'green' : 'red'}>{c.verified ? '✓' : '✗'}</Text>
          </Box>
          <Box width={9}>
            <Text bold wrap="truncate-end">
              {c.id}
            </Text>
          </Box>
          <Box width={12}>
            <Text color={c.sourceTier === 'primary' ? 'green' : 'yellow'}>{c.sourceTier}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="truncate-end">
              {c.text}
              {!c.verified && <Text color="red">{c.checks && !c.checks.numbersMatch ? '  (cifras no respaldadas)' : '  (cita no encontrada)'}</Text>}
            </Text>
          </Box>
        </Box>
      ))}
      {author.length > 0 && <Text dimColor>{`   + ${author.length} claims de autor (citas a tus apuntes)`}</Text>}
    </Box>
  );
}

export function TimingTable({ deck, params }: { deck: Deck; params: TimingParams }) {
  const r = checkTiming(deck, params);
  return (
    <Box flexDirection="column" marginTop={1}>
      {r.sections.map((s) => (
        <Box key={s.id}>
          <Box width={22}>
            <Text>{s.id}</Text>
          </Box>
          <Box width={9} justifyContent="flex-end">
            <Text dimColor>{s.words} pal.</Text>
          </Box>
          <Box width={8} justifyContent="flex-end">
            <Text bold>{fmt(s.seconds)}</Text>
          </Box>
          <Box width={10} justifyContent="flex-end">
            <Text color={s.overBySeconds ? 'red' : undefined} dimColor={!s.overBySeconds}>
              {s.overBySeconds ? `+${s.overBySeconds}s` : s.targetSeconds !== undefined ? `/ ${fmt(s.targetSeconds)}` : ''}
            </Text>
          </Box>
        </Box>
      ))}
      <Text bold color={r.ok ? 'green' : 'red'}>
        {`Total ${fmt(r.totalSeconds)} de ${fmt(r.budgetSeconds)}  ${r.ok ? '✓' : r.deltaSeconds > 0 ? `✗ sobran ${r.deltaSeconds}s` : `✗ faltan ${-r.deltaSeconds}s`}`}
      </Text>
    </Box>
  );
}

export function ValidationLine({ validation }: { validation: DeckValidation }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={validation.ok ? 'green' : 'red'}>
        {validation.ok ? '✓ validate_deck pasa' : `✗ validate_deck: ${validation.errors.length} error(es)`}
      </Text>
      {validation.errors.slice(0, 4).map((e, i) => (
        <Text key={i} color="red">{`   [${e.rule}] ${cut(e.message, 100)}`}</Text>
      ))}
    </Box>
  );
}

export function DiffView({ diffs }: { diffs: SectionDiff[] }) {
  const same = diffs.filter((d) => d.status === 'same').map((d) => d.id);
  return (
    <Box flexDirection="column" marginTop={1}>
      {diffs
        .filter((d) => d.status !== 'same')
        .map((d) => (
          <Box key={d.id} flexDirection="column" marginBottom={1}>
            <Text bold color="yellow">
              {d.status === 'added' ? '+ ' : d.status === 'removed' ? '- ' : '~ '}sección {d.id}
            </Text>
            {d.slides.map((s) => (
              <Box key={s.index} flexDirection="column" paddingLeft={2}>
                {s.title.before !== s.title.after && (
                  <Text>
                    <Text dimColor>título: </Text>
                    {s.title.before && <Text color="red" strikethrough>{s.title.before}</Text>}
                    {s.title.before && s.title.after && <Text dimColor>{' → '}</Text>}
                    {s.title.after && <Text color="green">{s.title.after}</Text>}
                  </Text>
                )}
                {s.similarity < 0.5 ? (
                  <Box flexDirection="column">
                    {textOf(s.script, 'before').trim() && (
                      <Text color="red" strikethrough dimColor>
                        {cut(textOf(s.script, 'before').trim(), 140)}
                      </Text>
                    )}
                    <Text color="green">{textOf(s.script, 'after').trim()}</Text>
                  </Box>
                ) : (
                <Text wrap="wrap">
                  {s.script.map((p, i) =>
                    p.op === 'same' ? (
                      <Text key={i} dimColor>
                        {p.text}
                      </Text>
                    ) : p.op === 'add' ? (
                      <Text key={i} color="green" bold>
                        {p.text}
                      </Text>
                    ) : (
                      <Text key={i} color="red" strikethrough>
                        {p.text}
                      </Text>
                    ),
                  )}
                </Text>
                )}
              </Box>
            ))}
          </Box>
        ))}
      {same.length > 0 && <Text color="green">{`= sin cambios: ${same.join(', ')}`}</Text>}
    </Box>
  );
}

export function BriefView({ brief, fragments }: { brief: Brief; fragments: KnowledgeFragment[] }) {
  const files = [...new Set(fragments.map((f) => f.id.split('#')[0]!))];
  const suspicious = fragments.filter((f) => looksLikeExternalFact(f.text));
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">brief.yml</Text>
      <Text>
        <Text dimColor>tema       </Text>
        {brief.title}
      </Text>
      <Text>
        <Text dimColor>audiencia  </Text>
        {brief.audience}
      </Text>
      <Text>
        <Text dimColor>duración   </Text>
        <Text bold>{brief.durationMinutes} minutos</Text>
      </Text>
      <Text>
        <Text dimColor>objetivo   </Text>
        {brief.objective}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">knowledge/</Text>
        {files.map((f) => (
          <Text key={f}>
            {'  '}
            {f}.md <Text dimColor>· {fragments.filter((x) => x.id.startsWith(`${f}#`)).length} fragmentos</Text>
          </Text>
        ))}
      </Box>
      {suspicious.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="yellow">Datos en los apuntes que parecen externos (sin fuente):</Text>
          {suspicious.map((f) => (
            <Text key={f.id} color="yellow">{`  ⚠ ${f.id}  «${cut(f.text, 90)}»`}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

export function CostView({ runs, active, configLine }: { runs: RunRecord[]; active: { key: string; modelId: string }; configLine: { line: number; text: string } }) {
  // Las ejecuciones que no llegaron a llamar al modelo (p. ej. credenciales vencidas) no cuentan en los promedios.
  const real = runs.filter((r) => r.usage.inputTokens > 0);
  const byModel = new Map<string, RunRecord[]>();
  for (const r of real) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  const last = real.at(-1);
  return (
    <Box flexDirection="column">
      {last && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Última ejecución ({last.act})</Text>
          <Text>
            {`  ${last.model} · ${last.seconds.toFixed(0)}s · ${last.usage.inputTokens.toLocaleString('es')} in / ${last.usage.outputTokens.toLocaleString('es')} out · `}
            <Text bold color="yellow">{usd(last.costUsd)} USD</Text>
          </Text>
        </Box>
      )}
      <Text bold>Costo promedio por modelo (output/runs.jsonl)</Text>
      {[...byModel].map(([model, rs]) => (
        <Text key={model}>
          {`  ${model.padEnd(10)} ${String(rs.length).padStart(3)} ejecuciones · ${(rs.reduce((n, r) => n + r.seconds, 0) / rs.length).toFixed(0)}s prom. · `}
          <Text bold color="yellow">{usd(rs.reduce((n, r) => n + r.costUsd, 0) / rs.length)}</Text>
          {` prom.`}
        </Text>
      ))}
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text dimColor>config/config.yml · línea {configLine.line}</Text>
        <Text bold color="cyan">{configLine.text}</Text>
        <Text dimColor>{`modelo activo: ${active.modelId}`}</Text>
      </Box>
      <Text dimColor>Cambia esa línea (mistral ↔ nova) y vuelve a correr cualquier acto: el resto del sistema no cambia.</Text>
    </Box>
  );
}
