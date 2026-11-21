// Source: src/__tests__/cli/commands/notification-inbox.test.ts
// Source: src/__tests__/cli/commands/maestro-run.test.ts
// Source: src/__tests__/cli/commands/profiling.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { notificationInbox } from '../../../cli/commands/notification-inbox';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { MockInstance } from 'vitest';
import { maestroRun } from '../../../cli/commands/maestro-run';
import type { MaestroRunStatus } from '../../../shared/maestro-run/status';
import path from 'path';
import os from 'os';
import { profilingStart } from '../../../cli/commands/profiling';
import { profilingStop } from '../../../cli/commands/profiling';
import { profilingStatus } from '../../../cli/commands/profiling';
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
describeSourceSuite('notification-inbox', () => {
	describe('notification inbox CLI', () => {
		const sendCommand = vi.fn();
		beforeEach(() => {
			vi.clearAllMocks();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
			vi.mocked(withMaestroClient).mockImplementation((action) => action({ sendCommand } as never));
		});
		afterEach(() => vi.restoreAllMocks());
		it('requests the desktop history and prints its verified snapshot as JSON', async () => {
			const result = {
				success: true,
				open: false,
				unreadCount: 1,
				notifications: [{ id: 'n1', read: false }],
			};
			sendCommand.mockResolvedValue(result);
			await notificationInbox({ action: 'list', unread: true }, { json: true });
			expect(sendCommand).toHaveBeenCalledWith(
				{ type: 'notification_inbox', action: 'list', unread: true },
				'notification_inbox_result'
			);
			expect(console.log).toHaveBeenCalledWith(JSON.stringify(result));
			expect(process.exit).not.toHaveBeenCalled();
		});
		it('reports failure rather than treating delivery as success', async () => {
			sendCommand.mockResolvedValue({ success: false, error: 'Notification not found' });
			await notificationInbox({ action: 'read', id: 'gone' }, { json: true });
			expect(console.log).toHaveBeenCalledWith(
				JSON.stringify({ success: false, error: 'Notification not found' })
			);
			expect(process.exit).toHaveBeenCalledWith(1);
		});
		it('preserves the resulting snapshot when a durable mutation fails', async () => {
			const result = {
				success: false,
				error: 'History could not be saved',
				historyPersistenceFailed: true,
				unreadCount: 1,
				notifications: [{ id: 'n1', read: false }],
			};
			sendCommand.mockResolvedValue(result);
			await notificationInbox({ action: 'read', id: 'n1' }, { json: true });
			expect(console.log).toHaveBeenCalledWith(JSON.stringify(result));
			expect(process.exit).toHaveBeenCalledWith(1);
		});
		it('reports transport failures through the shared JSON-aware failure helper', async () => {
			sendCommand.mockRejectedValue(new Error('Desktop disconnected'));
			await notificationInbox({ action: 'list' }, { json: true });
			expect(console.log).toHaveBeenCalledWith(
				JSON.stringify({ success: false, error: 'Desktop disconnected' })
			);
			expect(process.exit).toHaveBeenCalledWith(1);
		});
	});
});
describeSourceSuite('maestro-run', () => {
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
			mockSend({
				success: false,
				error: 'MaestroRun has not published a release for this Mac yet.',
			});
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
});
describeSourceSuite('profiling', () => {
	/** Capture the payload + responseType + timeout passed to sendCommand. */
	function mockSend(result: Record<string, unknown>) {
		const captured: { payload?: Record<string, unknown>; responseType?: string; timeout?: number } =
			{};
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi
					.fn()
					.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
						captured.payload = payload;
						captured.responseType = rt;
						captured.timeout = timeout;
						return Promise.resolve(result);
					}),
			} as never)
		);
		return captured;
	}

	describe('profiling commands', () => {
		let processExitSpy: MockInstance;

		beforeEach(() => {
			vi.clearAllMocks();
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
				throw new Error('__exit__');
			});
		});

		describe('start', () => {
			it('sends profiling_start and expects profiling_start_result', async () => {
				const cap = mockSend({ success: true, active: true });
				await profilingStart({});
				expect(cap.payload?.type).toBe('profiling_start');
				expect(cap.responseType).toBe('profiling_start_result');
			});

			it('exits non-zero when the app reports failure', async () => {
				mockSend({ success: false, error: 'boom' });
				await expect(profilingStart({})).rejects.toThrow('__exit__');
				expect(processExitSpy).toHaveBeenCalledWith(1);
			});
		});

		describe('stop', () => {
			it('requires --output and exits before connecting when missing', async () => {
				await expect(profilingStop({})).rejects.toThrow('__exit__');
				expect(withMaestroClient).not.toHaveBeenCalled();
				expect(processExitSpy).toHaveBeenCalledWith(1);
			});

			it('resolves a relative output path to absolute and sends a long timeout', async () => {
				const cap = mockSend({ success: true, path: '/tmp/out.zip', durationMs: 1234 });
				await profilingStop({ output: 'sub/out.zip' });
				expect(cap.payload?.type).toBe('profiling_stop');
				expect(cap.responseType).toBe('profiling_stop_result');
				const outputPath = cap.payload?.outputPath as string;
				expect(path.isAbsolute(outputPath)).toBe(true);
				expect(outputPath.endsWith(path.join('sub', 'out.zip'))).toBe(true);
				// Compression is slow; the command must raise the default 10s timeout.
				expect(cap.timeout ?? 0).toBeGreaterThan(60_000);
			});

			it('expands a leading ~ to the home directory', async () => {
				const cap = mockSend({ success: true, path: '/x.zip' });
				await profilingStop({ output: '~/Desktop/p.zip' });
				const outputPath = cap.payload?.outputPath as string;
				expect(outputPath).toBe(path.join(os.homedir(), 'Desktop', 'p.zip'));
			});

			it('exits non-zero when the app reports failure', async () => {
				mockSend({ success: false, error: 'no active recording' });
				await expect(profilingStop({ output: '/tmp/p.zip' })).rejects.toThrow('__exit__');
				expect(processExitSpy).toHaveBeenCalledWith(1);
			});
		});

		describe('status', () => {
			it('sends profiling_status and prints active state as JSON', async () => {
				const cap = mockSend({ success: true, active: true, elapsedMs: 4200 });
				await profilingStatus({ json: true });
				expect(cap.payload?.type).toBe('profiling_status');
				expect(cap.responseType).toBe('profiling_status_result');
				expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"active":true'));
			});
		});
	});
});
