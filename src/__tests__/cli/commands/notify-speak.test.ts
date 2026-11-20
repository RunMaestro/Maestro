/**
 * @file notify-speak.test.ts
 * @description Tests for `maestro-cli notify speak`.
 *
 * The verb is the CLI path to spoken notices, so what matters is the contract
 * an agent or a script can rely on: the text crosses the bridge unchanged, the
 * command says whether the line was HEARD, and a line the app chose not to
 * speak exits non-zero with the app's own reason and code.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	CommandTimeoutError: class CommandTimeoutError extends Error {},
	UnsupportedCommandError: class UnsupportedCommandError extends Error {},
}));

import { notifySpeak } from '../../../cli/commands/notify-speak';
import { withMaestroClient } from '../../../cli/services/maestro-client';

/** `process.exit` as a throw, so a failed command stops where the real one would. */
class Exit extends Error {
	constructor(readonly code: number | undefined) {
		super(`exit ${code}`);
	}
}

describe('notify-speak command', () => {
	let sent: Array<{ message: Record<string, unknown>; responseType: string; timeoutMs?: number }>;
	let reply: unknown;
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sent = [];
		reply = {
			success: true,
			result: { spoken: true, text: 'The build is green.', lineSource: 'given' },
		};
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Exit(code as number | undefined);
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn(
					async (message: Record<string, unknown>, responseType: string, timeoutMs?: number) => {
						sent.push({ message, responseType, timeoutMs });
						return reply;
					}
				),
			} as never)
		);
	});

	const logged = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
	const errors = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

	it('sends the text over the bridge and reports what was spoken', async () => {
		await notifySpeak('The build is green.', {});

		expect(sent).toHaveLength(1);
		expect(sent[0].message).toEqual({ type: 'notify_speak', text: 'The build is green.' });
		expect(sent[0].responseType).toBe('notify_speak_result');
		// Longer than a notice can wait in the app's queue, so the app answers first.
		expect(sent[0].timeoutMs).toBeGreaterThan(60_000);
		expect(logged()).toBe('Spoken: The build is green.');
	});

	it('prints the spoken line as JSON with --json', async () => {
		await notifySpeak('The build is green.', { json: true });

		expect(JSON.parse(logged())).toEqual({
			success: true,
			spoken: true,
			text: 'The build is green.',
		});
	});

	it('exits non-zero with the reason and code when the app did not speak', async () => {
		reply = {
			success: true,
			result: {
				spoken: false,
				code: 'voice-session-active',
				message: 'A voice session is live, so the notice was not spoken.',
			},
		};

		await expect(notifySpeak('hello', {})).rejects.toMatchObject({ code: 1 });
		expect(errors()).toBe(
			'Not spoken (voice-session-active): A voice session is live, so the notice was not spoken.'
		);
	});

	it('carries the code in JSON when the app did not speak', async () => {
		reply = {
			success: true,
			result: { spoken: false, code: 'speech-failed', message: 'No speech engine.' },
		};

		await expect(notifySpeak('hello', { json: true })).rejects.toBeInstanceOf(Exit);
		expect(JSON.parse(logged())).toEqual({
			success: false,
			spoken: false,
			code: 'speech-failed',
			error: 'No speech engine.',
		});
	});

	it('refuses empty text as a usage error, without calling the app', async () => {
		await expect(notifySpeak('   ', {})).rejects.toMatchObject({ code: 2 });
		expect(errors()).toContain('text cannot be empty');
		expect(sent).toEqual([]);
	});

	it('refuses text longer than a notice may be, without calling the app', async () => {
		await expect(notifySpeak('x'.repeat(601), {})).rejects.toMatchObject({ code: 2 });
		expect(errors()).toContain('600 characters');
		expect(sent).toEqual([]);
	});

	it('reports a bridge error', async () => {
		reply = { success: false, error: 'Text to speak is required.' };

		await expect(notifySpeak('hello', {})).rejects.toMatchObject({ code: 1 });
		expect(errors()).toBe('Error: Text to speak is required.');
	});

	it('reports an app that is not reachable', async () => {
		vi.mocked(withMaestroClient).mockRejectedValueOnce(new Error('Maestro is not running'));

		await expect(notifySpeak('hello', {})).rejects.toBeInstanceOf(Exit);
		expect(errors()).toBe('Error: Maestro is not running');
	});
});
