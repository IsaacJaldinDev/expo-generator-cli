import type { TraceSink } from '../agent/events.ts';
import type { GuardrailChecker } from '../guardrails/apply.ts';
import { missingNumbers, numbersIn, quoteAppearsIn } from './pages.ts';
import type { FoundPassage, SourceLibrary } from './search.ts';

export interface PassageCheck {
  verified: boolean;
  checks: { quoteFound: boolean; numbersMatch: boolean; grounded?: boolean; groundingScore?: number };
  reasons: string[];
}

/**
 * ¿El pasaje respalda la afirmación? Todo en código:
 * 1. el pasaje sigue en la página descargada, 2. contiene todas las cifras de la afirmación,
 * 3. contextual grounding de Bedrock Guardrails (si está activo).
 * Lo usan record_claim (huecos) y review_note (apuntes del autor).
 */
export async function verifyAgainstPassage(
  text: string,
  passage: FoundPassage,
  deps: { library: SourceLibrary; checker?: GuardrailChecker | undefined; sink: TraceSink },
): Promise<PassageCheck> {
  const quote = passage.text;
  let quoteFound = false;
  const reasons: string[] = [];
  try {
    // Se re-verifica contra la página: el pasaje no se da por bueno solo porque lo produjo el código.
    quoteFound = quoteAppearsIn(quote, await deps.library.text(passage.url));
    if (!quoteFound) reasons.push('El pasaje ya no aparece en la fuente.');
  } catch (err) {
    reasons.push(`No se pudo descargar la fuente: ${(err as Error).message}`);
  }
  const missing = missingNumbers(text, quote);
  if (missing.length) {
    const inPassage = numbersIn(quote);
    reasons.push(
      `El pasaje no contiene las cifras ${missing.join(', ')}` +
        (inPassage.length ? ` (menciona ${inPassage.slice(0, 6).join(', ')}).` : '.'),
    );
  }
  const checks: PassageCheck['checks'] = { quoteFound, numbersMatch: missing.length === 0 };
  // Contextual grounding (Bedrock Guardrails): ¿el pasaje respalda semánticamente la afirmación?
  if (deps.checker && quoteFound && checks.numbersMatch) {
    const g = await deps.checker.ground({ source: quote, query: text, content: text });
    checks.grounded = g.grounded;
    if (g.groundingScore !== undefined) checks.groundingScore = g.groundingScore;
    if (!g.grounded) {
      deps.sink({ kind: 'guardrail', via: 'apply-guardrail', interventions: g.interventions });
      reasons.push(`Bedrock Guardrails: el pasaje no respalda la afirmación (grounding ${g.groundingScore?.toFixed(2) ?? '?'}).`);
    }
  }
  return { verified: checks.quoteFound && checks.numbersMatch && checks.grounded !== false, checks, reasons };
}
