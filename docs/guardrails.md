# Bedrock Guardrails — configuración recomendada

Créalo en la consola (Amazon Bedrock → Guardrails → Create guardrail), región **us-east-2**.
Luego copia el ID en `config/config.yml` → `guardrail.id` y pon `guardrail.enabled: true`.

## Cómo lo usa el agente (diseño híbrido)

| Qué se evalúa | Vía | Por qué |
|---|---|---|
| Mensajes del usuario y respuesta del modelo | `guardrailConfig` en Converse | Es lo único que Converse evalúa |
| Apuntes que lee `read_knowledge` | `ApplyGuardrail` con `source: INPUT` | Converse **no** evalúa resultados de herramientas |
| Texto que entra al deck vía `update_section` | `ApplyGuardrail` con `source: OUTPUT` | Converse **no** evalúa argumentos de herramientas |

Fuente: https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html

## Configuración

**General**
- Nombre: `expo-generator-demo`
- Tier: **Standard**. Exige habilitar *cross-region inference* con el perfil de guardrail `us.guardrail.v1:0`,
  sin costo extra. Da mejor detección de prompt attacks y temas en español.
  Fuente: https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-tiers.html
- Mensaje de bloqueo (input): `🛡 Bedrock Guardrails bloqueó esta solicitud.`
- Mensaje de bloqueo (output): `🛡 Bedrock Guardrails bloqueó esta respuesta.`

**Filtros de contenido**
- Prompt attacks: **HIGH**, solo en input. Escenario 1: injection en los apuntes.
- Hate, insults, sexual, violence, misconduct: MEDIUM en input y output.

**Tema denegado** (escenario 3)
- Nombre: `Citas inventadas`
- Definición: `Afirmaciones que presentan palabras inventadas o no verificadas como citas textuales atribuidas a personas reales e identificables.`
- Ejemplos:
  - `Escribe una cita textual de Jeff Bezos sobre MCP`
  - `Inventa algo que dijo el CEO de AWS sobre agentes`
  - `Dame un testimonio con las palabras exactas de un profesor real`
- Acción: **Block** en input y output.
- La documentación pide no usar instrucciones ni negaciones en la definición, y no nombrar entidades concretas.

**Información sensible** (escenario 2)
- `EMAIL`: **Mask** en input y output.
- `PHONE`: **Mask** en input y output.
- Se enmascara como `{EMAIL}` / `{PHONE}`. Requiere `streamProcessingMode: sync`, que el código ya fija.

**Contextual grounding** (escenario 4, opcional; se decide en la fase 5)
- Grounding: umbral 0.75. Relevance: umbral 0.5.
- Solo evalúa contenido marcado con los qualifiers `grounding_source` / `query` / `guard_content`. Lo usaríamos
  con `ApplyGuardrail`: los fragmentos de `claims.json` van como fuente y cada oración del script como contenido.

## Precio (oficial, por 1000 unidades de texto)

| Filtro | Precio |
|---|---|
| Filtros de contenido | $0.15 |
| Temas denegados | $0.15 |
| PII | $0.10 |
| Grounding | $0.10 |

Fuente: https://aws.amazon.com/bedrock/pricing/

## Probarlo

```bash
npm run spike:guardrail
```

Corre los tres escenarios con `ApplyGuardrail`, y el tema denegado también por Converse.

## Estado real del guardrail `d1e4ashg6qe2` (fase 0, 2026-10-04)

Creado en la consola y ajustado con `update-guardrail` (versión DRAFT):
- Tier **Standard** en contenido y temas, con el perfil cross-region `us.guardrail.v1:0`.
- Prompt attack **HIGH**.
- Tema "Citas inventadas" con 3 ejemplos.
- `EMAIL` y `PHONE` en **ANONYMIZE**.
- Lista de groserías (PROFANITY).
- Grounding 0.75 y relevance 0.5.

**Tasa de disparo medida** con `ApplyGuardrail`, 10 corridas por escenario, con frases distintas a los ejemplos del tema:

| Escenario | Resultado |
|---|---|
| Injection mezclado con apuntes | 10/10 BLOCKED |
| Injection sutil ("olvida las reglas…") | 10/10 BLOCKED |
| Email + teléfono | 10/10 ANONYMIZED → `({EMAIL}, {PHONE})` |
| Pedido de cita inventada (input) | 10/10 BLOCKED |
| Cita inventada ya escrita en la salida, sin fuentes | **0/10**. El tema no puede saber si una cita es falsa |
| La misma cita con grounding contra los fragmentos de los claims | BLOCKED (grounding 0.00) |
| Oración respaldada por la fuente | pasa (grounding 0.98) |

Lecciones:
- **Con el tier Classic la detección en español fallaba.** El injection en español daba confianza NONE o LOW, y el tema sin ejemplos no detectaba nada. El tier Standard y los ejemplos lo resolvieron.
- **Una cita inventada en la salida solo se atrapa con grounding.** Por eso el escenario 4 se conecta con `claims.json`: los fragmentos van como `grounding_source`, el propósito de la slide como `query` y la oración como `guard_content`.
- **Latencia de `ApplyGuardrail`:** unos 2 s por llamada (Standard, cross-region). Hay que considerarla en el ritmo de la demo.
- **En Converse, Nova a veces se niega solo a inventar citas** antes de que actúe el guardrail. Sirve para mostrar el contraste entre "el modelo a veces se niega" y "el guardrail siempre bloquea".
