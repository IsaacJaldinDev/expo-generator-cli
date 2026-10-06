# De apuntes a exposición

Un agente que convierte tus apuntes en una exposición: plan, guion con tiempos medidos, datos con su fuente y
slides en Canva. Nació para una charla en un AWS Student Community Day (35 minutos, en español), y sirve como
ejemplo de cómo se construye un agente con herramientas.

> **La idea que enseña:** un agente es un modelo con herramientas, estado de la tarea y la obligación de revisar
> su propio trabajo. El modelo decide qué hacer; el código decide qué se acepta.

## Qué hace

Cada acto es un comando:

| Acto | Comando | Qué muestra |
|---|---|---|
| 1 | `npm run demo -- brief` | Tu brief, tus apuntes y tus fuentes |
| 2 | `npm run demo -- research` | Contrasta tus apuntes con fuentes confiables y respalda los datos que faltan |
| 3 | `npm run demo -- plan` | Escribe el deck sección por sección, mide el tiempo y valida |
| 4 | `npm run demo -- edit "Haz el inicio más provocador"` | Edición puntual con diff: el código impide tocar otras secciones |
| 5 | `npm run demo -- bedrock` | Costo real por modelo y cómo cambiar de modelo con una línea |
| 6 | `npm run demo -- guardrails all` | Bedrock Guardrails en vivo: inyección, datos personales, citas inventadas, grounding |
| 7 | `npm run demo -- canva` | Slides en Canva vía MCP, con tu paleta |

Todos aceptan `--expo=<nombre>` para elegir la exposición.

## Probarlo en 5 minutos, sin AWS

Solo necesitas Node 24 (`nvm use`, el repo trae `.nvmrc`):

```bash
npm install
npm test                                      # 124 pruebas, sin red
npm run demo -- brief                         # el Acto 1 con la exposición de ejemplo
npm run demo -- guardrails all --replay       # el Acto 6 reproducido desde grabaciones
```

`--replay` reproduce las respuestas grabadas con su latencia real. No llama a AWS: se verificó con un perfil de
AWS que no existe.

## Correrlo de verdad

Necesitas:

- **Una cuenta de AWS con Amazon Bedrock** y acceso a un modelo. El principal es Claude Sonnet 4.5; los de
  Anthropic piden llenar el formulario de caso de uso. Mistral Large 3 y Nova 2 Lite funcionan como alternativa
  (`model.active` en `config/config.yml`).
- **Un perfil de AWS** (`aws.profile`; el del repo se llama `expo-generator`). Las credenciales viven en tu
  máquina, nunca en el repo. Guía: [docs/aws-setup.md](docs/aws-setup.md).
- **Un guardrail de Bedrock** (opcional, pero lo usan los actos 2 y 6). Se crea con `scripts/create-guardrail.ts`,
  que por defecto solo simula; detalle en [docs/guardrails.md](docs/guardrails.md). Sin guardrail:
  `guardrail.enabled: false`.
- **Canva Pro** solo para el Acto 7. La primera vez abre el navegador para autorizar.

El flujo completo, paso a paso, está en [docs/e2e.md](docs/e2e.md).

### Con tus propios datos

Una exposición es un nombre (por ejemplo `expo-de-s3`) que une tres carpetas:

```
input/expo-de-s3.json        el brief (solo title y durationMinutes son obligatorios)
knowledge/expo-de-s3/*.md    tus apuntes, en Markdown (opcional)
output/expo-de-s3/           lo que genera el agente
```

`input/ejemplo.json` y `knowledge/ejemplo/` son el ejemplo versionado. Tus propios `input/`, `knowledge/` y
`output/` no se suben a git.

Qué puede llevar el JSON, entre otras cosas: `topics` (de dónde se investiga: `inteligencia-artificial`,
`tecnologia`, `bases-de-datos`, `cloud`, `medicina`, `biologia`), `sources` (tus propias fuentes) y `brand` (tu paleta).

## Qué son los PLACEHOLDER

Varios archivos del repo traen la palabra `PLACEHOLDER` en un comentario. Significa: **contenido de ejemplo,
reemplázalo por el tuyo**. Ninguno hace falta para correr el proyecto; el ejemplo funciona tal como está.

