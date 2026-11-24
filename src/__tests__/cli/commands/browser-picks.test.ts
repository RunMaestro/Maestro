/**
 * @file browser-picks.test.ts
 * @description Tests for `maestro-cli browser-picks` (the Design Mode chips
 * waiting in an agent's composer: list them, or remove one).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveSessionId: vi.fn(() => 'active-session'),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => `resolved-${id}`),
	readActiveAgentId: vi.fn((): string | null => 'active-session'),
}));

import { browserPicks } from '../../../cli/commands/open-browser';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readActiveAgentId, resolveAgentId } from '../../../cli/services/storage';
import type { DesignPickSummary } from '../../../shared/designPickCommands';

type SentMessage = Record<string, unknown>;

/** Stub the desktop: record what the CLI sent and answer with `reply`. */
function stubDesktop(reply: Record<string, unknown>) {
	const sent: Array<{ message: SentMessage; responseType: string }> = [];
	vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
		const client = {
			sendCommand: vi.fn(async (message: SentMessage, responseType: string) => {
				sent.push({ message, responseType });
				return { type: responseType, ...reply };
			}),
		};
		return fn(client as never);
	});
	return sent;
}

const signUp: DesignPickSummary = {
	id: 'pick-1',
	kind: 'element',
	label: 'button.cta "Sign up"',
	url: 'https://example.com/',
	note: 'make it bigger',
	text: 'Design Mode element from https://example.com/\n`button.cta`',
	screenshot: true,
};

const heading: DesignPickSummary = {
	id: 'pick-2',
	kind: 'element',
	label: 'h1 "Welcome"',
	url: 'https://example.com/',
	note: '',
	text: 'Design Mode element from https://example.com/\n`h1`',
	screenshot: false,
};

/** Everything written to stdout, in order, as one string per call. */
function printed(spy: MockInstance): string[] {
	return spy.mock.calls.map((call) => String(call[0]));
}

