/**
 * Tests for the `maestro-cli steer-auto-run` verbs.
 *
 * What is worth pinning here is the CLI's own half, not the renderer's:
 *
 *  - A note that cannot be sent (empty, over the limit) fails BEFORE a round
 *    trip, and is never cut to fit.
 *  - `--background` reaches the wire only when asked, and `--focus` wins.
 *  - `cancel` resolves a unique id prefix against the pending list, so the far
 *    side is always handed a whole id.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

const mockSession = {
	id: 'agent-1',
	name: 'Alpha',
	toolType: 'claude-code',
	cwd: '/proj',
	projectRoot: '/proj',
};
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => {
		if (id === 'missing') throw new Error('Agent not found: missing');
		return 'agent-1';
	}),
	readActiveAgentId: vi.fn(() => 'agent-1'),
	getSessionById: vi.fn(() => mockSession),
	readSessions: vi.fn(() => [mockSession]),
	getSessionHistoryMtimeMs: vi.fn(() => 0),
}));

import {
	steerAutoRunCancel,
	steerAutoRunList,
	steerAutoRunSend,
} from '../../../cli/commands/steer-auto-run';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { MAX_STEERING_NOTE_LENGTH } from '../../../shared/autorunSteering';
import type {
	SteeringDeliverySummary,
	SteeringNoteSummary,
} from '../../../shared/autoRunSteeringCommands';

const PENDING: SteeringNoteSummary[] = [
	{ id: 'note-aaa111', text: 'use the v3 endpoint', timestamp: 1 },
	{ id: 'note-bbb222', text: 'skip the screenshots', timestamp: 2 },
];

const DELIVERIES: SteeringDeliverySummary[] = [
	{
		deliveryId: 'd1',
		notes: [{ id: 'note-old', text: 'stop after this doc', timestamp: 0 }],
		reply: {
			summary: '[steered] Halting after this document.',
			text: '[steered] Halting after this document.\n\nWrote the halt marker.',
			success: true,
			timestamp: 5,
		},
	},
];

/** Every message the command sent, in order. */
let sent: Array<Record<string, unknown>>;

function stubDesktop(
	options: {
		pending?: SteeringNoteSummary[];
		deliveries?: SteeringDeliverySummary[];
		steerable?: boolean;
		fail?: string;
	} = {}
): void {
	const pending = options.pending ?? PENDING;
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((msg: Record<string, unknown>) => {
				sent.push(msg);
				if (msg.action === 'list') {
					return {
						success: true,
						steerable: options.steerable ?? true,
						pending,
						deliveries: options.deliveries ?? DELIVERIES,
					};
				}
				if (options.fail) return { success: false, error: options.fail };
				if (msg.action === 'cancel') {
					return { success: true, note: pending.find((n) => n.id === msg.noteId) ?? PENDING[0] };
				}
				return { success: true, note: { id: 'note-new', text: msg.text, timestamp: 9 } };
			}),
		} as never)
	);
}

