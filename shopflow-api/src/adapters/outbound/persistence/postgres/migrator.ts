import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import type { Logger } from '../../../../application/ports/outbound/logger.port';

export interface MigrationResult {
  /** Migration ids applied by this run. */
  readonly applied: readonly string[];
  /** Migration ids that were already recorded and therefore skipped. */
  readonly skipped: readonly string[];
}

export interface PostgresMigratorOptions {
  /** Explicit migrations directory; defaults to `MIGRATIONS_DIR`, then conventional locations. */
  readonly migrationsDir?: string | undefined;
  readonly logger?: Logger | undefined;
}

interface MigrationFile {
  readonly id: string;
  readonly sql: string;
}

/** Arbitrary but stable advisory-lock key serializing concurrent migration runs. */
const MIGRATION_LOCK_KEY = 5_150_390_645_34;

const BOOTSTRAP_SCHEMA_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id         text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

function resolveMigrationsDir(explicit: string | undefined, logger: Logger | undefined): string {
  const candidates: string[] = [];
  if (explicit !== undefined && explicit.trim().length > 0) {
    candidates.push(path.resolve(explicit));
  }
  const fromEnv = process.env['MIGRATIONS_DIR'];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    candidates.push(path.resolve(fromEnv));
  }
  candidates.push(path.resolve(process.cwd(), 'migrations'));
  // dist/adapters/outbound/persistence/postgres -> repository root
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', '..', 'migrations'));

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      logger?.debug('using migrations directory', { directory: candidate });
      return candidate;
    }
  }
  throw new Error(`migrations directory not found; looked in: ${candidates.join(', ')}`);
}

/**
 * Applies `migrations/*.sql` in lexicographic order, recording each applied id in
 * `schema_migrations`. The whole run happens in one transaction guarded by
 * `pg_advisory_xact_lock`, so `npm run migrate` is safe to repeat and safe to run
 * concurrently: the second runner waits, then sees the ids and applies nothing.
 */
export class PostgresMigrator {
  constructor(
    private readonly pool: Pool,
    private readonly options: PostgresMigratorOptions = {},
  ) {}

  async migrate(): Promise<MigrationResult> {
    const files = this.loadMigrations();
    const client = await this.pool.connect();
    const applied: string[] = [];
    const skipped: string[] = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(BOOTSTRAP_SCHEMA_MIGRATIONS_SQL);

      const existing = await client.query('SELECT id FROM schema_migrations');
      const appliedIds = new Set((existing.rows as Array<{ id: string }>).map((row) => row.id));

      for (const file of files) {
        if (appliedIds.has(file.id)) {
          skipped.push(file.id);
          continue;
        }
        await client.query(file.sql);
        await client.query(
          `INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
          [file.id],
        );
        appliedIds.add(file.id);
        applied.push(file.id);
      }

      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.options.logger?.warn('migration rollback failed', {
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
    } finally {
      client.release();
    }

    this.options.logger?.info('migrations processed', { applied, skipped });
    return { applied, skipped };
  }

  /** True when every migration file on disk is recorded in `schema_migrations`. */
  async isSchemaReady(): Promise<boolean> {
    const files = this.loadMigrations();
    try {
      const result = await this.pool.query('SELECT id FROM schema_migrations');
      const appliedIds = new Set((result.rows as Array<{ id: string }>).map((row) => row.id));
      return files.every((file) => appliedIds.has(file.id));
    } catch (error) {
      this.options.logger?.debug('schema readiness check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Reads and sorts every `*.sql` file of the migrations directory. */
  loadMigrations(): readonly MigrationFile[] {
    const directory = resolveMigrationsDir(this.options.migrationsDir, this.options.logger);
    const names = readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith('.sql'))
      .sort();
    if (names.length === 0) {
      throw new Error(`no *.sql migrations found in ${directory}`);
    }
    return names.map((name) => ({
      id: name.replace(/\.sql$/i, ''),
      sql: readFileSync(path.join(directory, name), 'utf8'),
    }));
  }
}
