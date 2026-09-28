/**
 * @file support-package.test.ts
 * @description Tests for `maestro-cli support-package`: the directory is made
 * absolute before it crosses the bridge, and `--no-*` flags become the same
 * section toggles the Debug Package modal sends.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { supportPackage } from '../../../cli/commands/support-package';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';

function mockSend(result: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				captured.payload = payload;
				captured.responseType = rt;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return captured;
}

describe('support-package command', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends an absolute outputDir and includes every section by default', async () => {
		const cap = mockSend({
			success: true,
			path: '/tmp/x.zip',
			filesIncluded: [],
			totalSizeBytes: 1,
		});
		await supportPackage({ output: 'out' });
		expect(cap.payload?.type).toBe('support_package_create');
		expect(cap.responseType).toBe('support_package_create_result');
		expect(cap.payload?.outputDir).toBe(path.resolve(process.cwd(), 'out'));
		expect(cap.payload?.options).toEqual({
			includeLogs: true,
			includeErrors: true,
			includeSessions: true,
			includeGroupChats: true,
			includeBatchState: true,
		});
	});

	it('turns --no-* flags into false toggles', async () => {
		const cap = mockSend({ success: true, path: '/tmp/x.zip' });
		await supportPackage({ output: '/tmp', logs: false, groupChats: false });
		expect(cap.payload?.options).toMatchObject({ includeLogs: false, includeGroupChats: false });
		expect((cap.payload?.options as Record<string, boolean>).includeErrors).toBe(true);
	});

	it('exits non-zero when the app reports failure', async () => {
		mockSend({ success: false, error: 'disk full' });
		await expect(supportPackage({ output: '/tmp' })).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});
});