function printed(logSpy: MockInstance): string {
	return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('maestro-cli steer-auto-run', () => {
	let exitSpy: MockInstance;
	let logSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sent = [];
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		// The real `process.exit` never returns, and `failCommand` is typed
		// `never` on that promise, so the stand-in throws to keep the same flow.
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
		stubDesktop();
	});

	/** Run a command that is expected to bail out, swallowing the fake exit. */
	async function expectExit(run: Promise<void>): Promise<void> {
		await expect(run).rejects.toThrow('process.exit');
		expect(exitSpy).toHaveBeenCalledWith(1);
	}

	describe('send', () => {
		it('sends the trimmed note to the resolved agent', async () => {
			await steerAutoRunSend('  use the v3 endpoint \n', { agent: 'alpha', json: true });

			expect(sent).toEqual([
				{
					type: 'auto_run_steering_command',
					action: 'send',
					sessionId: 'agent-1',
					text: 'use the v3 endpoint',
					background: false,
				},
			]);
			expect(JSON.parse(printed(logSpy))).toMatchObject({
				success: true,
				sessionId: 'agent-1',
				note: { id: 'note-new' },
			});
		});

		it('refuses an empty note without talking to the desktop', async () => {
			await expectExit(steerAutoRunSend('   ', { agent: 'alpha', json: true }));
			expect(sent).toHaveLength(0);
		});

		// Cutting a note to fit would hand the agent an instruction nobody wrote.
		it('refuses an over-long note rather than trimming it', async () => {
			await expectExit(
				steerAutoRunSend('x'.repeat(MAX_STEERING_NOTE_LENGTH + 1), { agent: 'alpha', json: true })
			);
			expect(sent).toHaveLength(0);
		});

		it('fails on an unknown agent before sending anything', async () => {
			await expectExit(steerAutoRunSend('steer left', { agent: 'missing', json: true }));
			expect(sent).toHaveLength(0);
		});

		it('sends background only when asked, and lets --focus win', async () => {
			await steerAutoRunSend('a', { agent: 'alpha', json: true, background: true });
			await steerAutoRunSend('b', { agent: 'alpha', json: true, background: true, focus: true });

			expect(sent.map((m) => m.background)).toEqual([true, false]);
		});

		it('reports the desktop refusal, such as no run being active', async () => {
			stubDesktop({ fail: 'No Auto Run is active on this agent' });

			await expectExit(steerAutoRunSend('steer left', { agent: 'alpha', json: true }));
			expect(printed(logSpy)).toContain('No Auto Run is active on this agent');
		});
	});

	describe('list', () => {
		it('returns everything as JSON, full replies included', async () => {
			await steerAutoRunList({ agent: 'alpha', json: true });

			expect(JSON.parse(printed(logSpy))).toEqual({
				success: true,
				sessionId: 'agent-1',
				steerable: true,
				pending: PENDING,
				deliveries: DELIVERIES,
			});
		});

		it('shows each delivered note with its reply for a human', async () => {
			await steerAutoRunList({ agent: 'alpha' });

			const out = printed(logSpy);
			expect(out).toContain('note-aaa111');
			expect(out).toContain('stop after this doc');
			expect(out).toContain('reply: [steered] Halting after this document.');
		});

		it('says a task is still working while a run is in flight', async () => {
			stubDesktop({ deliveries: [{ deliveryId: 'd1', notes: [PENDING[0]] }] });
			await steerAutoRunList({ agent: 'alpha' });

			expect(printed(logSpy)).toContain('reply: still working');
		});

		// With no run in flight nothing is left to answer, so "still working"
		// would be a claim about a task that no longer exists.
		it('does not claim a task is working once the run is over', async () => {
			stubDesktop({ steerable: false, deliveries: [{ deliveryId: 'd1', notes: [PENDING[0]] }] });
			await steerAutoRunList({ agent: 'alpha' });

			const out = printed(logSpy);
			expect(out).toContain('No steerable Auto Run');
			expect(out).toContain('reply: the run ended before this task replied');
		});

		it('marks the reply of a task that failed', async () => {
			stubDesktop({
				deliveries: [
					{
						deliveryId: 'd1',
						notes: [PENDING[0]],
						reply: { summary: 'context limit reached', text: '', success: false, timestamp: 5 },
					},
				],
			});
			await steerAutoRunList({ agent: 'alpha' });

			expect(printed(logSpy)).toContain('reply: FAILED: context limit reached');
		});

		it('says so when there are no notes at all', async () => {
			stubDesktop({ pending: [], deliveries: [] });
			await steerAutoRunList({ agent: 'alpha' });

			expect(printed(logSpy)).toContain('No steering notes.');
		});
	});

	describe('cancel', () => {
		it('resolves a unique prefix to the whole id before cancelling', async () => {
			await steerAutoRunCancel('note-bbb', { agent: 'alpha', json: true });

			expect(sent.map((m) => m.action)).toEqual(['list', 'cancel']);
			expect(sent[1]).toMatchObject({ sessionId: 'agent-1', noteId: 'note-bbb222' });
		});

		it('refuses an ambiguous prefix rather than guessing', async () => {
			await expectExit(steerAutoRunCancel('note-', { agent: 'alpha', json: true }));
			expect(sent.map((m) => m.action)).toEqual(['list']);
		});

		// The desktop knows whether a task already took the note; this side does
		// not, so an unmatched id is passed through for it to explain.
		it('lets the desktop explain an id that is not pending', async () => {
			stubDesktop({
				fail: 'That steering note was already delivered to a task and cannot be taken back',
			});

			await expectExit(steerAutoRunCancel('note-old', { agent: 'alpha', json: true }));
			expect(sent[1]).toMatchObject({ action: 'cancel', noteId: 'note-old' });
			expect(printed(logSpy)).toContain('already delivered');
		});
	});
});
