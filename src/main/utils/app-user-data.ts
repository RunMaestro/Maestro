/**
 * Electron's `userData` directory, for main-process modules that a worker
 * thread also loads.
 *
 * A worker thread has no `electron`. In a packaged app the module does not even
 * resolve there, so a value import of `electron` anywhere in a worker's import
 * graph throws at load, before the worker runs a line. Dev hides this, because
 * `node_modules/electron` resolves (to a path string). Pianola's memory worker
 * failed every packaged launch this way, through the session storage readers
 * it shares with main.
 *
 * Main publishes the same directory as `MAESTRO_USER_DATA` at startup
 * (`src/main/index.ts`, before any store loads), and a worker inherits the
 * environment, so a worker reads it from there. The main thread keeps asking
 * Electron, which also honors a later `app.setPath('userData')`.
 */

import { isMainThread } from 'node:worker_threads';
import { resolveUserDataDir } from '../../shared/maestro-lib/paths/userDataDir';

export function getAppUserDataDir(): string {
	if (!isMainThread) return resolveUserDataDir();
	// Lazy, so importing this module never loads `electron` in a worker.
	const { app } = require('electron') as typeof import('electron');
	return app.getPath('userData');
}
