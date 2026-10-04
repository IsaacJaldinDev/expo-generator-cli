# expo-generator — "De apuntes a exposición"

Agente que convierte brief + apuntes + guía de voz + guía visual en una exposición (plan, claims con fuentes,
script, tiempos validados, slides en Canva). Se demuestra **en vivo** en un AWS Student Community Day (35 min, español).

Tesis que el diseño debe hacer visible: **un agente es un modelo con herramientas, estado de la tarea y la
obligación de revisar su propio trabajo.** Prioridad: confiabilidad en vivo > claridad didáctica > sofisticación.

## Decisiones de arquitectura (no cambiar sin consultar al autor)

- **Un solo agente** Strands + herramientas + validadores deterministas + una llamada de crítica separada. Nada de multi-agent.
- **Fuente de verdad:** `deck.json` (secciones → slides → script por slide) + `claims.json` (procedencia).
  `script.md`, `timing.md` y el input de Canva se **renderizan con código** desde `deck.json`.
- El LLM **no reescribe el deck completo**: parches validados con Zod vía `update_section`.
- **Timing en código:** palabras ÷ `timing.wordsPerMinute` (default 135).
- **Sin puntajes de confianza inventados.** Procedencia = `origin` (author|external) + `source_tier` (mapa fijo en
  `config/sources.yml`) + `verified` (calculado en código: el fragmento citado aparece en el contenido descargado).
- `research` solo dentro de la allowlist de `sources.yml`; solo investiga los huecos (3–5 claims).
- Formatos: Markdown = conocimiento humano, YAML = configuración/reglas, JSON = contratos entre etapas.
- Máximo **2 rondas de revisión** (`agent.maxRevisionRounds`); structured output con **1 reintento**
  (`agent.structuredOutputRetries`) y luego error claro. Nunca loops en escenario.
- Modelo en config, nunca hardcodeado. Cambio en vivo con **una línea**: `model.active` en `config/config.yml`.
  Principal: **Nova 2 Lite** (`us.amazon.nova-2-lite-v1:0`); alternativa del Acto 5: **Mistral Large 3**.
  Claude no se usa: la cuenta no completó el formulario de caso de uso de Anthropic (decisión del autor, fase 0).
- Precios en config, no en código. Al final de cada ejecución: tokens in/out y costo estimado USD.
- Credenciales: solo perfil local (`aws.profile`, sobreescribible con `AWS_PROFILE`). Tokens OAuth de Canva en
  `canva.tokenDir` (fuera del repo, 0600). Nunca credenciales en el repo.
- Fuera de alcance: AgentCore, Notion/Obsidian, multi-agent, Knowledge Bases, UI web, paper académico.
- **Ollama:** solo la puerta abierta. `critic.provider: bedrock | ollama`; `ollama` responde "no implementado"
  hasta que el autor lo pida. Ruta prevista: `OpenAIModel` de Strands con `api: 'chat'` y
  `clientConfig.baseURL = 'http://localhost:11434/v1'` (requiere el peer `openai`). Ver `docs/ollama.md`.

## Bedrock Guardrails — diseño híbrido (aprobado en fase 0)

Verificado en la documentación de AWS: Converse **no evalúa** `toolResult` ni `toolUse.input` con ningún filtro.
Por eso:
- `guardrailConfig` en Converse (`src/providers/bedrock.ts`) → lo que escribe el usuario y el texto del modelo.
  `streamProcessingMode: 'sync'` siempre (el enmascarado de PII no funciona en async).
- `ApplyGuardrail` (`src/guardrails/apply.ts`) → apuntes que lee `read_knowledge` (source INPUT) y texto que
  entra al deck vía `update_section` (source OUTPUT). Determinista, sin modelo.
- Las dos vías se normalizan con `src/guardrails/trace.ts` y se muestran en la vista de trazas.

## Hechos verificados del SDK (`@strands-agents/sdk` 1.19.0, leídos en los .d.ts / .js)

