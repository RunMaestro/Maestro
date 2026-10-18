/**
 * @file maestro-run.test.ts
 * @description `maestro-cli maestro-run status|install|grant`: each verb is one
 * `maestro_run_command` WS message to the service the Settings tile calls.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

import { maestroRun } from '../../../cli/commands/maestro-run';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { MaestroRunStatus } from '../../../shared/maestro-run/status';

const APP = '/Users/me/Applications/MaestroRun.app';

function status(overrides: Partial<MaestroRunStatus> = {}): MaestroRunStatus {
	return {
		supported: true,
		enabled: true,
		phase: 'needs-access',
		appPath: APP,
		binaryPath: `${APP}/Contents/MacOS/maestro-run`,
		installedVersion: '0.2.0',
		fullDiskAccess: 'not-granted',
		latestVersion: null,
		updateAvailable: false,
		installing: false,
		watchingForAccess: false,
		detail: null,
		checkedAt: 1,
		...overrides,
	};
}

function mockSend(result: Record<string, unknown>) {
	const sendCommand = vi.fn().mockResolvedValue(result);
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({ sendCommand } as never)
	);
	return sendCommand;
}

describe('maestro-run commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	const printed = () => logSpy.mock.calls.map((call) => call[0]).join('\n');

	it('status sends one command and prints the phase with the next step', async () => {
		const send = mockSend({ success: true, status: status() });
		await maestroRun('status', {});
		expect(send).toHaveBeenCalledWith(
			{ type: 'maestro_run_command', action: 'status' },
			'maestro_run_result',
			undefined
		);
		expect(printed()).toContain('MaestroRun: Installed, waiting for Full Disk Access');
		expect(printed()).toContain('Full Disk Access: not-granted');
		expect(printed()).toContain('Next: maestro-cli maestro-run grant');
	});

	it('status --check-latest asks for the release check and reports an update', async () => {
		const send = mockSend({
			success: true,
			status: status({ updateAvailable: true, latestVersion: '0.3.0' }),
		});
		await maestroRun('status', { checkLatest: true });
		expect(send.mock.calls[0][0]).toEqual({
			type: 'maestro_run_command',
			action: 'status',
			checkLatest: true,
		});
		expect(printed()).toContain('Version: 0.2.0 (update available: 0.3.0)');
	});

	it('status --json emits the whole status', async () => {
		mockSend({ success: true, status: status({ phase: 'ready', fullDiskAccess: 'granted' }) });
		await maestroRun('status', { json: true });
		expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
			success: true,
			phase: 'ready',
			binaryPath: `${APP}/Contents/MacOS/maestro-run`,
		});
	});

	it('status on a host that is not macOS says so and stops there', async () => {
		mockSend({ success: true, status: status({ supported: false, phase: 'unsupported' }) });
		await maestroRun('status', {});
		expect(printed()).toBe('MaestroRun: MaestroRun is available on macOS only');
	});

	it('install waits longer than the default command budget', async () => {
		const send = mockSend({ success: true, status: status() });
		await maestroRun('install', {});
		expect(send.mock.calls[0][0]).toEqual({ type: 'maestro_run_command', action: 'install' });
		expect(send.mock.calls[0][2]).toBeGreaterThanOrEqual(60_000);
	});

	it('grant passes --reveal and tells the user what to do', async () => {
		const send = mockSend({ success: true, status: status({ watchingForAccess: true }) });
		await maestroRun('grant', { reveal: true });
		expect(send.mock.calls[0][0]).toEqual({
			type: 'maestro_run_command',
			action: 'grant',
			reveal: true,
		});
		expect(printed()).toContain('Switch MaestroRun on');
		expect(printed()).toContain('Watching for the Full Disk Access switch.');
	});

	it('exits 1 with the service error', async () => {
		mockSend({ success: false, error: 'MaestroRun has not published a release for this Mac yet.' });
		await expect(maestroRun('install', {})).rejects.toThrow('__exit__');
		expect(errorSpy).toHaveBeenCalledWith(
			'Error: MaestroRun has not published a release for this Mac yet.'
		);
	});

	it('reports a failure as JSON with the status it has', async () => {
		mockSend({ success: false, error: 'nope', status: status({ phase: 'not-installed' }) });
		await expect(maestroRun('install', { json: true })).rejects.toThrow('__exit__');
		expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
			success: false,
			error: 'nope',
			phase: 'not-installed',
		});
	});

	it('exits 1 when the app cannot be reached', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro is not running'));
		await expect(maestroRun('status', {})).rejects.toThrow('__exit__');
		expect(errorSpy).toHaveBeenCalledWith('Error: Maestro is not running');
	});
});