| Dónde | Qué es | Qué hacer |
|---|---|---|
| `knowledge/ejemplo/*.md` | Apuntes de ejemplo sobre MCP. `notes.md` incluye a propósito un dato sin fuente (el "90%") para que el Acto 2 lo detecte | Crea `knowledge/<tu-exposición>/` con tus apuntes y borra el ejemplo si quieres |
| `voice/examples.md` | Transcripciones de ejemplo de cómo habla el autor. Alimentan la crítica de voz | Pon transcripciones reales de cómo hablas tú: es lo que más mejora esa crítica |
| `voice/anti-patterns.md` | Muletillas y vicios de ejemplo. El validador de voz lee la lista "Muletillas" | Ajusta la lista a las que tú quieres evitar |
| `config/brand-guide.yml` (`mood` y `fonts`) | Estilo y tipografías de ejemplo | Escribe tu estilo. Ojo: mientras `mood` contenga la palabra `PLACEHOLDER`, el código la ignora y usa un estilo neutro. Al reemplazarla, quita la palabra |
| `demo/scenarios/guardrails/*/` | Los 4 escenarios del Acto 6: inyección, datos personales y citas inventadas sembrados a propósito | Opcional. Adapta los textos a tu charla; `scenario.yml` explica cada uno |
| `demo/cassettes/guardrails/pii.json` | Grabación del escenario de datos personales; trae el texto de ejemplo | Se regenera con `npm run guardrails:check -- --record` |

Dos usos de la palabra que **no** son contenido de ejemplo: `src/render/canva.ts` la usa para saber si el `mood`
sigue sin escribir, y `tests/render-store.test.ts` la incluye dentro de un texto de prueba.

## Cómo está armado

```
src/agent/        el agente (Strands), el estado (deck.json y claims.json) y las compuertas de validación
src/tools/        las herramientas del agente: leer apuntes, buscar, registrar datos, editar, medir
src/validators/   reglas en código: tiempo, estructura del deck, voz
src/research/     descarga de fuentes y verificación de citas
src/guardrails/   Bedrock Guardrails (dentro de la llamada al modelo y por separado con ApplyGuardrail)
src/canva/        cliente MCP de Canva con OAuth
src/replay/       grabar y reproducir (modelo, guardrail, fuentes, Canva)
src/cli/          la interfaz de terminal (Ink)
config/           modelo, fuentes por tema, guía visual, límites
```

Lo que conviene mirar si quieres aprender cómo funciona un agente:

- `src/agent/agent.ts`: las herramientas y la compuerta que no deja terminar al agente hasta que valida.
- `src/agent/hooks.ts`: los topes (turnos, llamadas a herramientas) y la compuerta.
- `src/agent/deck-store.ts`: el estado de la tarea y la edición puntual que el código acota.
- `src/tools/review-note.ts`: el modelo propone un veredicto y el código lo verifica.

## Si quieres hacer tu propio agente

Este proyecto genera exposiciones, pero el patrón sirve para otras cosas: gastos del mes contra tu presupuesto,
apuntes de clase contra el temario, un chequeo de tu código. Lo que se reutiliza es la forma:

1. **Herramientas** que hacen una cosa cada una (`src/tools/`).
2. **Estado** fuera del modelo, en archivos que el código valida (`deck.json`, `claims.json`).
3. **Revisión**: reglas en código que el modelo no puede saltarse, y topes para que nunca quede en un bucle.

Cámbiale el dominio, no la estructura.

## Costos

Con Claude Sonnet 4.5, un Acto 2 más un Acto 3 salió en unos $0.35 en las pruebas del autor, más los intentos
fallidos. Cada ejecución queda en `output/runs.jsonl`, y el Acto 5 compara modelos. Los precios están en
`config/config.yml` y los de Claude **no están verificados** contra la página de precios de Bedrock: confírmalos.

## Límites conocidos

- La investigación solo usa las URLs semilla de los temas que eliges y las que aportas. No es un buscador.
- El veredicto "este apunte contradice la fuente" lo decide el modelo, y puede variar entre corridas. El
  código solo comprueba lo verificable (que la cita exista, que las cifras coincidan).
- Con `canva.slides: all` el tiempo de generación en Canva no está medido; con 3 slides son ~50 s.
- Canva no aplica colores como parámetro: la paleta viaja como texto del brief y Canva puede ajustarla.

## Más documentación

[docs/e2e.md](docs/e2e.md) · [docs/aws-setup.md](docs/aws-setup.md) · [docs/guardrails.md](docs/guardrails.md) ·
[docs/ollama.md](docs/ollama.md) · [CLAUDE.md](CLAUDE.md) (decisiones de arquitectura)

## Licencia

[MIT](LICENSE).
