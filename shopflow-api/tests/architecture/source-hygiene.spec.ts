import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');

function listTypeScriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      found.push(...listTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.endsWith('.ts')) {
      found.push(fullPath);
    }
  }
  return found;
}

const SOURCE_FILES = listTypeScriptFiles(SRC_ROOT);

/** Markers of unfinished work that must never ship in `src/`. */
const FORBIDDEN_MARKERS = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bXXX\b/,
  /not implemented/i,
  /unimplemented/i,
  /placeholder/i,
  /\bWIP\b/,
];

/** Commented-out code blocks (`// import ...`, `// await ...`) are dead weight. */
const COMMENTED_OUT_CODE = /^\s*\/\/\s*(import|export|const|let|await|return|if|for|class|function)\b/m;

describe('src/ source hygiene', () => {
  it('contains no TODO/FIXME/placeholder markers', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const content = readFileSync(file, 'utf8');
      for (const marker of FORBIDDEN_MARKERS) {
        if (marker.test(content)) {
          offenders.push(`${path.relative(SRC_ROOT, file)} matches ${String(marker)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no commented-out code blocks', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const content = readFileSync(file, 'utf8');
      if (COMMENTED_OUT_CODE.test(content)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not use `any` as a type escape hatch in domain or application code', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const srcPath = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (!srcPath.startsWith('domain/') && !srcPath.startsWith('application/')) {
        continue;
      }
      const content = readFileSync(file, 'utf8');
      if (/:\s*any\b/.test(content) || /\bas\s+any\b/.test(content) || /<any>/.test(content)) {
        offenders.push(srcPath);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every layer populated with real implementations', () => {
    const count = (prefix: string): number =>
      SOURCE_FILES.filter((file) =>
        path.relative(SRC_ROOT, file).replace(/\\/g, '/').startsWith(prefix),
      ).length;
    expect(count('domain/')).toBeGreaterThanOrEqual(4);
    expect(count('application/')).toBeGreaterThanOrEqual(14);
    expect(count('adapters/')).toBeGreaterThanOrEqual(12);
    expect(count('composition/')).toBeGreaterThanOrEqual(2);
    expect(count('main/')).toBeGreaterThanOrEqual(3);
  });
});
