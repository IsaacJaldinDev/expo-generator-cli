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
  Principal: **Mistral Large 3** (más estable en el flujo completo, fase 2); alternativa del Acto 5: **Nova 2 Lite** (`us.amazon.nova-2-lite-v1:0`).
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

## Núcleo (fase 1): decisiones tomadas al probar en real

Nova 2 Lite no converge si se le pide aritmética o disciplina solo por prompt. Todo lo que es cálculo o regla vive en código:
- **Marcadores `[^id]`** en el script: `id` es un claim externo (`c-…`) o un fragmento de los apuntes (`notes#3`).
  Citar un fragmento registra un claim `origin: author` en `claims.json`, con `verified` calculado en código
  (el fragmento existe). Un dato con cifras (%, años, ≥100) exige un claim **externo** verificado: citar los
  apuntes no basta. Así el dato sembrado ("90% de las startups…") se rechaza siempre.
- **`targetSeconds`:** si suman más que la charla, el store los escala en código. No hay regla que le pida sumar al LLM.
- **`check_timing`** devuelve una `suggestion`: UNA sección y cuántas palabras agregar o quitar.
- **Edición puntual** (`DeckStore.startEdit`): la primera sección tocada fija el alcance y el código rechaza
  las demás (el rechazo se ve en la traza). `--scope=a,b` para ediciones de varias secciones.
- **Topes duros:** `agent.maxTurns` (por ronda) y `agent.maxToolCalls` (por ejecución; algunos modelos piden
  muchas herramientas por turno). Nova Pro se descartó: reescribía hasta 9 secciones por turno y no convergía.
- Medido en real (us-east-2):

  | Tarea | Modelo | Herramientas | Tiempo | Costo |
  |---|---|---|---|---|
  | Generar | Nova 2 Lite | 15–20 | 55–90 s | ~$0.03–0.06 |
  | Generar | Mistral Large 3 | 15 | 80 s | ~$0.06 |
  | Editar | Nova 2 Lite | ~11 | 42 s | ~$0.03 |

## Procedencia (fase 2)

- `config/sources.yml`: allowlist de dominios (coincidencia exacta del host, solo https) con el tier de cada uno, más las URLs semilla verificadas.
  `research` nunca sale de ahí. El modo con API key se agrega detrás de `SearchProvider` (`src/research/search.ts`).
- **`record_claim` recibe `passageId`, no una cita libre.** En las pruebas reales, Mistral y Nova inventaban o
  parafraseaban citas de memoria. Ahora el modelo solo puede elegir un pasaje real que devolvió `research`.
- `verified` se calcula en código y deja el detalle en `checks`:
  - `quoteFound`: el pasaje se vuelve a comprobar contra la página descargada.
  - `numbersMatch`: toda cifra de la afirmación aparece en el pasaje (sirve entre español e inglés: "10.000" ↔ "10,000").
  Así se rechaza siempre el dato sembrado del 90%, aunque el modelo lo "respalde" con un pasaje real.
- Los pasajes son ventanas de oraciones **contiguas**, para que cada uno exista literalmente en la página (33/33 verificados con las fuentes reales).
- `validate_deck` exige que el script cite al menos `limits.minExternalClaims` claims externos verificados.
- **Ejecución por etapas** (`ToolDeps.stage`), alineada con los actos:
  - `research` (acto 2): `update_section` bloqueado; la compuerta exige los claims verificados.
  - `deck` (acto 3): escribe, mide y valida.
  Mismo agente y misma conversación, con turnos y compuerta propios por etapa. `npm run agent -- --act=research|deck`.
- Si el modelo no entrega el resumen estructurado (`StructuredOutputError`), el flujo sigue solo si la compuerta de la etapa pasó.

## Voz (fase 3)

- **Voice lint** (`src/validators/voice-lint.ts`, determinista): lee las muletillas de `voice/anti-patterns.md`
  (sección "## Muletillas"), sin importar mayúsculas ni tildes y solo palabras completas. Además detecta:
  - oraciones largas;
  - tríadas (más de `voice.maxTriadsPerSection` por sección);
  - "No es X, es Y" (más de `voice.maxNotXButY` en el deck);
  - pregunta retórica corta + respuesta corta inmediata.

  Corre dentro de `validate_deck`. Las muletillas y el abuso de "No es X, es Y" son **errores**; el resto, **avisos**.
  Cada problema cita la oración (`«…»`).
