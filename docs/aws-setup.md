# Configuración de AWS

## 1. Perfil local

El código usa el perfil `expo-generator` en `us-east-2` (`config/config.yml` → `aws`).
`AWS_PROFILE` y `AWS_REGION` lo sobreescriben.

Con IAM Identity Center (SSO):

```bash
aws configure sso --profile expo-generator   # región us-east-2
aws sso login --profile expo-generator
```

Con access keys:

```bash
aws configure --profile expo-generator
```

Verificación:

```bash
aws sts get-caller-identity --profile expo-generator
```

## 2. Permisos IAM mínimos

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeModels",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:*:*:inference-profile/us.anthropic.*",
        "arn:aws:bedrock:*:*:inference-profile/us.amazon.nova-*",
        "arn:aws:bedrock:*::foundation-model/anthropic.*",
        "arn:aws:bedrock:*::foundation-model/amazon.nova-*"
      ]
    },
    {
      "Sid": "Guardrails",
      "Effect": "Allow",
      "Action": ["bedrock:ApplyGuardrail", "bedrock:GetGuardrail", "bedrock:ListGuardrails"],
      "Resource": "*"
    },
    {
      "Sid": "Discovery",
      "Effect": "Allow",
      "Action": ["bedrock:ListInferenceProfiles", "bedrock:GetInferenceProfile", "bedrock:ListFoundationModels"],
      "Resource": "*"
    },
    {
      "Sid": "AnthropicMarketplaceFirstUse",
      "Effect": "Allow",
      "Action": ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
      "Resource": "*"
    }
  ]
}
```

Notas:
- Los inference profiles `us.*` enrutan a varias regiones de EE. UU., por eso los ARN usan `*` en la región.
- `scripts/create-guardrail.ts` (fase 5) necesitará además `bedrock:CreateGuardrail` y `bedrock:CreateGuardrailVersion`.
  Ese script lo ejecutas tú, a mano.
- El tier Standard del guardrail necesita `bedrock:ApplyGuardrail` también sobre
  `arn:aws:bedrock:*:*:guardrail-profile/us.guardrail.v1:0`. El `"Resource": "*"` de arriba ya lo cubre.
- Los modelos de Anthropic se cobran vía AWS Marketplace. La primera invocación necesita permiso de suscripción
  y, si es la primera vez en la cuenta, el formulario de caso de uso en la consola (Model access).

## 3. Verificar acceso a los modelos

Que un modelo aparezca listado no prueba que tengas acceso. La prueba real es una llamada mínima:

```bash
aws bedrock-runtime converse --profile expo-generator --region us-east-2 \
  --model-id us.amazon.nova-2-lite-v1:0 \
  --messages '[{"role":"user","content":[{"text":"di ok"}]}]' \
  --inference-config '{"maxTokens":5}'
```

Repite con `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (el modelo principal) y `mistral.mistral-large-3-675b-instruct`.

Con los modelos de Anthropic, la primera llamada acepta su oferta en AWS Marketplace ($0; se paga por token) y llega un correo
"You accepted an AWS Marketplace offer".

Verificado en fase 0 (us-east-2, rol `ExpoGeneratorDev`), con tool use forzado vía Converse:

| Funciona | No funciona |
|---|---|
| Nova 2 Lite | Nova Premier (fin de vida) |
| Nova Pro | GPT-5.5 (no habilitado en la cuenta) |
| gpt-oss-120b | Claude (pendiente el formulario de Anthropic; ver abajo) |
| Mistral Large 3 | |
| Qwen3 235B | |
| Llama 4 Maverick | |
| DeepSeek V3.2 | |
| Kimi K2.5 | |

Actualizado el 2026-10-05, ya enviado el formulario de Anthropic (llamada mínima por Converse):

| Funciona | No funciona |
|---|---|
| Claude Sonnet 4.5 (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) | Claude Sonnet 5.5 y Sonnet 5 ("not available for this account") |
| Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) | Claude Sonnet 4.6 ("use case details have not been submitted": puede ser demora en propagarse) |
