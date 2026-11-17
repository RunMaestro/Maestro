/**
 * @file pianola-supervisor-watch.test.ts
 *
 * The store-file watch the supervisor sets up on start(): a native fs.watch on
 * the store's directory, a stat-poll fallback when the OS file-watch limit is
 * used up (EMFILE / ENOSPC, MAESTRO-151), and a Sentry report for any other
 * watch failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		existsSync: vi.fn(() => true),
		mkdirSync: vi.fn(),
		watch: vi.fn(),
		watchFile: vi.fn(),
		unwatchFile: vi.fn(),
	};
});
vi.mock('../../../main/pianola/pianola-store-main', () => ({
	readSupervisorTargets: vi.fn(() => []),
	removeSupervisorTarget: vi.fn(() => []),
	supervisorFilePath: vi.fn(() => '/fake/maestro-pianola-supervisor.json'),
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	resolveMaestroCliScriptPath: () => '/fake/maestro-cli.js',
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../shared/platformDetection', () => ({ isWindows: () => false }));

import * as fs from 'fs';
import { PianolaSupervisor } from '../../../main/pianola/pianola-supervisor';
import { captureException } from '../../../main/utils/sentry';
import { logger } from '../../../main/utils/logger';

function errnoError(code: string, message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

function makeSupervisor(): PianolaSupervisor {
	return new PianolaSupervisor({
		isEnabled: () => true,
		getPianolaAgentId: () => 'pianola-agent',
		spawnChild: () => {
			throw new Error('no targets, nothing should spawn');
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('PianolaSupervisor store watch', () => {
	it('watches the store directory natively when the OS allows it', () => {
		vi.mocked(fs.watch).mockReturnValue(new EventEmitter() as unknown as fs.FSWatcher);
		makeSupervisor().start();

		expect(fs.watch).toHaveBeenCalledWith('/fake', expect.any(Function));
		expect(fs.watchFile).not.toHaveBeenCalled();
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each(['EMFILE', 'ENOSPC'])(
		'falls back to polling the store file on %s instead of reporting it',
		(code) => {
			vi.mocked(fs.watch).mockImplementation(() => {
				throw errnoError(code, `${code}: too many open files, watch '/fake'`);
			});
			const sup = makeSupervisor();
			sup.start();

			expect(captureException).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(code), expect.any(String));
			expect(fs.watchFile).toHaveBeenCalledWith(
				'/fake/maestro-pianola-supervisor.json',
				expect.objectContaining({ persistent: false }),
				expect.any(Function)
			);

			// watchFile's last overload has no options argument, so index the call loosely.
			const listener = (vi.mocked(fs.watchFile).mock.calls[0] as unknown[])[2];
			sup.stopAll();
			expect(fs.unwatchFile).toHaveBeenCalledWith(
				'/fake/maestro-pianola-supervisor.json',
				listener
			);
		}
	);

	it('still reports a watch failure that is not the OS limit', () => {
		const error = errnoError('EACCES', "EACCES: permission denied, watch '/fake'");
		vi.mocked(fs.watch).mockImplementation(() => {
			throw error;
		});
		makeSupervisor().start();

		expect(captureException).toHaveBeenCalledWith(error, {
			operation: 'pianola:supervisor:watch',
			dir: '/fake',
		});
		expect(fs.watchFile).not.toHaveBeenCalled();
	});
});
