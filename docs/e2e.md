# Prueba end to end

Guía para correr todo el flujo, del brief a Canva, con una exposición propia. Modelo activo: Claude Sonnet 4.5
(`model.active: claude45` en `config/config.yml`).

## 0. Preparación (una vez por sesión)

```bash
cd ~/Isaac.log/SCD/expo-generator
nvm use                                   # Node 24 (.nvmrc)
npm install
aws sso login --profile expo-generator
npm run guardrails:check                  # opcional: confirma que Bedrock y el guardrail responden
```

## 1. Crea tu exposición

**`input/<nombre>.json`**: solo `title` y `durationMinutes` son obligatorios.

```json
{
  "title": "S3 más allá del bucket",
  "durationMinutes": 5,
  "topics": ["cloud"],
  "audience": "Estudiantes de ingeniería",
  "objective": "Que entiendan cómo guarda S3 los objetos",
  "mustInclude": ["Objetos, no archivos"],
  "callToAction": "Crear su primer bucket esta semana",
  "sources": ["https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingObjects.html"],
  "brand": { "colors": { "primary": "#FF9900" } }
}
```

| Campo | Obligatorio | Qué hace |
|---|---|---|
| `title`, `durationMinutes` | sí | El tema y el presupuesto de tiempo |
| `topic`, `audience`, `objective`, `mustInclude`, `callToAction`, `language` | no | Enriquecen el brief |
| `topics` | no | Temas de `config/sources.yml`: `inteligencia-artificial`, `tecnologia`, `bases-de-datos`, `cloud`, `medicina`, `biologia`. Sin `topics` se usan todos (más lento) |
| `sources` | no | Tus fuentes de verdad (https). Si el dominio no está en el catálogo, entran con tier `aportada` |
| `brand` | no | Sobreescribe campo a campo `config/brand-guide.yml` (`colors`, `fonts`, `mood`, `layout`) |

Una clave mal escrita da error con el nombre del campo.

**`knowledge/<nombre>/*.md`** (opcional): tus apuntes. Sin la carpeta, el agente trabaja solo con el brief y las fuentes.

- No uses citas textuales atribuidas a personas: el guardrail las bloquea (tema "Citas inventadas").
- `input/` y `knowledge/` no se suben a git (salvo el ejemplo).

**Para no repetir `--expo=<nombre>`**, cambia `expo.active` en `config/config.yml`.

## 2. Los actos

| # | Comando | Qué revisar |
|---|---|---|
| 1 | `npm run demo -- brief --expo=<nombre>` | Tu brief, tus apuntes, los temas y la carpeta de salida |
| 2 | `npm run demo -- research --expo=<nombre>` | La tabla "tus apuntes vs. las fuentes" y los claims. Si se detiene, ve al paso 3 |
| 3 | `npm run demo -- plan --expo=<nombre>` | `validate_deck` ✓ y tiempos dentro del presupuesto |
| 4 | `npm run demo -- edit "Haz el inicio más provocador" --expo=<nombre>` | El diff: solo cambia el hook |
| 5 | `npm run demo -- bedrock` | El costo de lo que corriste, por modelo |
| 6 | `npm run demo -- guardrails all` | 4 escenarios ✓; no depende de tu exposición |
| 7 | `npm run demo -- canva --expo=<nombre>` | Slides en Canva (todas las del deck; `canva.slides: 3` para la demo corta) y que el diseño se llame `<nombre>` |

- El Acto 2 parte desde cero: borra los artefactos de esa exposición en `output/<nombre>/`.
- El Acto 3 conserva los claims del Acto 2 y reescribe el deck.
- Para comparar modelos, cambia `model.active` (`claude45` | `mistral` | `nova`) y repite los actos 2 y 3.

## 3. Si el Acto 2 se detiene por tus apuntes

1. Abre `output/<nombre>/revision-apuntes.md`. Cada inconsistencia trae lo que dice la fuente y la URL.
2. **Antes de volver a correr el Acto 2**, copia `output/<nombre>/apuntes-validos/*.md` a `knowledge/<nombre>/`.
   Tienen todo menos lo inconsistente. El Acto 2 borra esa carpeta al empezar.
3. Agrega tus correcciones a esos archivos.
4. Vuelve a correr el Acto 2.

El Acto 3 no arranca si hay apuntes inconsistentes, si la revisión quedó incompleta o si editaste los apuntes sin repetir el Acto 2.

Veredictos:
- **✓ confirmado:** una fuente lo respalda; queda como claim citable.
- **✗ inconsistente:** la fuente dice otra cosa. Detiene el proceso.
- Lo que ninguna fuente confirma ni contradice **no se reporta**: se queda en tus apuntes y no detiene nada.
  Sus cifras igual no pueden aparecer en el script sin un claim externo verificado.

## 4. Resultado esperado

`output/<nombre>/`:

| Archivo | Contenido |
|---|---|
| `deck.json` | Secciones, slides y script: la fuente de verdad |
| `claims.json` | Procedencia de cada dato |
| `script.md` | El guion hablado |
| `timing.md` | Los tiempos por sección |
| `notes-review.json` + `revision-apuntes.md` | La revisión de tus apuntes |
| `apuntes-validos/` | Tus apuntes sin lo marcado, listos para copiar |

Además, `output/runs.jsonl` registra cada corrida (acto, exposición, modelo, segundos, tokens, costo) y Canva queda con un diseño llamado `<nombre>`.

## 5. Ten en cuenta

- **El Acto 7 crea un diseño real en tu cuenta de Canva.**
  - Poner el título todavía no se probó en vivo. Si falla, las slides se crean igual y verás "⚠ no se pudo titular".
  - Si el token de Canva venció, se abre el navegador para autorizar.
  - `--replay` usa un cassette grabado antes del título: ahí el título sale ✗ hasta que grabes otro con `--record`.
- **Tiempos con Mistral** (con Sonnet 4.5 todavía no se midieron):

  | Acto | Tiempo | Costo |
  |---|---|---|
  | 2 | 50–60 s | ~$0.04–0.07 |
  | 3 | 80–110 s | ~$0.10 |
  | 7 | ~50 s | sin costo de Bedrock |

- **Precios de Sonnet 4.5:** los de `config.yml` son los de lista de Anthropic, sin verificar en la página de Bedrock.
- **Si Mistral devuelve "unable to parse tool input JSON"**, vuelve a correr el acto.
- **Si el SDK dice "Token is expired"** aunque `aws sts get-caller-identity` funcione, repite `aws sso login --profile expo-generator`.
- **Si algo falla**, guarda la salida de la terminal; `output/runs.jsonl` tiene los tiempos de cada acto.
