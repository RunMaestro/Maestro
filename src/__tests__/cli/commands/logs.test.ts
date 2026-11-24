/**
 * @file logs.test.ts
 * @description Tests for the logs CLI command (the CLI side of the System Log Viewer).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const sendCommand = vi.fn();
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: (action: (client: { sendCommand: typeof sendCommand }) => unknown) =>
		action({ sendCommand }),
}));

import { logs } from '../../../cli/commands/logs';

const entry = { timestamp: 0, level: 'error', message: 'stats db failed', context: 'Stats' };

describe('logs', () => {
	let log: MockInstance;
	let exit: MockInstance;

	beforeEach(() => {
		sendCommand.mockReset();
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reads the log with the filters the user gave', async () => {
		sendCommand.mockResolvedValue({ success: true, entries: [entry] });

		await logs({ level: 'error', context: 'Stats', limit: '5', json: true });

		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'system_logs_read', level: 'error', context: 'Stats', limit: 5 },
			'system_logs_read_result'
		);
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({ success: true, entries: [entry] });
	});

	it('turns --since into an instant before asking', async () => {
		sendCommand.mockResolvedValue({ success: true, entries: [] });
		const before = Date.now();

		await logs({ since: '1h' });

		const since = sendCommand.mock.calls[0][0].since as number;
		expect(since).toBeLessThanOrEqual(before - 3_600_000 + 1_000);
		expect(since).toBeGreaterThanOrEqual(before - 3_600_000 - 1_000);
	});

	it('prints one line per entry with its level and context', async () => {
		sendCommand.mockResolvedValue({ success: true, entries: [entry] });

		await logs({});

		const line = log.mock.calls[0][0] as string;
		expect(line).toContain('1970-01-01T00:00:00.000Z');
		expect(line).toContain('ERROR');
		expect(line).toContain('[Stats] stats db failed');
	});

	it('refuses a bad --limit without asking the app', async () => {
		await expect(logs({ limit: 'many' })).rejects.toThrow('exit 1');
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('exits 1 with the app error when the read fails', async () => {
		sendCommand.mockResolvedValue({ success: false, error: 'Unknown log level: loud' });

		await expect(logs({ level: 'loud', json: true })).rejects.toThrow('exit 1');
		expect(exit).toHaveBeenCalledWith(1);
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({
			success: false,
			error: 'Unknown log level: loud',
		});
	});

	it('--clear sends the viewer Clear', async () => {
		sendCommand.mockResolvedValue({ success: true });

		await logs({ clear: true, json: true });

		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'system_logs_clear' },
			'system_logs_clear_result'
		);
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({ success: true });
	});
});
