/**
 * Spike fase 0 — cliente MCP de Strands conectado al MCP remoto de Canva con OAuth.
 *   npm run spike:canva           # login (solo la primera vez) + lista herramientas
 *   npm run spike:canva -- --reset  # borra tokens y cliente registrado
 * Guarda los schemas reales en docs/canva-tools.json (no asumimos parámetros de memoria).
 */
import { rmSync, writeFileSync } from 'node:fs';
import { styleText } from 'node:util';
import { createCanvaClient } from '../../src/canva/client.ts';
import { loadConfig } from '../../src/schemas/config.ts';

const cfg = loadConfig();
if (process.argv.includes('--reset')) {
  rmSync(cfg.canva.tokenDir, { recursive: true, force: true });
  console.log(`Borrado ${cfg.canva.tokenDir}`);
}

const t0 = performance.now();
const { client, interactive } = await createCanvaClient(cfg);
console.log(styleText('green', interactive ? '✓ OAuth completado y tokens guardados' : '✓ Tokens existentes válidos (sin abrir navegador)'));

try {
  const tools = await client.listTools();
  console.log(styleText('bold', `\n${tools.length} herramientas de Canva MCP (${((performance.now() - t0) / 1000).toFixed(1)}s):`));
  for (const t of tools) console.log(`  · ${t.name}`);
  writeFileSync(
    'docs/canva-tools.json',
    JSON.stringify(
      tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.toolSpec.inputSchema })),
      null,
      2,
    ) + '\n',
  );
  console.log(styleText('dim', '\nSchemas guardados en docs/canva-tools.json'));
} finally {
  await client.disconnect();
}
