import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Font files bundled from Fontsource (all SIL OFL 1.1), and the character sets each document needs. */
const SOURCES: { pkg: string; css: string[]; subsets: string[] }[] = [
  { pkg: '@fontsource-variable/inter', css: ['wght.css'], subsets: ['latin', 'latin-ext'] },
  { pkg: '@fontsource/noto-serif', css: ['400.css', '700.css'], subsets: ['latin', 'latin-ext'] },
  { pkg: '@fontsource/noto-nastaliq-urdu', css: ['400.css', '700.css'], subsets: ['arabic'] },
  { pkg: '@fontsource/noto-naskh-arabic', css: ['400.css', '700.css'], subsets: ['arabic'] },
];

const FACE = /\/\*\s*([^*]+?)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;

/**
 * Builds @font-face rules with the fonts embedded as data, so documents render the same everywhere,
 * including Urdu in exported HTML opened on another computer, and no file or network access is needed.
 */
export async function loadFontCss(nodeModules: string): Promise<string> {
  const rules: string[] = [];
  for (const source of SOURCES) {
    for (const cssFile of source.css) {
      const dir = join(nodeModules, source.pkg);
      const css = await readFile(join(dir, cssFile), 'utf8');
      // Rules are named "<family>-<subset>-<weight>-<style>". The family itself can contain a subset's
      // name ("noto-naskh-arabic"), so the subset is matched right after the family, never anywhere.
      const family = source.pkg.split('/')[1]!;
      for (const [, name, face] of css.matchAll(FACE)) {
        if (!source.subsets.some((subset) => name!.startsWith(`${family}-${subset}-`))) continue;
        const file = /url\(\.\/files\/([^)]+?\.woff2)\)/.exec(face!)?.[1];
        if (!file) continue;
        const data = (await readFile(join(dir, 'files', file))).toString('base64');
        rules.push(face!.replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${data}) format('woff2');`).replace(/font-display:\s*\w+;/, 'font-display: block;'));
      }
    }
  }
  return rules.join('\n');
}
