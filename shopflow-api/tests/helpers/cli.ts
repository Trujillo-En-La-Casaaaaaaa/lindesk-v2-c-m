import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, TEST_DATABASE_URL } from './database';

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** JSON log lines printed by the CLI on stdout. */
  readonly logs: Array<Record<string, unknown>>;
}

const DIST_ENTRYPOINTS: Record<string, string> = {
  migrate: path.join(PROJECT_ROOT, 'dist', 'main', 'migrate.js'),
  seed: path.join(PROJECT_ROOT, 'dist', 'main', 'seed.js'),
  start: path.join(PROJECT_ROOT, 'dist', 'main', 'server.js'),
};

export function requireBuiltEntrypoint(script: 'migrate' | 'seed' | 'start'): string {
  const entrypoint = DIST_ENTRYPOINTS[script];
  if (entrypoint === undefined || !existsSync(entrypoint)) {
    throw new Error(
      `Missing build output ${entrypoint ?? script}. Run \`npm run build\` before the CLI/server tests.`,
    );
  }
  return entrypoint;
}

function parseLogs(stdout: string): Array<Record<string, unknown>> {
  const logs: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      logs.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // Non-JSON diagnostics are not part of the evidence we assert on.
    }
  }
  return logs;
}

export interface RunScriptOptions {
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

export const MIGRATIONS_DIRECTORY = path.join(PROJECT_ROOT, 'migrations');

function buildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    MIGRATIONS_DIR: MIGRATIONS_DIRECTORY,
    LOG_LEVEL: 'info',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === '') {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

export interface RunProcessOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  /** `npm` needs a shell on Windows; `process.execPath` must not go through one. */
  readonly shell?: boolean;
}

export function runProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: RunProcessOptions = {},
): Promise<CliResult> {
  const { timeoutMs = 30_000, cwd = PROJECT_ROOT, shell = false } = options;
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(command, [...args], { env, cwd, shell });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`command timed out: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, logs: parseLogs(stdout) });
    });
  });
}

/** Runs `npm run <script>` exactly as documented in the handoff validation steps. */
export function runNpmScript(
  script: 'migrate' | 'seed',
  options: RunScriptOptions = {},
): Promise<CliResult> {
  return runProcess('npm', ['run', script], buildEnv(options.env), {
    timeoutMs: options.timeoutMs ?? 60_000,
    shell: true,
  });
}

/** Runs two `npm run <script>` processes concurrently. */
export async function runNpmScriptPair(
  first: 'migrate' | 'seed',
  second: 'migrate' | 'seed',
): Promise<[CliResult, CliResult]> {
  const results = await Promise.all([
    runNpmScript(first, { timeoutMs: 120_000 }),
    runNpmScript(second, { timeoutMs: 120_000 }),
  ]);
  return [results[0], results[1]];
}
