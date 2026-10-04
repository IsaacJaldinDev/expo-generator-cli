import { execFile } from 'node:child_process';
import { McpClient } from '@strands-agents/sdk';
import type { Config } from '../schemas/config.ts';
import { ensureCanvaAuth } from './oauth.ts';

/** Abre una URL en el navegador por defecto (macOS `open`; en otros sistemas solo la imprime). */
export function openInBrowser(url: URL): void {
  console.log(`\nAbre esta URL para autorizar Canva:\n  ${url.href}\n`);
  if (process.platform === 'darwin') execFile('open', [url.href], () => {});
}

/** Cliente MCP de Strands conectado al MCP remoto de Canva con OAuth. */
export async function createCanvaClient(cfg: Config, openUrl = openInBrowser) {
  const { provider, interactive } = await ensureCanvaAuth({
    serverUrl: cfg.canva.mcpUrl,
    tokenDir: cfg.canva.tokenDir,
    port: cfg.canva.redirectPort,
    openUrl,
  });
  const client = new McpClient({
    url: cfg.canva.mcpUrl,
    authProvider: provider,
    applicationName: 'expo-generator',
  });
  return { client, interactive };
}
