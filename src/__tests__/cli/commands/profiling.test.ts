/**
 * @file profiling.test.ts
 * @description Tests for the `profiling start|stop|status` CLI commands.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import path from 'path';
import os from 'os';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

import { profilingStart, profilingStop, profilingStatus } from '../../../cli/commands/profiling';
import { withMaestroClient } from '../../../cli/services/maestro-client';

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
