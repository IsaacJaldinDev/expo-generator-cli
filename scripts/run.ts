/**
 * Corre el agente con salida de consola simple (para desarrollo; la demo usa `npm run demo`).
 *   npm run agent -- --fresh                        # desde cero: acto 2 (research) + acto 3 (deck)
 *   npm run agent -- --act=research                 # solo acto 2: huecos → research → claims
 *   npm run agent -- --act=deck                     # solo acto 3: deck con los claims existentes
 *   npm run agent -- "Haz el inicio más provocador" # edición conversacional
 *   npm run agent -- --no-guardrail                 # sin Bedrock Guardrails
 *   npm run agent -- --scope=hook,cierre "…"        # edición que puede tocar varias secciones
 *   npm run agent -- --expo=expo-de-s3 …            # otra exposición (input/expo-de-s3.json)
 */
import { styleText } from 'node:util';
import { consoleTrace } from '../src/cli/console-trace.ts';
import { createSession } from '../src/cli/session.ts';
import { unverifiedReason } from '../src/schemas/claims.ts';
import { renderTiming } from '../src/render/timing.ts';
import type { Stage } from '../src/tools/deps.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const act = flag('act');
if (act && act !== 'research' && act !== 'deck') throw new Error(`--act debe ser research o deck (recibido: ${act})`);
const scope = flag('scope');
const expo = flag('expo');
const instruction = args.filter((a) => !a.startsWith('--')).join(' ').trim();

const session = createSession({
  act: act ?? (instruction ? 'edit' : 'full'),
  fresh: args.includes('--fresh'),
  ...(expo ? { expo } : {}),
  noGuardrail: args.includes('--no-guardrail'),
  ...(instruction ? { instruction } : {}),
  ...(scope ? { scope: scope.split(',') } : {}),
  ...(act ? { stages: [act as Stage] } : {}),
  sink: consoleTrace,
});
const { cfg, model, store, params } = session;

console.log(
  styleText('bold', `\n${session.brief.title}`),
  styleText('dim', `\n${session.expo.inputPath} → ${session.expo.outputDir}/`),
  styleText('dim', `\n${model.key} → ${model.modelId} · guardrail ${cfg.guardrail.enabled ? 'ON' : 'OFF'} · ${session.deckBefore.sections.length ? 'deck existente' : 'deck nuevo'}`),
  styleText('cyan', `\n» ${session.instruction}\n`),
);

const out = await session.run();
if (out.error) console.error(styleText('red', `\n✗ ${out.error}`));

const reviews = session.notes.list();
if (reviews.length) {
  const mark = { confirmado: styleText('green', '✓'), inconsistente: styleText('red', '✗') };
  console.log(styleText('bold', '\nTus apuntes vs. las fuentes:'));
  for (const r of reviews.filter((x) => x.verdict !== 'sin-verificar')) console.log(`  ${mark[r.verdict as 'confirmado' | 'inconsistente']} ${r.fragmentId} ${r.verdict}: ${r.text}`);
  const blocking = session.notes.blocking().length;
  if (blocking) console.log(styleText(['red', 'bold'], `  ✗ El proceso se detuvo: ${blocking} apunte(s) por corregir → ${session.expo.outputDir}/revision-apuntes.md`));
}

const ext = store.claims.filter((c) => c.origin === 'external');
if (ext.length) {
  console.log(styleText('bold', '\nClaims externos:'));
  for (const c of ext) {
    console.log(
      `  ${c.verified ? styleText('green', '✓') : styleText('red', '✗')} ${c.id} [${c.sourceTier}] ${c.text}`,
      styleText('dim', c.verified ? '' : `(${unverifiedReason(c)})`),
    );
  }
}
const counts = new Map<string, number>();
for (const c of store.changes) counts.set(c.sectionId, (counts.get(c.sectionId) ?? 0) + 1);
const changed = [...counts].map(([id, n]) => (n > 1 ? `${id} ×${n}` : id));
console.log(styleText('bold', '\nSecciones tocadas:'), changed.length ? changed.join(', ') : 'ninguna');
console.log('\n' + renderTiming(store.deck, params));
const v = out.validation;
console.log(
  v.ok
    ? styleText(['green', 'bold'], '✓ validate_deck pasa')
    : styleText(['red', 'bold'], `✗ validate_deck falla:\n  ${v.errors.map((e) => `[${e.rule}] ${e.where}: ${e.message}`).join('\n  ')}`),
);
if (v.warnings.length) console.log(styleText('yellow', `  avisos: ${v.warnings.map((w) => w.message).join(' · ')}`));
console.log(
  styleText('bold', `\n${out.seconds.toFixed(1)}s · tokens in ${out.usage.inputTokens} / out ${out.usage.outputTokens}`),
  `· cache read ${out.usage.cacheReadInputTokens} / write ${out.usage.cacheWriteInputTokens}`,
  styleText('bold', `· ~$${out.costUsd.toFixed(4)} USD`),
  styleText('dim', `\nArchivos: ${session.expo.outputDir}/deck.json · claims.json · script.md · timing.md`),
);
if (!out.ok || !v.ok) process.exitCode = 1;
