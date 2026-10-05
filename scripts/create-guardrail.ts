/**
 * Crea el guardrail recomendado para la demo (docs/guardrails.md). NUNCA se ejecuta solo: lo corres tú.
 *   npm run guardrail:create            # simulación: muestra la configuración y no crea nada
 *   npm run guardrail:create -- --yes   # la crea en tu cuenta (perfil y región de config/config.yml)
 * Luego copia el id en config/config.yml → guardrail.id.
 */
import { BedrockClient, CreateGuardrailCommand, type CreateGuardrailCommandInput } from '@aws-sdk/client-bedrock';
import { fromIni } from '@aws-sdk/credential-providers';
import { loadConfig } from '../src/schemas/config.ts';

const cfg = loadConfig();
const filter = (type: string, strength: 'LOW' | 'MEDIUM' | 'HIGH') => ({
  type: type as never,
  inputStrength: strength,
  outputStrength: strength,
  inputAction: 'BLOCK' as const,
  outputAction: 'BLOCK' as const,
});

export const RECOMMENDED: CreateGuardrailCommandInput = {
  name: 'expo-generator-demo',
  description: 'Guardrail de la demo "De apuntes a exposición" (AWS Student Community Day)',
  blockedInputMessaging: '🛡 Bedrock Guardrails bloqueó esta solicitud.',
  blockedOutputsMessaging: '🛡 Bedrock Guardrails bloqueó esta respuesta.',
  // El tier Standard (mejor detección en español) exige el perfil cross-region del guardrail.
  crossRegionConfig: { guardrailProfileIdentifier: 'us.guardrail.v1:0' },
  contentPolicyConfig: {
    tierConfig: { tierName: 'STANDARD' },
    filtersConfig: [
      { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE', inputAction: 'BLOCK' },
      filter('HATE', 'MEDIUM'),
      filter('INSULTS', 'MEDIUM'),
      filter('SEXUAL', 'MEDIUM'),
      filter('VIOLENCE', 'MEDIUM'),
      filter('MISCONDUCT', 'MEDIUM'),
    ],
  },
  topicPolicyConfig: {
    tierConfig: { tierName: 'STANDARD' },
    topicsConfig: [
      {
        name: 'Citas inventadas',
        definition:
          'Afirmaciones que presentan palabras inventadas o no verificadas como citas textuales atribuidas a personas reales e identificables.',
        examples: [
          'Escribe una cita textual de Jeff Bezos sobre MCP',
          'Inventa algo que dijo el CEO de AWS sobre agentes',
          'Dame un testimonio con las palabras exactas de un profesor real',
        ],
        type: 'DENY',
        // Solo en INPUT: en OUTPUT producía falsos positivos con frases como "la documentación lo compara con…".
        // Las citas inventadas en la salida las atrapa el contextual grounding contra claims.json.
        inputEnabled: true,
        inputAction: 'BLOCK',
        outputEnabled: false,
      },
    ],
  },
  sensitiveInformationPolicyConfig: {
    piiEntitiesConfig: ['EMAIL', 'PHONE'].map((type) => ({
      type: type as never,
      action: 'ANONYMIZE' as const,
      inputAction: 'ANONYMIZE' as const,
      outputAction: 'ANONYMIZE' as const,
      inputEnabled: true,
      outputEnabled: true,
    })),
  },
  contextualGroundingPolicyConfig: {
    filtersConfig: [
      { type: 'GROUNDING', threshold: 0.75, action: 'BLOCK', enabled: true },
      { type: 'RELEVANCE', threshold: 0.5, action: 'BLOCK', enabled: true },
    ],
  },
};

if (!process.argv.includes('--yes')) {
  console.log(JSON.stringify(RECOMMENDED, null, 2));
  console.log(`\nSimulación: no se creó nada. Para crearlo en ${cfg.aws.region} con el perfil ${cfg.aws.profile}: npm run guardrail:create -- --yes`);
} else {
  const client = new BedrockClient({ region: cfg.aws.region, credentials: fromIni({ profile: cfg.aws.profile }) });
  const res = await client.send(new CreateGuardrailCommand(RECOMMENDED));
  console.log(`Guardrail creado: id=${res.guardrailId} version=${res.version}\nCópialo en config/config.yml → guardrail.id y pon guardrail.enabled: true.`);
}
