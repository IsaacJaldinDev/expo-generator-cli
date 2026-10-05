import type { BrandGuide } from '../schemas/brand.ts';
import type { Brief } from '../schemas/brief.ts';
import type { Config } from '../schemas/config.ts';
import type { DeckRuleParams } from '../validators/deck-rules.ts';

/** Reúne en un solo lugar los umbrales que usan check_timing, validate_deck y los renderers. */
export function deckParams(cfg: Config, brief: Brief, brand: BrandGuide): DeckRuleParams {
  return {
    wordsPerMinute: cfg.timing.wordsPerMinute,
    budgetSeconds: Math.round(brief.durationMinutes * 60),
    minFillRatio: cfg.timing.minFillRatio,
    maxWordsPerSlide: brand.layout.maxWordsPerSlide,
    minPurposeWords: 3,
  };
}
