# Ollama para `critique_voice` (puerta abierta, NO implementado)

`critic.provider: ollama` ya es un valor válido en `config/config.yml`. Mientras no se implemente, la fase 3
devolverá un error claro de "no implementado".

## Cómo agregarlo cuando se pida

1. La interfaz `CriticModelProvider` ya existe en `src/providers/critic.ts`, con `BedrockCritic` como referencia.
   Hoy `OllamaCritic` solo rechaza con "no implementado". Para implementarlo, reemplaza su método `critique()`
   por uno que construya un `Agent` nuevo (sin herramientas, con `structuredOutputSchema: CritiqueSchema`)
   sobre el modelo de abajo, igual que `BedrockCritic`. `createCritic()` ya lo elige cuando `critic.provider: ollama`.
2. Strands TS 1.19.0 no tiene un provider nativo de Ollama. Se usa `OpenAIModel` (verificado en
   `@strands-agents/sdk/models/openai`) contra el endpoint compatible con OpenAI:
   ```ts
   import { OpenAIModel } from '@strands-agents/sdk/models/openai';
   new OpenAIModel({
     api: 'chat', // el default es 'responses' y Ollama no lo soporta
     modelId: 'qwen3:8b',
     apiKey: 'ollama',
     clientConfig: { baseURL: 'http://localhost:11434/v1' },
   });
   ```
3. `npm i openai` (es un peer opcional del SDK y no está instalado).
4. La crítica es una llamada separada y sin herramientas, así que basta con chat completions.
