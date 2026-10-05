import { Box, Text, useAnimation, useApp } from 'ink';
import { useEffect, useState } from 'react';
import type { TraceEvent } from '../../agent/events.ts';
import { estimateCostUsd } from '../../agent/cost.ts';
import type { Session, SessionOutcome } from '../session.ts';
import { buildChain } from './chain.ts';
import { join } from 'node:path';
import { NOTES_REVIEW_MD } from '../../agent/notes-review.ts';
import { ChainLine, ClaimsTable, NotesReviewTable, DiffView, Footer, Header, TimingTable, TraceView, ValidationLine } from './components.tsx';
import { diffDecks } from './diff.ts';
import { reduceRows, type Row } from './rows.ts';

/** Bus mínimo entre el sink de la sesión (fuera de React) y la vista. */
export function createEventBus() {
  const listeners = new Set<(e: TraceEvent) => void>();
  const backlog: TraceEvent[] = [];
  return {
    emit(e: TraceEvent) {
      backlog.push(e);
      for (const l of listeners) l(e);
    },
    subscribe(l: (e: TraceEvent) => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    backlog,
  };
}
export type EventBus = ReturnType<typeof createEventBus>;

export type ResultPanel = 'claims' | 'deck' | 'diff';

export function RunApp(props: { bus: EventBus; session: Session; act: string; title: string; panel: ResultPanel; onDone: (o: SessionOutcome) => void }) {
  const { bus, session } = props;
  const { exit } = useApp();
  const [events, setEvents] = useState<TraceEvent[]>(() => [...bus.backlog]);
  const [rows, setRows] = useState<Row[]>(() => bus.backlog.reduce(reduceRows, [] as Row[]));
  const [outcome, setOutcome] = useState<SessionOutcome>();
  const { time } = useAnimation({ interval: 500, isActive: !outcome });

  useEffect(
    () =>
      bus.subscribe((e) => {
        setEvents((prev) => [...prev, e]);
        setRows((prev) => reduceRows(prev, e));
      }),
    [bus],
  );

  useEffect(() => {
    void session.run().then((o) => {
      setOutcome(o);
      props.onDone(o);
    });
  }, []);

  useEffect(() => {
    if (outcome) setTimeout(() => exit(), 50);
  }, [outcome]);

  const usage = outcome?.usage ?? session.usage();
  const seconds = outcome?.seconds ?? time / 1000;
  const costUsd = outcome?.costUsd ?? estimateCostUsd(usage, session.model.pricing) + session.guardrailUsd();

  return (
    <Box flexDirection="column">
      <Header
        act={props.act}
        title={props.title}
        subtitle={`${session.model.key} (${session.model.modelId}) · Bedrock Guardrails ${session.cfg.guardrail.enabled ? 'ON' : 'OFF'}${session.isEdit ? ` · » ${session.instruction}` : ''}`}
      />
      <TraceView rows={rows} maxRows={outcome ? 10 : 14} />
      <ChainLine links={buildChain(events)} />
      {outcome && (
        <Box flexDirection="column">
          {outcome.error && <Text color="red" bold>{`✗ ${outcome.error}`}</Text>}
          {props.panel !== 'diff' && (
            <NotesReviewTable reviews={session.notes.list()} blocking={session.notes.blocking().length} reportPath={join(session.expo.outputDir, NOTES_REVIEW_MD)} />
          )}
          {props.panel === 'claims' && <ClaimsTable claims={session.store.claims} />}
          {props.panel === 'deck' && (
            <>
              <ClaimsTable claims={session.store.claims} />
              <TimingTable deck={session.store.deck} params={session.params} />
              <ValidationLine validation={outcome.validation} />
            </>
          )}
          {props.panel === 'diff' && (
            <>
              <DiffView diffs={diffDecks(session.deckBefore, session.store.deck)} />
              <ValidationLine validation={outcome.validation} />
            </>
          )}
        </Box>
      )}
      <Footer seconds={seconds} usage={usage} costUsd={costUsd} model={session.model.key} />
    </Box>
  );
}
