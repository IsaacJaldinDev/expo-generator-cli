import { tierFor, type Sources } from '../schemas/sources.ts';
import { htmlToText, rankPassages, type PageFetcher, type Passage } from './pages.ts';

/** Proveedor de candidatos. Modo por defecto: URLs semilla. Un proveedor con API key implementaría esto. */
export interface SearchProvider {
  candidates(query: string): Promise<string[]>;
}

export const seedsProvider = (sources: Sources): SearchProvider => ({
  candidates: async () => sources.seeds.map((s) => s.url),
});

export type FoundPassage = Passage & { id: string; tier: string };

/**
 * Biblioteca de fuentes: descarga (con caché por ejecución), extrae texto, rankea pasajes y
 * nunca sale de la allowlist, venga de donde venga la URL.
 */
export class SourceLibrary {
  private cache = new Map<string, Promise<string>>();
  /** Pasajes entregados al agente en esta ejecución: record_claim solo puede citar uno de estos. */
  private passages = new Map<string, FoundPassage>();

  constructor(
    readonly sources: Sources,
    private readonly fetcher: PageFetcher,
    private readonly provider: SearchProvider = seedsProvider(sources),
  ) {}

  tier(url: string): string | undefined {
    return tierFor(this.sources, url);
  }

  /** Texto de la página (cacheado). Lanza si la URL está fuera de la allowlist. */
  text(url: string): Promise<string> {
    if (!this.tier(url)) return Promise.reject(new Error(`${url} está fuera de la allowlist de config/sources.yml`));
    let page = this.cache.get(url);
    if (!page) {
      page = this.fetcher(url).then(htmlToText);
      page.catch(() => this.cache.delete(url)); // un fallo de red no queda cacheado
      this.cache.set(url, page);
    }
    return page;
  }

  passage(id: string): FoundPassage | undefined {
    return this.passages.get(id);
  }

  async search(query: string, limit = 5): Promise<{ passages: FoundPassage[]; failed: string[] }> {
    const urls = (await this.provider.candidates(query)).filter((u) => this.tier(u));
    const failed: string[] = [];
    const ranked = await Promise.all(
      urls.map(async (url) => {
        try {
          return rankPassages(url, await this.text(url), query);
        } catch {
          failed.push(url);
          return [];
        }
      }),
    );
    const passages = ranked
      .flat()
      .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
      .slice(0, limit)
      .map((p) => {
        const found: FoundPassage = { id: `p${this.passages.size + 1}`, ...p, score: Math.round(p.score * 100) / 100, tier: this.tier(p.url)! };
        this.passages.set(found.id, found);
        return found;
      });
    return { passages, failed };
  }
}
