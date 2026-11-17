/**
 * @file claude-canary.test.ts
 * @description Tests for the claude-canary CLI command (the read and the
 * run-now of the app's Claude TUI canary).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const sendCommand = vi.fn();
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: (action: (client: { sendCommand: typeof sendCommand }) => unknown) =>
		action({ sendCommand }),
}));

import { claudeCanary } from '../../../cli/commands/claude-canary';

const failed = {
	claudeVersion: '2.1.326',
	maestroVersion: '1.2.0',
	checkedAt: Date.now() - 60_000,
	durationMs: 4_000,
	configDir: '/Users/test/.claude-a',
	ok: false,
	error: 'startup_dialog_blocked',
	exitCode: 11,
	screen: 'A new gate\n\n❯ No, exit',
};

describe('claude-canary', () => {
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

	it('reads the last result as JSON', async () => {
		sendCommand.mockResolvedValue({ success: true, last: failed });

		await claudeCanary({ json: true });

		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'claude_canary_status' },
			'claude_canary_status_result'
		);
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({ success: true, last: failed });
	});

	it('prints what Claude Code showed on a failure, and exits 2', async () => {
		sendCommand.mockResolvedValue({ success: true, last: failed });

		await expect(claudeCanary({})).rejects.toThrow('exit 2');

		const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
		expect(printed).toContain('2.1.326');
		expect(printed).toContain('startup_dialog_blocked');
		expect(printed).toContain('❯ No, exit');
	});

	it('says how to run it when it never ran', async () => {
		sendCommand.mockResolvedValue({ success: true, last: null });
		await claudeCanary({});
		expect(log.mock.calls[0][0]).toContain('maestro-cli claude-canary --run');
	});

	it('--run runs it now with a long timeout and reports the new result', async () => {
		sendCommand.mockResolvedValue({
			success: true,
			outcome: { ran: true, result: { ...failed, ok: true, error: undefined, screen: undefined } },
		});

		await claudeCanary({ run: true, json: true });

		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'claude_canary_run' },
			'claude_canary_run_result',
			expect.any(Number)
		);
		expect(sendCommand.mock.calls[0][2]).toBeGreaterThanOrEqual(3 * 60 * 1000);
		expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ success: true, ran: true });
		expect(exit).not.toHaveBeenCalled();
	});

	it('--run exits 1 with the reason when the canary could not run', async () => {
		sendCommand.mockResolvedValue({
			success: true,
			outcome: { ran: false, reason: 'Claude Code is not installed.' },
		});

		await expect(claudeCanary({ run: true })).rejects.toThrow('exit 1');
		expect(log.mock.calls[0][0]).toContain('Claude Code is not installed.');
	});
});
