/**
 * Minimal SQL surface used by the persistence adapters. Declared here so that
 * application/use-case code can be written against repositories without ever importing a
 * database driver type.
 */
export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query<Row>(sql: string, params?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
}
