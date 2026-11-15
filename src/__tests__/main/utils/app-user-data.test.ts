import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const threadState = vi.hoisted(() => ({ isMainThread: true }));
vi.mock('node:worker_threads', () => ({
	get isMainThread() {
		return threadState.isMainThread;
	},
}));

import { getAppUserDataDir } from '../../../main/utils/app-user-data';

describe('getAppUserDataDir', () => {
	afterEach(() => {
		threadState.isMainThread = true;
		vi.unstubAllEnvs();
	});

	it('reads the directory main published when running in a worker thread', () => {
		threadState.isMainThread = false;
		const published = path.resolve('/tmp/maestro-published-user-data');
		vi.stubEnv('MAESTRO_USER_DATA', published);

		expect(getAppUserDataDir()).toBe(published);
	});

	it('asks Electron on the main thread instead of the environment', () => {
		// The main thread never trusts the environment: in a checkout the
		// `electron` package resolves to a path string with no `app`, so a main
		// thread without Electron fails loudly rather than guessing a directory.
		vi.stubEnv('MAESTRO_USER_DATA', path.resolve('/tmp/should-not-be-read'));

		expect(() => getAppUserDataDir()).toThrow();
	});
});
