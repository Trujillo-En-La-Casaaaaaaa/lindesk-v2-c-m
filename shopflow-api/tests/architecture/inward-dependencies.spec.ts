import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface SourceFile {
  /** Path relative to the repository root, using forward slashes. */
  readonly relativePath: string;
  /** Path relative to `src/`, using forward slashes. */
  readonly srcPath: string;
  readonly imports: readonly string[];
}

const IMPORT_PATTERN =
  /(?:from\s*['"]([^'"]+)['"])|(?:import\s*\(\s*['"]([^'"]+)['"])|(?:require\s*\(\s*['"]([^'"]+)['"])/g;

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

function extractImports(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf8');
  const specifiers: string[] = [];
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Maps an import specifier to a layer-relative module name (`application/use-cases/x`). */
function moduleName(specifier: string, fromFile: string): string {
  if (specifier.startsWith('.')) {
    const resolved = path.resolve(path.dirname(fromFile), specifier);
    return path.relative(SRC_ROOT, resolved).replace(/\\/g, '/');
  }
  if (specifier.startsWith('node:')) {
    return specifier;
  }
  return specifier.split('/')[0].startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

const FILES: SourceFile[] = listTypeScriptFiles(SRC_ROOT).map((filePath) => ({
  relativePath: path.relative(REPO_ROOT, filePath).replace(/\\/g, '/'),
  srcPath: path.relative(SRC_ROOT, filePath).replace(/\\/g, '/'),
  imports: extractImports(filePath),
}));

function importsOf(file: SourceFile): Array<{ specifier: string; module: string }> {
  return file.imports.map((specifier) => ({
    specifier,
    module: moduleName(specifier, path.join(REPO_ROOT, file.relativePath)),
  }));
}

function violations(
  files: readonly SourceFile[],
  predicate: (file: SourceFile) => boolean,
  isForbidden: (module: string, file: SourceFile) => boolean,
): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (!predicate(file)) {
      continue;
    }
    for (const { specifier, module } of importsOf(file)) {
      if (isForbidden(module, file)) {
        found.push(`${file.relativePath} -> ${specifier} (${module})`);
      }
    }
  }
  return found;
}

const FORBIDDEN_FRAMEWORK_MODULES = ['express', 'cors', 'pg', 'dotenv'];
const FORBIDDEN_LAYER_PREFIXES = ['adapters/', 'composition/'];

describe('architecture: inward dependencies', () => {
  it('scans the whole src tree (guard is not vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(30);
    expect(FILES.some((file) => file.srcPath.startsWith('domain/'))).toBe(true);
    expect(FILES.some((file) => file.srcPath.startsWith('application/'))).toBe(true);
    expect(FILES.some((file) => file.srcPath.startsWith('adapters/'))).toBe(true);
    expect(FILES.some((file) => file.srcPath.startsWith('composition/'))).toBe(true);
    expect(FILES.some((file) => file.srcPath.startsWith('main/'))).toBe(true);
  });

  it('detects forbidden imports (detector self-check)', () => {
    const detector = (specifier: string): boolean =>
      FORBIDDEN_FRAMEWORK_MODULES.includes(specifier) ||
      FORBIDDEN_LAYER_PREFIXES.some((prefix) => specifier.startsWith(prefix));
    expect(detector('express')).toBe(true);
    expect(detector('pg')).toBe(true);
    expect(detector('adapters/inbound/http/server')).toBe(true);
    expect(detector('composition/container')).toBe(true);
    expect(detector('domain/model/order')).toBe(false);
    expect(detector('application/ports/outbound/clock.port')).toBe(false);
  });

  it('domain/ imports nothing from application, adapters, composition, express, or pg', () => {
    const found = violations(
      FILES,
      (file) => file.srcPath.startsWith('domain/'),
      (module) =>
        FORBIDDEN_LAYER_PREFIXES.some((prefix) => module.startsWith(prefix)) ||
        module.startsWith('application/') ||
        FORBIDDEN_FRAMEWORK_MODULES.includes(module),
    );
    expect(found).toEqual([]);
  });

  it('application/ imports only domain and its own ports, never adapters, composition, express, or pg', () => {
    const found = violations(
      FILES,
      (file) => file.srcPath.startsWith('application/'),
      (module) =>
        FORBIDDEN_LAYER_PREFIXES.some((prefix) => module.startsWith(prefix)) ||
        FORBIDDEN_FRAMEWORK_MODULES.includes(module),
    );
    expect(found).toEqual([]);
  });

  it('adapters never import composition or each other', () => {
    const found = violations(
      FILES,
      (file) => file.srcPath.startsWith('adapters/'),
      (module, file) => {
        if (module.startsWith('composition/')) {
          return true;
        }
        if (!module.startsWith('adapters/')) {
          return false;
        }
        // adapters/<direction>/<rest>: only the same direction may be imported.
        const ownDirection = file.srcPath.split('/')[1];
        return module.split('/')[1] !== ownDirection;
      },
    );
    expect(found).toEqual([]);
  });

  it('only composition and main construct concrete adapters', () => {
    const found = violations(
      FILES,
      (file) =>
        file.srcPath.startsWith('domain/') ||
        file.srcPath.startsWith('application/') ||
        file.srcPath.startsWith('adapters/') ||
        file.srcPath.startsWith('main/'),
      (module, file) =>
        module.startsWith('adapters/') &&
        file.srcPath.startsWith('domain/') === false &&
        file.srcPath.startsWith('application/') === false &&
        file.srcPath.startsWith('main/') === true,
    );
    // main/ must not reach into adapters directly; it goes through composition.
    expect(found).toEqual([]);
  });

  it('main/ entrypoints only depend on composition', () => {
    const mainFiles = FILES.filter((file) => file.srcPath.startsWith('main/'));
    expect(mainFiles.map((file) => file.srcPath).sort()).toEqual([
      'main/migrate.ts',
      'main/seed.ts',
      'main/server.ts',
    ]);
    const found = violations(
      mainFiles,
      () => true,
      (module) => module.startsWith('adapters/'),
    );
    expect(found).toEqual([]);
  });

  it('composition is the only place allowed to import every concrete adapter', () => {
    const compositionImports = FILES.filter((file) => file.srcPath.startsWith('composition/')).flatMap(
      (file) => importsOf(file).map((entry) => entry.module),
    );
    expect(compositionImports).toContain('adapters/inbound/http/server');
    expect(compositionImports).toContain('adapters/outbound/persistence/postgres/postgres-unit-of-work');
    expect(compositionImports).toContain('adapters/outbound/notification/http-notification.adapter');
    expect(compositionImports).toContain('adapters/outbound/system/console-logger.adapter');
  });
});
