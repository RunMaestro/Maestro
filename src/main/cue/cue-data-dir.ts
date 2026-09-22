/**
 * Cue's data directory - the one piece of desktop-specific wiring
 * `cue-db.ts` used to reach for directly (`app.getPath('userData')`).
 *
 * Part of decoupling the Cue engine from Electron (see
 * Plans/maestro-lib-cli-migration.md, "standalone engine"): a headless
 * runner has no `app`, so the default resolution goes through
 * `resolveMaestroUserDataDir()` (shared with `maestro-cli`'s `getConfigDir()`)
 * instead. `initCueDb`'s existing `dbPathOverride` parameter still wins when a
 * caller passes one explicitly - this module only supplies the default.
 */

import * as path from 'path';
import { resolveMaestroUserDataDir } from '../../shared/maestroUserDataDir';

/** Default path for Cue's SQLite database, desktop or standalone alike. */
export function resolveDefaultCueDbPath(): string {
	return path.join(resolveMaestroUserDataDir(), 'cue.db');
}