- Zod **v4** obligatorio (peer `^4.1.12`). Herramientas: `tool({ name, description, inputSchema, callback(input, context) })`.
  Estado de la tarea: `context.agent.appState.get/set`.
- **No hay `hooks` en el constructor ni `HookProvider`**: se usa `plugins: Plugin[]` con `initAgent(agent)` y
  `agent.addHook(EventClass, cb)`.
- Forzar que el agente siga: `AfterInvocationEvent.resume = 'feedback'` (reusa opciones e invocationState).
  `AfterInvocationEvent` también se dispara si la invocación falló, sin traer el error.
- Structured output: `structuredOutputSchema` → herramienta interna `strands_structured_output`. El SDK reintenta
  **sin límite**; el límite lo impone `structuredOutputLimit` abortando `cancelSignal` → `stopReason: 'cancelled'`.
- `printer` es `true` por defecto: siempre `printer: false` (rompe Ink).
- `BedrockModel`: opciones planas (`modelId`, `region`, `clientConfig.credentials`, `guardrailConfig` con
  `guardrailIdentifier`, `cacheConfig`). La traza del guardrail llega como `trace: unknown` en `modelMetadataEvent`.
- Caché `strategy: 'auto'` solo se activa si el modelId contiene `claude`/`anthropic`. Nova requiere
  `CachePointBlock` manual (y Nova no cachea `tools`).
- `McpClient({ url, authProvider })` crea un `StreamableHTTPClientTransport`. Solo hay `signal` por llamada, sin timeout propio.

## Canva MCP

`https://mcp.canva.com/mcp`, Streamable HTTP, OAuth 2.1 + PKCE con registro dinámico de cliente (Canva lo
marca *deprecated* pero disponible). `src/canva/oauth.ts` implementa `OAuthClientProvider` con callback en
`127.0.0.1:${canva.redirectPort}`. Plan B: `npx mcp-remote https://mcp.canva.com/mcp` por stdio.
Verificado en fase 0: el OAuth con callback local + registro dinámico funciona, los tokens se reutilizan sin navegador y hay 49 herramientas.
Schemas reales en `docs/canva-tools.json`. Para la fase 6 hay dos caminos:
- `generate-design` (`design_type: presentation`, `length: short` = 1–5 slides) → candidatos → `create-design-from-candidate`.
- `create-design`, que acepta un `outline` estructurado y corre como job asíncrono (`get-create-design-async-job`).
Hay que elegir uno solo.

## Modelos y guardrail verificados (fase 0)

- Nova 2 Lite: tool use ✓, structured output ✓, caché con cache point manual ✓ (`promptCache: cachepoint`).
- Mistral Large 3: tool use ✓, structured output ✓. Rechaza cache points (`promptCache: none`).
- Guardrail `d1e4ashg6qe2` (Standard): 4 escenarios al 10/10. La cita inventada en la salida solo se atrapa con
  grounding contra los fragmentos de los claims. Detalle en `docs/guardrails.md`.

## Comandos

- Node 24 LTS (`.nvmrc`); npm (sin corepack/pnpm: un punto de fallo menos el día de la charla).
- `npm run typecheck` · `npm test` · `npm run spike:agent [-- --guardrail]` · `npm run spike:guardrail` · `npm run spike:canva [-- --reset]`
- Tests sin AWS: `src/replay/scripted-model.ts` reproduce turnos guionizados por el loop real de Strands
  (base del modo `--replay` de la fase 7).

## Forma de trabajo

- Por fases (0 spike → 7 confiabilidad). Al final de cada fase: tests, mostrar qué funciona y **detenerse**.
- No asumir APIs de memoria: verificar en `node_modules` o en la documentación y decir explícitamente lo no verificado.
- Si algo no existe en el SDK de TypeScript: parar y proponer alternativas, sin cambiar de lenguaje.
