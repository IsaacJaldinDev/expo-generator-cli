# Ollama para `critique_voice` (puerta abierta, NO implementado)

`critic.provider: ollama` ya es un valor válido en `config/config.yml`. Mientras no se implemente, la fase 3
devolverá un error claro de "no implementado".

## Cómo agregarlo cuando se pida

1. Implementar `CriticModelProvider` para Ollama en `src/providers/ollama.ts`. La interfaz se define en la fase 3.
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
