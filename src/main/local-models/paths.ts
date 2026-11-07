/**
 * Where Local Models keeps its bytes on disk.
 *
 *   userData/models/<model-id>/        one directory per model (see model-store.ts)
 *   userData/runtimes/<runtime-id>/    one directory per native runtime (see runtime-store.ts)
 *
 * The roots are owned by the core Local Models service, not by any one consumer.
 * Before the service existed both lived one level deeper, under an `acappella/`
 * directory, because voice was the only consumer; `storage-migration.ts` moves
 * those installs up without a re-download.
 */

import { app } from 'electron';
import * as path from 'path';

/** Model store root, relative to the data dir. */
export const LOCAL_MODELS_DIRNAME = 'models';

/** Runtime store root, relative to the data dir. */
export const LOCAL_RUNTIMES_DIRNAME = 'runtimes';

/**
 * Resolve the Maestro data dir, matching the pianola / plugin store semantics.
 * A new path constant is deliberately NOT introduced: `MAESTRO_USER_DATA` has to
 * keep working, and it only does if every store asks the same question.
 */
export function localModelsDataDir(): string {
	if (process.env.MAESTRO_USER_DATA) return path.resolve(process.env.MAESTRO_USER_DATA);
	return app.getPath('userData');
}
