/**
 * Loading `better-sqlite3` from the `maestro-cli` bundle. The implementation moved into the
 * library (`src/shared/maestro-lib/store/native-sqlite.ts`) so the TUI can load it too; this
 * re-export keeps every CLI import working.
 */
export * from '../../shared/maestro-lib/store/native-sqlite';