describe('browser-picks command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	});

	describe('list', () => {
		it('asks the active agent for its chips and prints each with its block', async () => {
			const sent = stubDesktop({ success: true, aiTabId: 'ai-1', picks: [signUp, heading] });

			await browserPicks({});

			expect(sent).toEqual([
				{
					message: { type: 'design_pick_command', action: 'list', sessionId: 'active-session' },
					responseType: 'design_pick_command_result',
				},
			]);
			expect(printed(logSpy)).toEqual([
				'Design Mode chips in the composer of tab ai-1 (2):',
				[
					'',
					'pick-1  element  button.cta "Sign up"',
					'  URL: https://example.com/',
					'  Note: make it bigger',
					'  Screenshot: attached',
					'',
					signUp.text,
				].join('\n'),
				[
					'',
					'pick-2  element  h1 "Welcome"',
					'  URL: https://example.com/',
					'  Note: (none)',
					'  Screenshot: none',
					'',
					heading.text,
				].join('\n'),
			]);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('names the agent with --agent', async () => {
			const sent = stubDesktop({ success: true, aiTabId: 'ai-1', picks: [] });

			await browserPicks({ agent: 'agent-7' });

			expect(resolveAgentId).toHaveBeenCalledWith('agent-7');
			expect(sent[0].message.sessionId).toBe('resolved-agent-7');
		});

		it('says so when the composer has no chips', async () => {
			stubDesktop({ success: true, aiTabId: 'ai-1', picks: [] });

			await browserPicks({});

			expect(printed(logSpy)).toEqual(['No Design Mode chips in the composer of tab ai-1']);
		});

		it('prints the chips as JSON, every field the desktop sent', async () => {
			stubDesktop({ success: true, aiTabId: 'ai-1', picks: [signUp] });

			await browserPicks({ json: true });

			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: true,
				sessionId: 'active-session',
				aiTabId: 'ai-1',
				picks: [signUp],
			});
		});
	});

	describe('remove', () => {
		it('sends the chip id and reports the chip it took off', async () => {
			const sent = stubDesktop({ success: true, aiTabId: 'ai-1', removed: signUp });

			await browserPicks({ remove: ' pick-1 ' });

			expect(sent[0].message).toEqual({
				type: 'design_pick_command',
				action: 'remove',
				sessionId: 'active-session',
				pickId: 'pick-1',
			});
			expect(printed(logSpy)).toEqual([
				'Removed Design Mode chip pick-1 (button.cta "Sign up") from the composer of tab ai-1',
			]);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('prints the removed chip as JSON', async () => {
			stubDesktop({ success: true, aiTabId: 'ai-1', removed: signUp });

			await browserPicks({ remove: 'pick-1', json: true });

			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: true,
				sessionId: 'active-session',
				aiTabId: 'ai-1',
				removed: signUp,
			});
		});

		it('refuses an empty chip id without calling the desktop', async () => {
			stubDesktop({ success: true });

			await browserPicks({ remove: '   ', json: true });

			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: false,
				error: '--remove needs a chip id (from browser-picks or browser-pick)',
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('reports a chip that is not there and exits 1', async () => {
			stubDesktop({
				success: false,
				aiTabId: 'ai-1',
				error: 'No Design Mode chip nope in the composer of tab ai-1',
			});

			await browserPicks({ remove: 'nope', json: true });

			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: false,
				error: 'No Design Mode chip nope in the composer of tab ai-1',
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('edit a note', () => {
		const edited = { ...signUp, note: 'Make it blue' };

		it('sends the chip id and the note, and reports the chip as it reads now', async () => {
			const sent = stubDesktop({ success: true, aiTabId: 'ai-1', edited });

			await browserPicks({ edit: ' pick-1 ', note: 'Make it blue' });

			expect(sent[0].message).toEqual({
				type: 'design_pick_command',
				action: 'note',
				sessionId: 'active-session',
				pickId: 'pick-1',
				note: 'Make it blue',
			});
			const out = printed(logSpy);
			expect(out[0]).toBe(
				'Updated the note on Design Mode chip pick-1 in the composer of tab ai-1'
			);
			expect(out[1]).toContain('Note: Make it blue');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('clears the note with an empty string, and prints JSON', async () => {
			const sent = stubDesktop({ success: true, aiTabId: 'ai-1', edited: signUp });

			await browserPicks({ edit: 'pick-1', note: '', json: true });

			expect(sent[0].message).toMatchObject({ action: 'note', note: '' });
			expect(JSON.parse(printed(logSpy)[0])).toEqual({
				success: true,
				sessionId: 'active-session',
				aiTabId: 'ai-1',
				edited: signUp,
			});
		});

		it.each([
			[{ edit: 'pick-1' }, '--edit needs --note <text> (an empty note clears it)'],
			[{ note: 'x' }, '--note needs --edit <pickId> to say which chip'],
			[{ edit: '  ', note: 'x' }, '--edit needs a chip id (from browser-picks or browser-pick)'],
			[{ edit: 'a', remove: 'b', note: 'x' }, 'Pass --remove or --edit, not both'],
		])('refuses %o without calling the desktop', async (options, error) => {
			stubDesktop({ success: true });

			await browserPicks({ ...options, json: true });

			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(JSON.parse(printed(logSpy)[0])).toEqual({ success: false, error });
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});

	it('refuses when no agent is named and none is recorded, without calling the desktop', async () => {
		stubDesktop({ success: true, picks: [] });
		vi.mocked(readActiveAgentId).mockReturnValueOnce(null);

		await browserPicks({});

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				'No active agent recorded. Pass --agent <id> to say whose composer you mean.'
			)
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('reports an agent --agent cannot resolve', async () => {
		stubDesktop({ success: true, picks: [] });
		vi.mocked(resolveAgentId).mockImplementationOnce(() => {
			throw new Error('Agent not found: ghost');
		});

		await browserPicks({ agent: 'ghost' });

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Agent not found: ghost'));
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('reports the app being unreachable', async () => {
		vi.mocked(withMaestroClient).mockRejectedValueOnce(new Error('Maestro is not running'));

		await browserPicks({ json: true });

		expect(JSON.parse(printed(logSpy)[0])).toEqual({
			success: false,
			error: 'Maestro is not running',
		});
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
