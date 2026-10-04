import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * OAuth 2.1 + PKCE para el MCP remoto de Canva, con callback en 127.0.0.1 y
 * persistencia en disco (fuera del repo, archivos 0600). El refresh lo hace el
 * transporte del SDK de MCP usando este provider.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private lastState: string | undefined;
  authorizationUrl: URL | undefined;

  constructor(
    private readonly dir: string,
    private readonly port: number,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'expo-generator (CLI local)',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    this.lastState = randomBytes(16).toString('hex');
    return this.lastState;
  }

  get expectedState(): string | undefined {
    return this.lastState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read('client.json');
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.write('client.json', info);
  }
  tokens(): OAuthTokens | undefined {
    return this.read('tokens.json');
  }
  saveTokens(tokens: OAuthTokens): void {
    this.write('tokens.json', tokens);
  }
  saveCodeVerifier(v: string): void {
    this.write('verifier.json', { v });
  }
  codeVerifier(): string {
    const v = this.read<{ v: string }>('verifier.json')?.v;
    if (!v) throw new Error('No hay code verifier PKCE guardado');
    return v;
  }
  saveDiscoveryState(s: OAuthDiscoveryState): void {
    this.write('discovery.json', s);
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.read('discovery.json');
  }
  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const files: Record<typeof scope, string[]> = {
      all: ['client.json', 'tokens.json', 'verifier.json', 'discovery.json'],
      client: ['client.json'],
      tokens: ['tokens.json'],
      verifier: ['verifier.json'],
      discovery: ['discovery.json'],
    };
    for (const f of files[scope]) rmSync(join(this.dir, f), { force: true });
  }

  private read<T>(file: string): T | undefined {
    const p = join(this.dir, file);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined;
  }
  private write(file: string, data: unknown): void {
    const p = join(this.dir, file);
    writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(p, 0o600);
  }
}

/** Espera un único callback OAuth en 127.0.0.1:port/callback y devuelve el `code`. */
function waitForCallback(port: number, expectedState: () => string | undefined, timeoutMs: number) {
  let server: Server | undefined;
  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No llegó el callback OAuth en ${timeoutMs / 1000}s`)), timeoutMs);
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const c = url.searchParams.get('code');
      const st = url.searchParams.get('state');
      const fail = (msg: string) => {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(msg);
        clearTimeout(timer);
        reject(new Error(msg));
      };
      if (err) return fail(`Canva rechazó la autorización: ${err} ${url.searchParams.get('error_description') ?? ''}`);
      if (!c) return fail('Callback sin code');
      if (expectedState() && st !== expectedState()) return fail('El parámetro state no coincide (posible CSRF)');
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<h1>Canva conectado ✔</h1><p>Ya puedes volver a la terminal.</p>');
      clearTimeout(timer);
      resolve(c);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });
  return { code, close: () => server?.close() };
}

export interface CanvaAuthOptions {
  serverUrl: string;
  tokenDir: string;
  port: number;
  /** Abre el navegador (o imprime la URL). */
  openUrl: (url: URL) => void | Promise<void>;
  timeoutMs?: number;
}

/**
 * Asegura tokens válidos para Canva. Si ya hay tokens (o se pueden refrescar) no abre nada.
 * Si no, hace el flujo completo: registro dinámico de cliente → navegador → callback local → tokens.
 */
export async function ensureCanvaAuth(opts: CanvaAuthOptions): Promise<{ provider: FileOAuthProvider; interactive: boolean }> {
  const provider = new FileOAuthProvider(opts.tokenDir, opts.port);
  const callback = waitForCallback(opts.port, () => provider.expectedState, opts.timeoutMs ?? 5 * 60_000);
  try {
    const first = await auth(provider, { serverUrl: opts.serverUrl });
    if (first === 'AUTHORIZED') return { provider, interactive: false };
    if (!provider.authorizationUrl) throw new Error('El SDK pidió redirección pero no entregó la URL de autorización');
    await opts.openUrl(provider.authorizationUrl);
    const code = await callback.code;
    const second = await auth(provider, { serverUrl: opts.serverUrl, authorizationCode: code });
    if (second !== 'AUTHORIZED') throw new Error('No se pudo canjear el código de autorización por tokens');
    return { provider, interactive: true };
  } finally {
    callback.close();
    // evita un unhandled rejection si el flujo terminó sin usar el callback
    callback.code.catch(() => {});
  }
}
