import { Box, Text, useAnimation, useApp } from 'ink';
import { useEffect, useState } from 'react';
import type { TraceEvent } from '../../agent/events.ts';
import type { CanvaResult } from '../../canva/generate.ts';
import type { CanvaDesignInput } from '../../render/canva.ts';
import type { BrandGuide } from '../../schemas/brand.ts';
import { Header, TraceView } from './components.tsx';
import { reduceRows, type Row } from './rows.ts';

export function Palette({ brand }: { brand: BrandGuide }) {
  const swatch = (label: string, hex: string) => (
    <Box key={label} marginRight={2}>
      <Text backgroundColor={hex}>{'      '}</Text>
      <Text>{` ${label} `}</Text>
      <Text dimColor>{hex}</Text>
    </Box>
  );
  return (
    <Box>
      {swatch('fondo', brand.colors.background)}
      {swatch('primario', brand.colors.primary)}
      {swatch('secundario', brand.colors.secondary)}
      <Text dimColor>{`${brand.fonts.heading} / ${brand.fonts.body}`}</Text>
    </Box>
  );
}

export function OutlineView({ input }: { input: CanvaDesignInput }) {
  const roles = input.outline.sections.length === 3 ? ['hook', 'arquitectura', 'cierre'] : [];
  return (
    <Box flexDirection="column" marginY={1}>
      {input.outline.sections.map((s, i) => (
        <Text key={i}>
          <Text dimColor>{`${i + 1}. ${roles[i] ? roles[i]!.padEnd(13) : ''}`}</Text>
          <Text bold>{s.title}</Text>
          {s.points?.length ? <Text dimColor>{`  · ${s.points.join(' · ')}`}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

/** Acto 7: deck.json + guía visual → slides en Canva vía MCP. */
export function CanvaApp(props: {
  brand: BrandGuide;
  input: CanvaDesignInput;
  /** Título del diseño en Canva: el nombre de la exposición. */
  title: string;
  mode: string;
  fallbackUrl: string;
  run: (sink: (e: TraceEvent) => void) => Promise<CanvaResult>;
  onDone: (r: CanvaResult) => void;
}) {
  const { exit } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<CanvaResult>();
  const { time } = useAnimation({ interval: 500, isActive: !result });

  useEffect(() => {
    void props
      .run((e) => setRows((p) => reduceRows(p, e)))
      .then((r) => {
        setResult(r);
        props.onDone(r);
      });
  }, []);
  useEffect(() => {
    if (result) setTimeout(() => exit(), 50);
  }, [result]);

  return (
    <Box flexDirection="column">
      <Header act="ACTO 7" title="Canva vía MCP" subtitle={`deck.json + guía visual → create-design (outline) · «${props.title}» · ${props.mode}`} />
      <Palette brand={props.brand} />
      <OutlineView input={props.input} />
      <TraceView rows={rows} maxRows={10} />
      {result?.ok && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={1}>
          <Text bold color="green">{`✓ ${result.pages ?? '?'} slides generadas en ${result.seconds.toFixed(0)} s`}</Text>
          <Text bold>{result.url ?? result.editUrl}</Text>
          {result.title ? <Text dimColor>{`título en Canva: ${result.title}`}</Text> : <Text color="yellow">{`⚠ no se pudo titular el diseño como «${props.title}»`}</Text>}
        </Box>
      )}
      {result && !result.ok && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">⚠ Canva no respondió como esperábamos</Text>
          <Text dimColor wrap="wrap">{result.error}</Text>
          {props.fallbackUrl ? (
            <Text>
              Deck pregenerado: <Text bold>{props.fallbackUrl}</Text>
            </Text>
          ) : (
            <Text dimColor>Configura canva.fallbackDeckUrl en config/config.yml para tener un plan B a mano.</Text>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold>⏱ {(result?.seconds ?? time / 1000).toFixed(0)}s</Text>
        {!result && <Text dimColor>{'  Canva genera el diseño en ~45 s; respetamos su polling_policy'}</Text>}
      </Box>
    </Box>
  );
}
