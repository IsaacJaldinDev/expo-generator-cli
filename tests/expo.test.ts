import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PATHS, resolveExpo, type ExpoPaths } from '../src/schemas/expo.ts';
import { loadBrandGuide } from '../src/schemas/brand.ts';
import { loadSourceCatalog, loadSources, SourceCatalogSchema, tierFor, USER_TIER } from '../src/schemas/sources.ts';
import { loadKnowledgeFragments, readKnowledgeGuarded } from '../src/tools/read-knowledge.ts';

/** Carpetas temporales de input/knowledge/output con la guía visual y las fuentes reales del repo. */
function workspace(inputs: Record<string, unknown>): ExpoPaths {
  const root = mkdtempSync(join(tmpdir(), 'expo-'));
  const paths = { ...DEFAULT_PATHS, inputDir: join(root, 'input'), knowledgeDir: join(root, 'knowledge'), outputDir: join(root, 'output') };
  mkdirSync(paths.inputDir);
  mkdirSync(paths.knowledgeDir);
  for (const [name, body] of Object.entries(inputs)) {
    writeFileSync(join(paths.inputDir, `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return paths;
}

describe('input/<expo>.json', () => {
  it('lo mínimo (title + durationMinutes) alcanza: guía visual y fuentes por defecto, salida en output/<expo>/', () => {
    const paths = workspace({ 'expo-de-s3': { title: 'S3 más allá del bucket', durationMinutes: 5 } });
    const expo = resolveExpo('expo-de-s3', paths);
    expect(expo.brief).toEqual({ title: 'S3 más allá del bucket', durationMinutes: 5, language: 'es', mustInclude: [] });
    expect(expo.brand).toEqual(loadBrandGuide());
    expect(expo.brandOverridden).toBe(false);
    expect(expo.sources.seeds).toEqual(loadSources().seeds);
    expect(expo.sources.topics).toEqual(Object.keys(loadSourceCatalog().topics));
    expect(expo.userSources).toBe(0);
    expect(expo.outputDir).toBe(join(paths.outputDir, 'expo-de-s3'));
  });

  it('sin knowledge/<expo>/ no hay apuntes locales; con la carpeta, se usan solo esos apuntes', async () => {
    const paths = workspace({ a: { title: 'A', durationMinutes: 5 }, b: { title: 'B', durationMinutes: 5 } });
    mkdirSync(join(paths.knowledgeDir, 'b'));
    writeFileSync(join(paths.knowledgeDir, 'b', 'notes.md'), 'S3 guarda objetos, no archivos.\n');
    writeFileSync(join(paths.knowledgeDir, 'suelto.md'), 'No pertenece a ninguna exposición.\n');

    const a = resolveExpo('a', paths);
    expect(a.knowledgeDir).toBeUndefined();
    expect(loadKnowledgeFragments(a.knowledgeDir)).toEqual([]);
    expect(await readKnowledgeGuarded(a.knowledgeDir, undefined, () => {})).toEqual({ files: [], fragments: [], blocked: [] });

    const b = resolveExpo('b', paths);
    expect(loadKnowledgeFragments(b.knowledgeDir).map((f) => f.id)).toEqual(['notes#1']);
  });

  it('brand sobreescribe campo a campo la guía por defecto', () => {
    const paths = workspace({ x: { title: 'X', durationMinutes: 5, brand: { colors: { primary: '#FF9900' }, mood: 'industrial' } } });
    const expo = resolveExpo('x', paths);
    const base = loadBrandGuide();
    expect(expo.brandOverridden).toBe(true);
    expect(expo.brand.colors).toEqual({ ...base.colors, primary: '#FF9900' });
    expect(expo.brand.fonts).toEqual(base.fonts);
    expect(expo.brand.mood).toBe('industrial');
  });

  it('topics elige los temas del catálogo: solo sus dominios y sus semillas', () => {
    const paths = workspace({ s3: { title: 'S3', durationMinutes: 5, topics: ['cloud', 'bases-de-datos'] } });
    const { sources } = resolveExpo('s3', paths);
    expect(sources.topics).toEqual(['cloud', 'bases-de-datos']);
    expect(tierFor(sources, 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html')).toBe('primary');
    expect(tierFor(sources, 'https://www.postgresql.org/docs/current/')).toBe('primary');
    expect(tierFor(sources, 'https://www.who.int/x')).toBeUndefined(); // medicina no está elegido
    expect(sources.seeds.every((s) => tierFor(sources, s.url))).toBe(true);
    expect(() => resolveExpo('s3', workspace({ s3: { title: 'S3', durationMinutes: 5, topics: ['astrologia'] } }))).toThrow(/Tema desconocido: astrologia/);
  });

  it('sources del autor: entran como semillas con tier "aportada" (o el del catálogo si el dominio ya está)', () => {
    const paths = workspace({
      s3: {
        title: 'S3',
        durationMinutes: 5,
        topics: ['cloud'],
        sources: ['https://www.allthingsdistributed.com/2023/07/building-and-operating-a-pretty-big-storage-system.html', { url: 'https://www.who.int/es/x', note: 'mía' }],
      },
    });
    const expo = resolveExpo('s3', paths);
    expect(expo.userSources).toBe(2);
    expect(tierFor(expo.sources, 'https://www.allthingsdistributed.com/otra')).toBe(USER_TIER);
    expect(tierFor(expo.sources, 'https://www.who.int/es/x')).toBe('primary');
    expect(expo.sources.seeds.map((s) => s.url)).toContain('https://www.who.int/es/x');
    expect(() => resolveExpo('s3', workspace({ s3: { title: 'S3', durationMinutes: 5, sources: ['http://inseguro.com/x'] } }))).toThrow(/solo https/);
  });

  it('catálogo: un dominio con dos tiers distintos o una semilla fuera de su tema es un error', () => {
    const topic = (domains: Record<string, string[]>, url: string) => ({ label: 'x', domains, seeds: [{ url }] });
    expect(() =>
      SourceCatalogSchema.parse({ topics: { a: topic({ primary: ['x.org'] }, 'https://x.org/1'), b: topic({ secondary: ['x.org'] }, 'https://x.org/2') } }),
    ).toThrow(/un dominio tiene un solo tier/);
    expect(() => SourceCatalogSchema.parse({ topics: { a: topic({ primary: ['x.org'] }, 'https://y.org/1') } })).toThrow(/fuera de los dominios del tema a/);
  });

  it('errores claros: archivo inexistente, JSON roto, campos faltantes o desconocidos, nombre inválido', () => {
    const paths = workspace({ roto: '{ "title": ', falta: { title: 'T' }, typo: { title: 'T', durationMinutes: 5, audiencia: 'x' } });
    expect(() => resolveExpo('nada', paths)).toThrow(/No existe .*nada\.json/);
    expect(() => resolveExpo('roto', paths)).toThrow(/no es JSON válido/);
    expect(() => resolveExpo('falta', paths)).toThrow(/durationMinutes/);
    expect(() => resolveExpo('typo', paths)).toThrow(/audiencia/);
    expect(() => resolveExpo('../config/config', paths)).toThrow(/Nombre de exposición inválido/);
  });

  it('input/ejemplo.json del repo es válido y usa knowledge/ejemplo/', () => {
    const expo = resolveExpo('ejemplo');
    expect(expo.knowledgeDir).toBe(join('knowledge', 'ejemplo'));
    expect(loadKnowledgeFragments(expo.knowledgeDir).some((f) => f.text.includes('90%'))).toBe(true);
  });
});
