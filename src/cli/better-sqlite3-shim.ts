/**
 * What `import Database from 'better-sqlite3'` resolves to inside the
 * `maestro-cli` bundle (aliased in `scripts/build-cli.mjs`).
 *
 * Importing it loads nothing: modules like `cue-db.ts` are part of the bundle
 * whichever command runs, and most commands never open a database. The first
 * `new Database(...)` finds a copy whose native addon fits this runtime (see
 * `utils/native-sqlite.ts`) and either returns the real instance or throws
 * `SqliteUnavailableError` with instructions. Only the constructor is
 * forwarded, which is all the bundled modules use; types still come from the
 * real package, since the alias exists only at build time.
 */

import { loadBetterSqlite3 } from './utils/native-sqlite';

function Database(filename: string, options?: object): unknown {
	const RealDatabase = loadBetterSqlite3();
	return new RealDatabase(filename, options);
}

export default Database;
