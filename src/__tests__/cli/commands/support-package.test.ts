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

	// The package is screened before it is written. With no dialog to answer,
	// the CLI refuses unless --allow-secrets is passed.
	describe('secret screen', () => {
		const refusal = {
			success: false,
			error: 'Found 1 possible secret in the support package. Nothing was sent.',
			code: 'SECRETS_FOUND',
			secretFindings: [
				{ kind: 'slack-token', line: 40, preview: '••••••••wxyz', source: 'logs.json' },
			],
			secretScreenNote:
				'Secret screen model did not run: Not installed. Pattern detection still ran.',
		};

		it('does not send allowSecrets unless the flag is passed', async () => {
			const cap = mockSend({ success: true, path: '/tmp/x.zip' });
			await supportPackage({ output: '/tmp' });
			expect(cap.payload?.options).not.toHaveProperty('allowSecrets');
		});

		it('sends allowSecrets: true for --allow-secrets', async () => {
			const cap = mockSend({ success: true, path: '/tmp/x.zip' });
			await supportPackage({ output: '/tmp', allowSecrets: true });
			expect((cap.payload?.options as Record<string, unknown>).allowSecrets).toBe(true);
		});

		it('refuses, exits non-zero, and prints the masked findings', async () => {
			mockSend(refusal);
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			await expect(supportPackage({ output: '/tmp' })).rejects.toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
			const printed = errorSpy.mock.calls.map(([line]) => line).join('\n');
			expect(printed).toContain(refusal.error);
			expect(printed).toContain('Slack token ••••••••wxyz (logs.json, line 40)');
			expect(printed).toContain(refusal.secretScreenNote);
			expect(printed).toContain('--allow-secrets');
		});

		it('carries the findings in --json', async () => {
			mockSend(refusal);
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

			await expect(supportPackage({ output: '/tmp', json: true })).rejects.toThrow('__exit__');

			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
				success: false,
				error: refusal.error,
				code: 'SECRETS_FOUND',
				secretFindings: refusal.secretFindings,
				secretScreenNote: refusal.secretScreenNote,
			});
		});
	});
});