- **`critique_voice`:** llamada LLM **separada** (`BedrockCritic` crea un `Agent` nuevo en cada llamada, sin
  historial ni herramientas). Usa como system prompt una rúbrica armada con `voice/examples.md` y `anti-patterns.md`.
  - El código descarta las observaciones que no citan una oración real del script (`droppedUnquoted`).
  - Es consultiva: no la exige la compuerta. Tope `critic.maxCalls`. Su uso de tokens suma al costo.
  - Proveedor por config (`critic.provider`, `critic.model`); `ollama` → "no implementado".

## Guardrails en vivo (fase 5)

- 4 escenarios en `demo/scenarios/guardrails/*/scenario.yml` (`kind: knowledge | converse | grounding`), ejecutados
  por `src/guardrails/scenarios.ts`. Usan el mismo código que el agente (`readKnowledgeGuarded`, el checker, el modelo
  con `guardrailConfig`) y verifican en código que el guardrail intervino como dice `expect`.
- **Cassettes** (`src/replay/cassette.ts`): `RecordingModel`/`ReplayModel`, `recordingChecker`/`replayChecker` y
  `recordingFetcher`/`replayFetcher`. Guardan la latencia real y la reproducen según `replay.speed`. Es la base del
  record/replay de la fase 7.
- Contextual grounding en `record_claim` (`checks.grounded`); costo de ApplyGuardrail sumado a la ejecución.
- `scripts/create-guardrail.ts`: simulación por defecto; solo crea con `--yes`.
- `npm run guardrails:check` mide la tasa de disparo; es candidato para el preflight.

## CLI de demo (fase 4)

- `npm run demo -- <acto>` (`src/cli/demo.tsx`, Ink 8 + React 19). Un comando por acto:

  | Comando | Acto | Qué hace |
  |---|---|---|
  | `brief` | 1 | Muestra el brief y los apuntes; marca los datos que parecen externos |
  | `research` | 2 | Etapa research, desde cero |
  | `plan` | 3 | Etapa deck; conserva `claims.json` |
  | `edit "…"` | 4 | Edición con diff |
  | `bedrock` | 5 | Costo por modelo + la línea de config a cambiar |
  | `guardrails [esc|all]` | 6 | Escenarios de Bedrock Guardrails (`--record`/`--replay`) |
  | `canva` | 7 | — |
  | `full` | 2 + 3 | — |

- **Arquitectura:**
  - `src/cli/session.ts` arma y ejecuta (sin imprimir) y emite `TraceEvent`.
  - La consola (`npm run agent`) y la vista Ink consumen los mismos eventos.
  - Lógica pura y testeada: `ui/rows.ts` (eventos → filas), `ui/chain.ts` (cadena `research ×3 → check_timing ✗ → …`)
    y `ui/diff.ts` (diff por palabra; si la similitud es menor a 0.5, se muestra antes/ahora).
- **`output/runs.jsonl`** registra cada ejecución (acto, modelo, segundos por etapa, tokens, costo). El Acto 5 ignora las corridas sin tokens.
- **Para el proyector:** solo las últimas 14 filas de la traza, columnas fijas, color con significado
  (✓ verde, ✗ rojo, guardrail con fondo rojo).

## Para el preflight (fase 7): lecciones aprendidas

- `aws sts get-caller-identity` puede dar OK con el token SSO **vencido**: el CLI usa credenciales de rol
  cacheadas (`~/.aws/cli/cache`), pero el SDK de JS (`fromIni`) necesita el token vigente de `~/.aws/sso/cache`
  y falla con "Token is expired". El preflight debe comprobar el token con el SDK de JS (una llamada real,
  p. ej. `ApplyGuardrail` o `Converse` con `maxTokens: 1`) y mostrar cuánto falta para que venza.

## Comandos

- Node 24 LTS (`.nvmrc`); npm (sin corepack/pnpm: un punto de fallo menos el día de la charla).
- `npm run demo -- <acto>` (la demo) · `npm run agent [-- --fresh | --act=research|deck | "instrucción" | --scope=a,b | --no-guardrail]` (consola, desarrollo) → `output/deck.json`, `claims.json`, `script.md`, `timing.md`
- `npm run typecheck` · `npm test` · `npm run spike:agent [-- --guardrail]` · `npm run spike:guardrail` · `npm run spike:canva [-- --reset]`
- Tests sin AWS: `src/replay/scripted-model.ts` reproduce turnos guionizados por el loop real de Strands
  (base del modo `--replay` de la fase 7).

## Forma de trabajo

- Por fases (0 spike → 7 confiabilidad). Al final de cada fase: tests, mostrar qué funciona y **detenerse**.
- No asumir APIs de memoria: verificar en `node_modules` o en la documentación y decir explícitamente lo no verificado.
- Si algo no existe en el SDK de TypeScript: parar y proponer alternativas, sin cambiar de lenguaje.
